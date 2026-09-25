import { beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, Transaction } from "@solana/web3.js";

/**
 * Submission-contract tests for the PRODUCTION wallet path
 * (submitTransferViaWallet):
 *
 *   wallet.sendTransaction(ourSimulatedTx, connection) → signature
 *   → persist the signature BEFORE polling
 *   → confirm THAT exact signature
 *   → strict receipt verification (verifyDelivery)
 *
 * Everything is stubbed: no wallet, no RPC, no broadcast.
 */

import {
  describeSubmitFailure,
  isWalletCancellation,
  submitTransferViaWallet,
  type SubmitFailure,
  type SubmittingWallet,
} from "./submitViaWallet";
import type { DeliveryVerification } from "./verify";

const payer = Keypair.generate();
const SIGNATURE = "5" + "x".repeat(86);

function makeTx(): Transaction {
  const tx = new Transaction();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return tx;
}

function okDelivery(): DeliveryVerification {
  return {
    signature: SIGNATURE,
    slot: 42,
    confirmationStatus: "confirmed",
    transactionSucceeded: true,
    mint: Keypair.generate().publicKey.toBase58(),
    recipientOwner: Keypair.generate().publicKey.toBase58(),
    destinationAta: Keypair.generate().publicKey.toBase58(),
    postBalanceBaseUnits: 1000n,
    preBalanceBaseUnits: 0n,
    actuallyReceived: 1000n,
    matchesRequested: true,
    blockTime: 1700000000,
    explorerUrl: `https://solscan.io/tx/${SIGNATURE}`,
  };
}

interface Harness {
  wallet: SubmittingWallet;
  sendTransaction: ReturnType<typeof vi.fn>;
  persistSignature: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  verifyReceipt: ReturnType<typeof vi.fn>;
  onStage: ReturnType<typeof vi.fn>;
  guard: { acquire(): boolean; consumed: boolean };
  args: () => Parameters<typeof submitTransferViaWallet>[0];
}

function harness(opts: {
  sendResult?: string | Error;
  confirmResult?: { ok: boolean; slot: number | null; error?: string };
  delivery?: DeliveryVerification | Error;
  verifyRejects?: boolean;
} = {}): Harness {
  const sendTransaction = vi.fn(async () => {
    if (opts.sendResult instanceof Error) throw opts.sendResult;
    return opts.sendResult ?? SIGNATURE;
  });
  const persistSignature = vi.fn();
  const confirm = vi.fn(async () => opts.confirmResult ?? { ok: true, slot: 42 });
  const verifyReceipt = vi.fn(async () => {
    if (opts.delivery instanceof Error) throw opts.delivery;
    if (opts.verifyRejects) throw new Error("boom from verifier");
    return opts.delivery ?? okDelivery();
  });
  const onStage = vi.fn();
  const guard = { consumed: false, acquire: () => (guard.consumed ? false : (guard.consumed = true)) };

  const wallet: SubmittingWallet = { sendTransaction } as unknown as SubmittingWallet;
  const connection = {} as Connection;
  const transaction = makeTx();

  const h: Harness = {
    wallet,
    sendTransaction,
    persistSignature,
    confirm,
    verifyReceipt,
    onStage,
    guard,
    args: () => ({
      wallet,
      connection,
      transaction,
      guard,
      persistSignature,
      confirm: confirm as unknown as Parameters<typeof submitTransferViaWallet>[0]["confirm"],
      verifyReceipt: verifyReceipt as unknown as Parameters<
        typeof submitTransferViaWallet
      >[0]["verifyReceipt"],
      onStage,
    }),
  };
  return h;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("submitTransferViaWallet (wallet-adapter sendTransaction contract)", () => {
  it("A. sendTransaction → signature persisted BEFORE confirm → receipt verified → outcome returned", async () => {
    const h = harness();
    const args = h.args();
    const outcome = await submitTransferViaWallet(args);

    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
    // The exact simulated transaction object is handed to the wallet.
    expect(h.sendTransaction.mock.calls[0][0]).toBe(args.transaction);
    expect(outcome.signature).toBe(SIGNATURE);
    expect(outcome.delivery.matchesRequested).toBe(true);

    // Persistence strictly precedes confirmation polling.
    expect(h.persistSignature).toHaveBeenCalledWith(SIGNATURE);
    expect(h.persistSignature.mock.invocationCallOrder[0]).toBeLessThan(
      h.confirm.mock.invocationCallOrder[0],
    );
    // Confirmation uses THAT exact signature.
    expect(h.confirm).toHaveBeenCalledWith(args.connection, SIGNATURE);
    // Receipt verification happens after confirmation.
    expect(h.verifyReceipt.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.confirm.mock.invocationCallOrder[0],
    );
    expect(h.verifyReceipt).toHaveBeenCalledWith({
      connection: args.connection,
      signature: SIGNATURE,
    });
    // Stage machine advanced submitted → verifying.
    expect(h.onStage).toHaveBeenNthCalledWith(1, "submitted");
    expect(h.onStage).toHaveBeenNthCalledWith(2, "verifying");
  });

  it("B. wallet cancellation → 'Wallet cancelled', NO persistence, NO confirmation, NO verification", async () => {
    const h = harness({ sendResult: new Error("User rejected the request.") });
    await expect(submitTransferViaWallet(h.args())).rejects.toMatchObject({
      kind: "cancelled",
      message: "Wallet cancelled",
    });
    expect(h.persistSignature).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.verifyReceipt).not.toHaveBeenCalled();
    // The submission attempt consumed the single-use guard.
    expect(h.guard.consumed).toBe(true);
  });

  it("C. sendTransaction provider error → wallet_error, no fake success, nothing persisted", async () => {
    const h = harness({ sendResult: new Error("wallet RPC exploded") });
    await expect(submitTransferViaWallet(h.args())).rejects.toMatchObject({
      kind: "wallet_error",
    });
    expect(h.persistSignature).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.verifyReceipt).not.toHaveBeenCalled();
  });

  it("C2. sendTransaction returning a non-signature → wallet_error before persistence", async () => {
    const h = harness({ sendResult: "" });
    await expect(submitTransferViaWallet(h.args())).rejects.toMatchObject({
      kind: "wallet_error",
      message: /did not return a transaction signature/,
    });
    expect(h.persistSignature).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("D. confirmation failure → confirmation_failed, receipt NEVER verified, no success", async () => {
    const h = harness({
      confirmResult: { ok: false, slot: null, error: "Timed out waiting for confirmation." },
    });
    await expect(submitTransferViaWallet(h.args())).rejects.toMatchObject({
      kind: "confirmation_failed",
      message: /Timed out/,
    });
    expect(h.persistSignature).toHaveBeenCalledWith(SIGNATURE); // persisted before polling
    expect(h.verifyReceipt).not.toHaveBeenCalled();
  });

  it("D2. on-chain failure surfacing through confirmation → confirmation_failed", async () => {
    const h = harness({
      confirmResult: { ok: false, slot: 99, error: 'Transaction failed on-chain: {"InstructionError":[0,0]}' },
    });
    await expect(submitTransferViaWallet(h.args())).rejects.toMatchObject({
      kind: "confirmation_failed",
    });
    expect(h.verifyReceipt).not.toHaveBeenCalled();
  });

  it("E. verifier reports mismatch (matchesRequested=false) → verification_failed, no success", async () => {
    const delivery = { ...okDelivery(), matchesRequested: false, actuallyReceived: 999n };
    const h = harness({ delivery });
    await expect(submitTransferViaWallet(h.args())).rejects.toMatchObject({
      kind: "verification_failed",
    });
  });

  it("E2. verifier throws → verification_failed (never a bare error)", async () => {
    const h = harness({ verifyRejects: true });
    await expect(submitTransferViaWallet(h.args())).rejects.toMatchObject({
      kind: "verification_failed",
      message: /boom from verifier/,
    });
  });

  it("duplicate submission with a consumed guard → rejected WITHOUT calling the wallet", async () => {
    const h = harness();
    await submitTransferViaWallet(h.args());
    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
    await expect(submitTransferViaWallet(h.args())).rejects.toMatchObject({
      kind: "wallet_error",
      message: /already submitted/,
    });
    expect(h.sendTransaction).toHaveBeenCalledTimes(1); // never re-entered
  });

  it("guard is consumed even when the wallet errors (session cannot silently re-send)", async () => {
    const h = harness({ sendResult: new Error("provider failure") });
    await expect(submitTransferViaWallet(h.args())).rejects.toMatchObject({ kind: "wallet_error" });
    await expect(submitTransferViaWallet(h.args())).rejects.toMatchObject({
      message: /already submitted/,
    });
    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("submit-failure semantics", () => {
  it("isWalletCancellation recognizes rejection phrasing, not generic errors", () => {
    expect(isWalletCancellation(new Error("User rejected the request."))).toBe(true);
    expect(isWalletCancellation(new Error("wallet request was denied"))).toBe(true);
    expect(isWalletCancellation(new Error("4001"))).toBe(true);
    expect(isWalletCancellation(new Error("Provider error: RPC failed"))).toBe(false);
  });

  it("describeSubmitFailure maps every kind to one friendly sentence", () => {
    expect(describeSubmitFailure("cancelled")).toBe("Wallet cancelled");
    expect(describeSubmitFailure("wallet_error")).toMatch(/Nothing was sent/);
    expect(describeSubmitFailure("confirmation_failed")).toMatch(/do not double-send/);
    expect(describeSubmitFailure("verification_failed")).toMatch(/does not match this transfer/);
  });

  it("failure messages never leak structural/mutation diagnostics", async () => {
    const h = harness({ sendResult: new Error("User rejected the request.") });
    let caught: SubmitFailure | null = null;
    try {
      await submitTransferViaWallet(h.args());
    } catch (e) {
      caught = e as SubmitFailure;
    }
    expect(caught?.message).not.toMatch(/mutation|allowlist|reallocate|proof|byte/i);
  });
});
