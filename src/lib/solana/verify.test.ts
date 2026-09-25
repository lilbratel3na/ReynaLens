import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * Strict receipt verification (sendTransaction architecture): verifyDelivery
 * must prove the EXACT confirmed transaction delivered the EXACT amount to
 * the EXACT destination account of the EXACT recipient for the EXACT mint.
 * Stubbing @solana/spl-token's getAccount and the Connection keeps this
 * offline — no RPC, no wallet, no transaction.
 */

const DEST = "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt";

const { TOKEN_2022_STR } = vi.hoisted(() => ({
  TOKEN_2022_STR: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
}));

vi.mock("@solana/spl-token", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  return {
    getAccount: vi.fn(),
    getAssociatedTokenAddressSync: vi.fn(() => new PublicKey(DEST)),
    TOKEN_2022_PROGRAM_ID: new PublicKey(TOKEN_2022_STR),
  };
});

import { getAccount } from "@solana/spl-token";
import { readBalanceOrZero, verifyDelivery, deriveRecipientAta } from "./verify";

const payer = Keypair.generate();
const recipientOwner = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const destinationAta = new PublicKey(DEST);
const SIGNATURE = "5" + "x".repeat(86);

/** A parsed transaction that IS our transfer: correct payer, touches dest. */
function parsedTx(overrides: {
  err?: unknown;
  feePayer?: PublicKey;
  includeDestinationAta?: boolean;
} = {}) {
  const feePayer = overrides.feePayer ?? payer.publicKey;
  const keys = [feePayer, mint, Keypair.generate().publicKey];
  if (overrides.includeDestinationAta !== false) keys.push(destinationAta);
  return {
    slot: 42,
    blockTime: 1700000000,
    meta: {
      err: overrides.err ?? null,
      fee: 5000,
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: {
      message: {
        accountKeys: keys.map((pubkey) => ({ pubkey, signer: false, writable: true })),
      },
    },
  };
}

function connectionStub(tx = parsedTx()) {
  return {
    getParsedTransaction: async () => tx,
    getSignatureStatuses: async () => ({
      value: [{ slot: 42, confirmationStatus: "confirmed", err: null }],
    }),
  } as never;
}

function baseArgs() {
  return {
    connection: connectionStub(),
    destinationAta,
    preBalanceLiveRead: 0n,
    requestedNet: 1000n, // 0.000001000 OPENAI
    requestedMint: mint,
    requestedRecipientOwner: recipientOwner,
    expectedFeePayer: payer.publicKey,
    signature: SIGNATURE,
  };
}

beforeEach(() => {
  vi.mocked(getAccount).mockReset();
  vi.mocked(getAccount).mockResolvedValue({
    amount: 1000n,
    mint,
    owner: recipientOwner,
  } as never);
});

describe("verifyDelivery (strict receipt: sendTransaction architecture)", () => {
  it("exact delivery → verified: exact ATA, mint, recipient, and 1000-base-unit delta", async () => {
    const proof = await verifyDelivery(baseArgs());
    expect(proof.transactionSucceeded).toBe(true);
    expect(proof.mint).toBe(mint.toBase58());
    expect(proof.recipientOwner).toBe(recipientOwner.toBase58());
    expect(proof.destinationAta).toBe(destinationAta.toBase58());
    expect(proof.actuallyReceived).toBe(1000n);
    expect(proof.matchesRequested).toBe(true);
  });

  it("delta = post − pre (pre=50, post=1050, requested=1000) → verified", async () => {
    vi.mocked(getAccount).mockResolvedValue({ amount: 1050n, mint, owner: recipientOwner } as never);
    const proof = await verifyDelivery({ ...baseArgs(), preBalanceLiveRead: 50n });
    expect(proof.actuallyReceived).toBe(1000n);
    expect(proof.matchesRequested).toBe(true);
  });

  it("wrong amount (delta 999 ≠ 1000) → matchesRequested false, not a success", async () => {
    vi.mocked(getAccount).mockResolvedValue({ amount: 999n, mint, owner: recipientOwner } as never);
    const proof = await verifyDelivery(baseArgs());
    expect(proof.matchesRequested).toBe(false);
  });

  it("wrong mint in the destination account → REJECTS (no fake success)", async () => {
    vi.mocked(getAccount).mockResolvedValue({
      amount: 1000n,
      mint: Keypair.generate().publicKey,
      owner: recipientOwner,
    } as never);
    await expect(verifyDelivery(baseArgs())).rejects.toThrow(/different mint/);
  });

  it("wrong recipient owner → REJECTS", async () => {
    vi.mocked(getAccount).mockResolvedValue({
      amount: 1000n,
      mint,
      owner: Keypair.generate().publicKey,
    } as never);
    await expect(verifyDelivery(baseArgs())).rejects.toThrow(/not owned by the intended recipient/);
  });

  it("destination ATA absent from the confirmed transaction → REJECTS", async () => {
    const conn = connectionStub(parsedTx({ includeDestinationAta: false }));
    await expect(verifyDelivery({ ...baseArgs(), connection: conn })).rejects.toThrow(
      /intended recipient token account/,
    );
  });

  it("different fee payer (not our wallet) → REJECTS", async () => {
    const conn = connectionStub(parsedTx({ feePayer: Keypair.generate().publicKey }));
    await expect(verifyDelivery({ ...baseArgs(), connection: conn })).rejects.toThrow(
      /not sent by this wallet/,
    );
  });

  it("on-chain failure (meta.err) → REJECTS", async () => {
    const conn = connectionStub(parsedTx({ err: { InstructionError: [0, 0] } }));
    await expect(verifyDelivery({ ...baseArgs(), connection: conn })).rejects.toThrow(
      /failed on chain/,
    );
  });

  it("transaction not found on chain → REJECTS (receipt unverified)", async () => {
    const conn = { getParsedTransaction: async () => null } as never;
    await expect(verifyDelivery({ ...baseArgs(), connection: conn })).rejects.toThrow(
      /could not be read on chain/,
    );
  });

  it("readBalanceOrZero falls back to 0 when the destination account does not exist", async () => {
    vi.mocked(getAccount).mockRejectedValue(new Error("AccountNotFound"));
    const pre = await readBalanceOrZero(connectionStub(), destinationAta);
    expect(pre).toBe(0n);
  });

  it("deriveRecipientAta derives the Token-2022 ATA", () => {
    const ata = deriveRecipientAta(recipientOwner, mint);
    expect(ata.toBase58()).toBe(DEST);
  });
});
