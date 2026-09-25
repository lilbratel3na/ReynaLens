/**
 * PRODUCTION SUBMISSION PATH (sendTransaction architecture).
 *
 * ReynaLens never signs locally, never normalizes or inspects a wallet-
 * returned transaction, and never broadcasts itself. The wallet adapter's
 * normal send-and-confirm API is the single submission mechanism:
 *
 *   walletAdapter.sendTransaction(builtTransaction, connection) → signature
 *   → persist the signature immediately
 *   → confirm THAT exact signature
 *   → verify the actual on-chain receipt strictly
 *
 * The transaction handed to the wallet is the exact object that was built and
 * simulated. Anything the wallet's own send path does internally (signing,
 * re-pinning the blockhash, broadcasting) is the wallet's supported behavior —
 * it is not intercepted, inspected, or second-guessed here.
 */

import type { Connection, Transaction, TransactionSignature } from "@solana/web3.js";
import { submitDiag } from "./submitDiagnostics";

/** Maps wallet/provider errors onto user-facing failure kinds. */
export type SubmitFailureKind =
  | "cancelled" // user rejected / dismissed the wallet prompt
  | "wallet_error" // provider, signing, or submission error
  | "confirmation_failed" // on-chain failure or timeout
  | "verification_failed"; // receipt does not match the request

export interface SubmitFailure extends Error {
  kind: SubmitFailureKind;
}

export function makeSubmitFailure(kind: SubmitFailureKind, message: string): SubmitFailure {
  const e = new Error(message) as SubmitFailure;
  e.kind = kind;
  return e;
}

/** True when the wallet/provider error is a user cancellation. */
export function isWalletCancellation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /reject|denied|declined|dismissed|cancel|close|abort|4001/i.test(msg);
}

/** One friendly sentence per failure kind. Never exposes internals. */
export function describeSubmitFailure(kind: SubmitFailureKind): string {
  switch (kind) {
    case "cancelled":
      return "Wallet cancelled";
    case "wallet_error":
      return "The wallet could not complete the transaction. Nothing was sent.";
    case "confirmation_failed":
      return "The transaction did not confirm. Check the explorer before retrying — do not double-send.";
    case "verification_failed":
      return "The on-chain result does not match this transfer. Review the receipt before acting.";
  }
}

/** Minimal shape of the wallet adapter used for submission. */
export interface SubmittingWallet {
  sendTransaction(
    transaction: Transaction,
    connection: Connection,
    options?: Record<string, unknown>,
  ): Promise<TransactionSignature>;
}

export interface SubmitOutcome {
  signature: string;
  /** Slot of the confirmed transaction, when known. */
  slot: number | null;
  /** Verified receipt. */
  delivery: import("./verify").DeliveryVerification;
}

/**
 * The ONE production submission flow. Order is fixed:
 *  1. single-use guard acquired — a second call can never submit
 *  2. wallet.sendTransaction(ourSimulatedTransaction, connection)
 *  3. signature persisted BEFORE any polling (remount recovery)
 *  4. confirm that exact signature
 *  5. strict receipt verification against the requested delivery
 * Any failure rejects with a typed SubmitFailure and never leaves a half-
 * submitted state: once the guard is consumed, this session cannot re-send.
 */
export async function submitTransferViaWallet(args: {
  wallet: SubmittingWallet;
  connection: Connection;
  transaction: Transaction;
  guard: { acquire(): boolean; consumed?: boolean };
  persistSignature: (signature: string) => void;
  confirm: (
    connection: Connection,
    signature: string,
  ) => Promise<{ ok: boolean; slot: number | null; error?: string }>;
  verifyReceipt: (args: {
    connection: Connection;
    signature: string;
  }) => Promise<import("./verify").DeliveryVerification>;
  /** Optional progress hook so the UI phase machine stays accurate. */
  onStage?: (stage: "submitted" | "verifying") => void;
}): Promise<SubmitOutcome> {
  const { wallet, connection, transaction, guard, persistSignature, confirm, verifyReceipt, onStage } = args;

  // TEMPORARY diagnostic: submit start (before the guard is consumed).
  submitDiag("submit:start", { guardConsumed: guard.consumed ?? false });

  // 1. Single-use duplicate-submission guard.
  if (!guard.acquire()) {
    throw makeSubmitFailure(
      "wallet_error",
      "A transaction from this session was already submitted. Start a new transfer to try again.",
    );
  }

  // 2. The wallet's normal send API with OUR simulated transaction.
  let signature: string;
  try {
    submitDiag("sendTransaction:called", {
      txIsLegacy: (transaction as { version?: unknown }).version === undefined,
      feePayerSet: !!transaction.feePayer,
      recentBlockhashSet: !!transaction.recentBlockhash,
      instructionCount: transaction.instructions.length,
    });
    signature = await wallet.sendTransaction(transaction, connection);
    submitDiag("sendTransaction:resolved", { signature });
  } catch (e) {
    submitDiag("sendTransaction:rejected", {
      name: e instanceof Error ? e.name : null,
      message: e instanceof Error ? e.message : String(e),
    });
    if (isWalletCancellation(e)) {
      throw makeSubmitFailure("cancelled", describeSubmitFailure("cancelled"));
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw makeSubmitFailure("wallet_error", `The wallet could not complete the transaction. ${msg}`);
  }
  if (typeof signature !== "string" || signature.length === 0) {
    submitDiag("sendTransaction:empty-signature");
    throw makeSubmitFailure("wallet_error", "The wallet did not return a transaction signature.");
  }

  // 3. Persist BEFORE polling: a crash or remount continues confirming THIS
  // signature and never submits again.
  persistSignature(signature);
  onStage?.("submitted");
  submitDiag("submit:persisted", { signature });

  try {
    // 4. Confirm THAT exact signature.
    const confirmation = await confirm(connection, signature);
    if (!confirmation.ok) {
      submitDiag("confirm:failed", { error: confirmation.error ?? null });
      throw makeSubmitFailure(
        "confirmation_failed",
        confirmation.error ?? describeSubmitFailure("confirmation_failed"),
      );
    }

    // 5. Verify the actual on-chain receipt strictly (the verifier decides what
    // "matches" means; no fake success merely because confirmation returned).
    onStage?.("verifying");
    try {
      const delivery = await verifyReceipt({ connection, signature });
      if (!delivery.matchesRequested) {
        submitDiag("receipt:mismatch", {
          actuallyReceived: delivery.actuallyReceived?.toString() ?? null,
        });
        throw makeSubmitFailure("verification_failed", describeSubmitFailure("verification_failed"));
      }
      submitDiag("receipt:verified", { signature });
      return { signature, slot: confirmation.slot, delivery };
    } catch (e) {
      if ((e as Partial<SubmitFailure>).kind === "verification_failed") throw e;
      submitDiag("receipt:verify-threw", {
        name: e instanceof Error ? e.name : null,
        message: e instanceof Error ? e.message : null,
      });
      throw makeSubmitFailure(
        "verification_failed",
        e instanceof Error ? e.message : describeSubmitFailure("verification_failed"),
      );
    }
  } catch (e) {
    // TEMPORARY diagnostic: the submit-pipeline terminal error (already typed).
    submitDiag("submit:caught", {
      kind: (e as Partial<SubmitFailure>).kind ?? null,
      message: e instanceof Error ? e.message : null,
    });
    throw e;
  } finally {
    submitDiag("submit:finally");
  }
}
