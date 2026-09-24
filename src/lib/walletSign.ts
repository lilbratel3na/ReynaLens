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
import {
  Transaction,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";

/**
 * Same constant as web3.js's `VersionedMessage.deserializeMessageVersion` uses
 * (installed source: src/transaction/constants.ts). Imported from the deep
 * path where resolvable; duplicated here as a stable fallback so the wire-rule
 * stays a single, documented value.
 */
const VERSION_PREFIX_MASK = 0x7f;

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

/**
 * TEMPORARY P0 DIAGNOSTIC (attempt #4) — safe structural metadata ONLY.
 *
 * Real-device attempts #2 and #3 both resolved without rejection yet failed
 * our proof, so the actual runtime return shape is still unknown. This
 * classifier captures non-sensitive structure (types, constructor name,
 * presence of serialize/signature/signatures/signedTransaction, array-ness,
 * signature count, byte LENGTH of binary payloads, whitelisted own-key
 * NAMES) and never: key material, message bytes, transaction contents, or
 * any serialized payload. It runs BEFORE normalization and BEFORE the proof,
 * and never alters validation, the guard, or the broadcast path.
 */
export interface WalletReturnDiagnostic {
  typeofValue: string;
  constructorName: string | null;
  isArray: boolean;
  isUint8Array: boolean;
  isArrayBuffer: boolean;
  hasSerialize: boolean;
  hasSignatureProp: boolean;
  /** null = prop absent; true = signature === null; false = non-null. */
  signatureIsNull: boolean | null;
  hasSignaturesProp: boolean;
  signaturesIsArray: boolean;
  signaturesLength: number | null;
  hasSignedTransaction: boolean;
  /** Binary payloads only — length, never content. */
  byteLength: number | null;
  /** Own property NAMES filtered to this safe structural whitelist. */
  safeOwnKeys: string[];
}

/** Only these own-key NAMES may be reported — never values. */
const SAFE_OWN_KEYS = new Set([
  "signature",
  "signatures",
  "signedTransaction",
  "transaction",
  "rawTransaction",
  "serialize",
  "version",
  "message",
  "publicKey",
  "type",
  "byteLength",
  "length",
]);

export function classifyWalletReturn(value: unknown): WalletReturnDiagnostic {
  const d: WalletReturnDiagnostic = {
    typeofValue: typeof value,
    constructorName: null,
    isArray: false,
    isUint8Array: false,
    isArrayBuffer: false,
    hasSerialize: false,
    hasSignatureProp: false,
    signatureIsNull: null,
    hasSignaturesProp: false,
    signaturesIsArray: false,
    signaturesLength: null,
    hasSignedTransaction: false,
    byteLength: null,
    safeOwnKeys: [],
  };
  if (value === null || value === undefined) return d;
  d.constructorName =
    (value as { constructor?: { name?: string } }).constructor?.name ?? null;
  if (typeof value !== "object") return d; // primitives: type info only
  const obj = value as Record<string, unknown>;
  d.isArray = Array.isArray(value);
  d.isUint8Array = value instanceof Uint8Array;
  d.isArrayBuffer = value instanceof ArrayBuffer;
  if (value instanceof Uint8Array) d.byteLength = value.byteLength;
  else if (value instanceof ArrayBuffer) d.byteLength = value.byteLength;
  d.hasSerialize = typeof obj.serialize === "function";
  d.hasSignatureProp = "signature" in obj;
  if (d.hasSignatureProp) d.signatureIsNull = obj.signature === null;
  d.hasSignaturesProp = "signatures" in obj;
  d.signaturesIsArray = Array.isArray(obj.signatures);
  if (d.signaturesIsArray) d.signaturesLength = (obj.signatures as unknown[]).length;
  d.hasSignedTransaction = "signedTransaction" in obj;
  d.safeOwnKeys = Object.getOwnPropertyNames(obj)
    .filter((k) => SAFE_OWN_KEYS.has(k))
    .slice(0, 12);
  return d;
}

/** One-line, value-free structural summary for the UI failure message. */
export function formatWalletReturnDiagnostic(d: WalletReturnDiagnostic): string {
  const parts = [
    `type=${d.typeofValue}`,
    `constructor=${d.constructorName ?? "n/a"}`,
    `array=${d.isArray}`,
    `uint8=${d.isUint8Array}`,
    `arrayBuffer=${d.isArrayBuffer}`,
    `serialize=${d.hasSerialize}`,
    `signature=${d.hasSignatureProp ? (d.signatureIsNull ? "null" : "present") : "absent"}`,
    `signatures=${d.hasSignaturesProp ? (d.signaturesIsArray ? `array(${d.signaturesLength})` : "non-array") : "absent"}`,
    `signedTransaction=${d.hasSignedTransaction}`,
  ];
  if (d.byteLength !== null) parts.push(`byteLength=${d.byteLength}`);
  if (d.safeOwnKeys.length > 0) parts.push(`keys=[${d.safeOwnKeys.join(",")}]`);
  return parts.join(" ");
}

/** TEMPORARY: the latest attempt's safe structural diagnostic (module-scoped so
 * describeSignFailure — called by the UI with only the reason — can append it).
 * Single-user app; signing attempts are strictly sequential. */
let lastWalletReturnDiagnostic: string | null = null;

/** TEMPORARY: clears the captured diagnostic (used by tests). */
export function resetWalletReturnDiagnostic(): void {
  lastWalletReturnDiagnostic = null;
}

/** TEMPORARY: the captured diagnostic for the latest signing attempt, if any. */
export function getLastWalletReturnDiagnostic(): string | null {
  return lastWalletReturnDiagnostic;
}

/** Readable text for each typed failure, safe to render in the UI. */
export function describeSignFailure(reason: SignFailureReason): string {
  const base = (() => {
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
  })();
  // TEMPORARY (attempt #4): append THIS attempt's safe structural diagnostic so
  // the real return shape becomes observable on device.
  const diag = lastWalletReturnDiagnostic;
  return diag ? `${base} Wallet return diagnostic: ${diag}` : base;
}

export type SignableTransaction = Transaction;

/**
 * Normalize ANY value the installed wallet path may resolve with BEFORE the
 * existing proof runs. Grounded in the installed web3.js 1.99.0 sources:
 *
 * - Legacy `Transaction` object → returned unchanged (case A).
 * - `VersionedTransaction` object → passed through (has signatures + message,
 *   no `verifySignatures` — the proof's crypto step is skipped for it exactly
 *   as `SignedLike` already permits).
 * - Serialized transaction BYTES (`Uint8Array`/`Buffer`/`ArrayBuffer`) → the
 *   transaction wire format (both classes) is: shortvec signature count, N×64
 *   signature bytes, then the message whose first byte carries the version
 *   flag. Version discrimination applies the exact installed rule from
 *   `VersionedMessage.deserializeMessageVersion` (`src/message/versioned.ts`)
 *   to that MESSAGE byte: legacy iff `prefix & VERSION_PREFIX_MASK === prefix`.
 *   For legacy bytes we require a single fee-payer signature (matching the
 *   transaction ReynaLens builds) and use `Transaction.from(bytes)`; anything
 *   else goes through `VersionedTransaction.deserialize(bytes)`, which itself
 *   throws on versions other than 0/1. We never parse manually and never
 *   guess from object properties — only the installed constructors run.
 * - Envelope `{ signedTransaction: unknown }` (the only observed wallet-
 *   standard field name) → unwrap and normalize recursively (case C).
 * - falsy → null (preserves the existing no_signature_returned failure).
 *
 * Malformed bytes throw inside the installed constructors; the caller maps
 * every throw to the existing typed failure. Nothing here weakens the proof:
 * every normalized value still goes through proveSignedTransaction()
 * unchanged.
 */
export function normalizeSignedTransactionReturn(value: unknown): NormalizedSigned | null {
  return normalizeSigned(value, 0);
}

function normalizeSigned(value: unknown, depth: number): NormalizedSigned | null {
  // Envelope recursion is bounded: the only legal nesting is one unwrap.
  if (depth > 2) {
    throw new Error("Wallet returned an unrecognized signed-transaction shape.");
  }
  // D) falsy → existing no_signature_returned failure.
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return null;
  }
  // A) Legacy Transaction object — unchanged (also matches our own simulated tx type).
  if (value instanceof Transaction) return { kind: "legacy", tx: value };
  // VersionedTransaction object (no verifySignatures in web3.js 1.99.0).
  if (value instanceof VersionedTransaction) return { kind: "versioned", tx: value };
  // B) Serialized bytes (Uint8Array / Buffer / ArrayBuffer).
  const bytes = toBytes(value);
  if (bytes) {
    // Transaction WIRE format (both classes, installed sources): shortvec
    // signature count, then N×64 signature bytes, then the MESSAGE — whose
    // first byte carries the version flag. Version discrimination therefore
    // applies the installed `deserializeMessageVersion` rule to the first
    // MESSAGE byte: legacy iff (prefix & VERSION_PREFIX_MASK) === prefix.
    // ReynaLens always builds single-signature transactions, so the count is
    // the single byte 0x01 and the message starts at offset 65.
    const sigCount = bytes[0] & VERSION_PREFIX_MASK;
    const msgPrefix = bytes[1 + sigCount * 64];
    const isLegacy = msgPrefix !== undefined && (msgPrefix & VERSION_PREFIX_MASK) === msgPrefix;
    if (isLegacy) {
      if (sigCount !== 1) {
        throw new Error(`Unexpected signature count ${sigCount} in signed transaction bytes.`);
      }
      return { kind: "legacy", tx: Transaction.from(bytes) };
    }
    // Versioned wire — the installed deserializer handles versions 0/1 and
    // throws on anything else (fail-closed on malformed bytes).
    return { kind: "versioned", tx: VersionedTransaction.deserialize(bytes) };
  }
  // A') Structural Transaction-like object (the existing SignedLike contract
  // of proveSignedTransaction — e.g. adapter wrappers that hand back a
  // transaction-shaped object). Accepted because the FULL existing proof
  // (signature presence + message-byte equality + verifySignatures when
  // offered) still runs on it unchanged.
  if (
    typeof value === "object" &&
    typeof (value as SignedLike).serialize === "function" &&
    ("signature" in (value as Record<string, unknown>) ||
      "signatures" in (value as Record<string, unknown>))
  ) {
    return { kind: "legacy", tx: value as unknown as Transaction };
  }
  // C) Envelope object: unwrap ONLY the known signed-transaction field, then
  // normalize recursively (A/B). No speculative provider behavior.
  if (typeof value === "object" && "signedTransaction" in (value as Record<string, unknown>)) {
    return normalizeSigned(
      (value as { signedTransaction?: unknown }).signedTransaction,
      depth + 1,
    );
  }
  throw new Error("Wallet returned an unrecognized signed-transaction shape.");
}

/** Result of normalizing the wallet's returned value. */
export type NormalizedSigned =
  | { kind: "legacy"; tx: Transaction }
  | { kind: "versioned"; tx: VersionedTransaction };

/** Accept only genuine binary payloads; anything else is not transaction bytes. */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

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
): Promise<Transaction | VersionedTransaction> {
  if (!wallet.publicKey) {
    throw makeSignFailure("signer_unavailable", "Wallet is not connected.");
  }
  if (typeof wallet.signTransaction !== "function") {
    throw makeSignFailure(
      "signer_unavailable",
      "This wallet does not expose a supported signing method. Nothing was signed.",
    );
  }
  // Each attempt starts clean: a later unrelated failure must never display a
  // stale diagnostic from a previous attempt.
  lastWalletReturnDiagnostic = null;
  let returned: unknown;
  try {
    returned = await wallet.signTransaction(transaction);
  } catch (e) {
    // The wallet call itself failed — there is no return value to diagnose.
    if (isRejectedSignatureError(e)) {
      throw makeSignFailure(
        "rejected",
        "The signature request was rejected or dismissed in your wallet.",
      );
    }
    throw makeSignFailure("bridge_failure", e instanceof Error ? e.message : String(e));
  }
  // The wallet RESOLVED. From here, any unusable value is classified as
  // no_signature_returned (it returned something — just nothing we can prove).
  // TEMPORARY P0 diagnostic (attempt #4): capture safe structural metadata
  // BEFORE normalization and BEFORE the proof. Never logs keys, message
  // bytes, or serialized content — only shapes, counts, and byte LENGTHS.
  const diagnostic = formatWalletReturnDiagnostic(classifyWalletReturn(returned));
  lastWalletReturnDiagnostic = diagnostic; // for describeSignFailure in the UI
  try {
    // Normalize the wallet's return shape (bytes / envelope / Transaction)
    // BEFORE proving. Grounded in the installed adapter: it delegates the
    // return value verbatim, and the injected provider does not return a
    // legacy Transaction object — this was the exact cause of the real-device
    // "did not return a valid signed transaction" failure.
    const normalized = normalizeSignedTransactionReturn(returned);
    if (!normalized) {
      throw makeSignFailure(
        "no_signature_returned",
        `The wallet did not return a signed transaction. Nothing was signed or submitted. Wallet return diagnostic: ${diagnostic}`,
      );
    }
    if (!proveSignedTransaction(normalized.tx, expectedMessageBytes)) {
      throw makeSignFailure(
        "no_signature_returned",
        `The wallet did not return a valid signature for the exact transaction that was simulated. Nothing was signed or submitted. Wallet return diagnostic: ${diagnostic}`,
      );
    }
    // Proven. The diagnostic served its purpose; a later failure in THIS
    // attempt (e.g. broadcast_failed) must not display a signing-shape note.
    lastWalletReturnDiagnostic = null;
    return normalized.tx;
  } catch (e) {
    if (e instanceof Error && (e as SignFailure).reason) throw e; // already typed
    // Normalization/parse failure of the resolved value.
    throw makeSignFailure(
      "no_signature_returned",
      `${e instanceof Error ? e.message : String(e)} Wallet return diagnostic: ${diagnostic}`,
    );
  }
}
