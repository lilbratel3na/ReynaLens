/**
 * Wallet signing orchestration — sign-first, broadcast-exactly-once.
 *
 * P0 root cause addressed (diagnosed read-only): the injected Phantom Android
 * bridge returns no signature after the user confirms when the transaction is
 * handed to the wallet for combined sign-AND-broadcast (`signAndSendTransaction`).
 * The transaction never reached Solana, so the reliable, supported signing path
 * on mobile is the wallet's separate `signTransaction` (desktop: the adapter's
 * signTransaction; mobile: the injected Phantom provider's signTransaction).
 * ReynaLens then owns the single broadcast.
 *
 * Guarantees:
 * - The wallet is asked to SIGN only. Signing never moves funds.
 * - The wallet's returned transaction is PROVEN (fee-payer signature present,
 *   message bytes unchanged, ed25519 verified when offered) before anything
 *   is broadcast.
 * - Broadcast happens at most ONCE per submission guard — never from a
 *   remount, a duplicate callback, or a visibility event.
 * - If no usable signed transaction is returned, NOTHING is submitted and the
 *   real error is surfaced via a typed taxonomy.
 */
import { Transaction, type Connection } from "@solana/web3.js";

/** Typed failure reasons, preserved through to the UI's error mapping. */
export type SignFailureReason =
  /** User actively rejected/cancelled the signature request. */
  | "rejected"
  /** Wallet returned nothing usable, or a transaction that was unsigned or modified. */
  | "no_signature_returned"
  /** Wallet bridge/signing failed before returning anything. */
  | "bridge_failure"
  /** Adapter/wallet exposes no supported signing method. */
  | "signer_unavailable"
  /** Transaction's blockhash expired before broadcast. */
  | "blockhash_expired"
  /** RPC rejected the broadcast. */
  | "broadcast_failed";

export interface SignFailure extends Error {
  reason: SignFailureReason;
}

export function makeSignFailure(reason: SignFailureReason, message: string): SignFailure {
  const err = new Error(message) as SignFailure;
  err.reason = reason;
  return err;
}

export function isRejectedSignatureError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = `${(e as SignFailure).reason ?? ""} ${e.message}`;
  return /rejected|denied|declined|dismissed|cancelled|canceled|user (refused|did not approve)/i.test(
    m,
  );
}

/**
 * Single-use submission guard: exactly one broadcast may ever begin per
 * guard — an atomic test-and-set. Remounts, duplicate callbacks and visibility
 * events cannot re-enter; a NEW submission requires a fresh guard created
 * after new, explicit user action.
 */
export function createSubmissionGuard() {
  let consumed = false;
  return {
    acquire(): boolean {
      if (consumed) return false;
      consumed = true;
      return true;
    },
    get consumed(): boolean {
      return consumed;
    },
  };
}

/** Minimal structural type for a wallet-signed transaction. */
export interface SignedLike {
  signature?: Uint8Array | null;
  /** web3.js Transaction uses SignaturePubkeyPair[]; mocks use raw bytes. */
  signatures?: Array<Uint8Array | { signature?: Uint8Array | null }>;
  serializeMessage?: () => Uint8Array;
  serialize: () => Uint8Array;
  verifySignatures?: () => boolean;
}

/**
 * PROOF the wallet actually signed before anything is broadcast:
 * 1. a non-empty fee-payer signature exists on the returned transaction,
 * 2. its message bytes equal the exact message that was simulated/built,
 * 3. ed25519 verification passes when the wallet provides it.
 * Returns true only for a genuine, unmodified signature.
 */
export function proveSignedTransaction(
  tx: SignedLike,
  expectedMessageBytes: Uint8Array,
): boolean {
  if (!tx || typeof tx.serialize !== "function") return false;
  // Standard Transaction: `signature` is the FIRST signature (fee payer).
  const first = Array.isArray(tx.signatures) && tx.signatures.length > 0 ? tx.signatures[0] : undefined;
  const sig: Uint8Array | null | undefined =
    tx.signature ?? (first instanceof Uint8Array ? first : (first?.signature ?? null));
  if (!sig || sig.length === 0) return false;
  if (sig.every((b) => b === 0)) return false;
  if (typeof tx.serializeMessage === "function") {
    const msg = tx.serializeMessage();
    if (msg.length !== expectedMessageBytes.length) return false;
    for (let i = 0; i < msg.length; i++) {
      if (msg[i] !== expectedMessageBytes[i]) return false;
    }
  }
  if (typeof tx.verifySignatures === "function") {
    try {
      if (!tx.verifySignatures()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Broadcast exactly once, on OUR connection, with the wallet's signed bytes. */
export async function broadcastSignedTransaction(
  connection: Connection,
  signedTx: SignedLike,
): Promise<string> {
  const raw = signedTx.serialize();
  return connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
}

/** Readable text for each typed failure, safe to render in the UI. */
export function describeSignFailure(reason: SignFailureReason): string {
  switch (reason) {
    case "rejected":
      return "The signature request was rejected or dismissed in your wallet. Nothing was signed or submitted.";
    case "no_signature_returned":
      return "Your wallet did not return a valid signed transaction. Nothing was signed or submitted.";
    case "bridge_failure":
      return "Your wallet closed the signing request without returning a signature. Nothing was signed or submitted.";
    case "signer_unavailable":
      return "The connected wallet does not expose a supported signing method for this transaction. Nothing was signed or submitted.";
    case "blockhash_expired":
      return "The transaction's blockhash expired before it could be submitted. Nothing was signed or submitted — retrying builds a fresh transaction.";
    case "broadcast_failed":
      return "The network rejected the transaction submission.";
  }
}

export type SignableTransaction = Transaction;

/**
 * Pick the signing wallet to use. Desktop: the adapter's signTransaction.
 * Mobile: the injected Phantom provider's signTransaction when present (the
 * adapter resolves to it on mobile anyway, but reading the injected provider
 * first avoids any adapter-layer wrapper that could swallow the response).
 * Returns a typed signer_unavailable failure when neither exists.
 */
export function extractSigningWalletSource(
  injected: { signTransaction?: unknown } | undefined | null,
  adapter: { signTransaction?: unknown } | undefined | null,
): { source: "injected" | "adapter" } | { source: "none"; reason: SignFailureReason } {
  if (injected && typeof injected.signTransaction === "function") {
    return { source: "injected" };
  }
  if (adapter && typeof adapter.signTransaction === "function") {
    return { source: "adapter" };
  }
  return { source: "none", reason: "signer_unavailable" };
}

/**
 * Ask the wallet to SIGN (never send) and return the proven signed transaction.
 * - Desktop/extension wallets: the adapter's `signTransaction` (unchanged path).
 * - Phantom mobile: the injected provider's `signTransaction` (supported;
 *   returns the signed transaction — Phantom does NOT broadcast here, so a
 *   returned signature can only exist if the wallet genuinely signed).
 * Throws a typed SignFailure; a user rejection maps to reason "rejected".
 */
export async function signWithWallet(
  transaction: Transaction,
  wallet: {
    publicKey: { toBase58(): string } | null;
    signTransaction?: (tx: Transaction) => Promise<Transaction>;
  },
  expectedMessageBytes: Uint8Array,
): Promise<Transaction> {
  if (!wallet.publicKey) {
    throw makeSignFailure("signer_unavailable", "Wallet is not connected.");
  }
  if (typeof wallet.signTransaction !== "function") {
    throw makeSignFailure(
      "signer_unavailable",
      "This wallet does not expose a supported signing method. Nothing was signed.",
    );
  }
  try {
    const signed = await wallet.signTransaction(transaction);
    if (!proveSignedTransaction(signed, expectedMessageBytes)) {
      throw makeSignFailure(
        "no_signature_returned",
        "The wallet did not return a valid signature for the exact transaction that was simulated. Nothing was signed or submitted.",
      );
    }
    return signed;
  } catch (e) {
    if (e instanceof Error && (e as SignFailure).reason) throw e; // already typed
    if (isRejectedSignatureError(e)) {
      throw makeSignFailure(
        "rejected",
        "The signature request was rejected or dismissed in your wallet.",
      );
    }
    throw makeSignFailure("bridge_failure", e instanceof Error ? e.message : String(e));
  }
}
