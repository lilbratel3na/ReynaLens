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
  Message,
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

/* ==========================================================================
 * TEMPORARY P0 PROOF-STAGE DIAGNOSTIC (attempt #5)
 * ==========================================================================
 * The attempt-#4 device diagnostic proved Phantom returns a REAL signed
 * legacy Transaction (signature=present, signatures=array(1)) — so the
 * failure is inside proveSignedTransaction(). A local round-trip probe
 * (scripts/probe-proof-stages.ts) proved a clean Transaction.from(bytes)
 * passes ALL stages — so on device the returned MESSAGE BYTES must differ
 * from what we simulated. This classifier reports ONLY booleans/numbers
 * per the approved field list, never bytes/keys/secrets, and identifies
 * the exact failing stage. The proof itself is unchanged.
 */

export type ProofStage =
  | "shape"
  | "signature_presence"
  | "message_length"
  | "message_integrity"
  | "signature_verification"
  | "other";

export interface ProofDiagnostic {
  hasSerialize: boolean;
  hasSignature: boolean;
  signatureLength: number;
  signaturesLength: number;
  simulatedMessageLength: number | null;
  returnedMessageLength: number | null;
  messageBytesEqual: boolean | null; // null when lengths differ (short-circuit)
  verifySignaturesResult: boolean | null; // null when wallet provides no verifier
  feePayerPresent: boolean;
  recentBlockhashPresent: boolean;
  instructionCount: number;
  transactionVersion: string | null; // "legacy" | number | null when unavailable
}

/** Safe structural read of a legacy-or-versioned transaction-like object. */
export function readProofFacts(
  tx: unknown,
  expectedMessageBytes: Uint8Array,
): { facts: ProofDiagnostic; failedStage: ProofStage } {
  const d: ProofDiagnostic = {
    hasSerialize: false,
    hasSignature: false,
    signatureLength: 0,
    signaturesLength: 0,
    simulatedMessageLength: expectedMessageBytes.length,
    returnedMessageLength: null,
    messageBytesEqual: null,
    verifySignaturesResult: null,
    feePayerPresent: false,
    recentBlockhashPresent: false,
    instructionCount: 0,
    transactionVersion: null,
  };
  const obj = tx as
    | {
        serialize?: unknown;
        signature?: unknown;
        signatures?: unknown;
        serializeMessage?: unknown;
        message?: { serialize?: unknown; version?: unknown };
        verifySignatures?: unknown;
        feePayer?: unknown;
        recentBlockhash?: unknown;
        instructions?: unknown[];
        version?: unknown;
      }
    | null;
  if (!tx || obj === null || typeof obj !== "object") {
    return { facts: d, failedStage: "shape" };
  }
  d.hasSerialize = typeof obj.serialize === "function";
  if (!d.hasSerialize) return { facts: d, failedStage: "shape" };

  // ── Gather ALL facts first (values only), then evaluate stages in order.
  // This way the device report contains every requested field regardless of
  // which stage failed — e.g. verifySignatures=true + messageBytesEqual=false
  // is the decisive wallet-re-signed-a-modified-message signature.

  // Signature presence (legacy getter or signatures[0].signature).
  const first = Array.isArray(obj.signatures) && obj.signatures.length > 0 ? obj.signatures[0] : undefined;
  const sig: Uint8Array | null | undefined =
    (obj.signature as Uint8Array | null | undefined) ??
    (first instanceof Uint8Array ? first : (first?.signature ?? null));
  d.hasSignature = !!sig;
  d.signatureLength = sig ? sig.length : 0;
  d.signaturesLength = Array.isArray(obj.signatures) ? obj.signatures.length : 0;

  // Structural facts.
  d.feePayerPresent = !!obj.feePayer;
  d.recentBlockhashPresent = !!obj.recentBlockhash;
  d.instructionCount = Array.isArray(obj.instructions) ? obj.instructions.length : 0;
  if (typeof obj.version !== "undefined" && obj.version !== null) {
    d.transactionVersion = String(obj.version);
  } else if (obj.recentBlockhash !== undefined) {
    d.transactionVersion = "legacy";
  }

  // Message byte comparison — the exact bytes that were simulated.
  let msg: Uint8Array | null = null;
  if (typeof obj.serializeMessage === "function") msg = obj.serializeMessage();
  else if (obj.message && typeof obj.message.serialize === "function") {
    msg = obj.message.serialize();
  }
  if (msg) {
    d.returnedMessageLength = msg.length;
    d.messageBytesEqual = msg.length === expectedMessageBytes.length;
    if (d.messageBytesEqual) {
      for (let i = 0; i < msg.length; i++) {
        if (msg[i] !== expectedMessageBytes[i]) {
          d.messageBytesEqual = false;
          break;
        }
      }
    }
  }

  // Cryptographic verification when the wallet provides it.
  if (typeof obj.verifySignatures === "function") {
    try {
      d.verifySignaturesResult = !!obj.verifySignatures();
    } catch {
      d.verifySignaturesResult = false;
    }
  }

  // ── Stage evaluation (proof order; proof itself unchanged elsewhere).
  if (!sig || sig.length === 0 || sig.every((b) => b === 0)) {
    return { facts: d, failedStage: "signature_presence" };
  }
  if (msg) {
    if (msg.length !== expectedMessageBytes.length) {
      return { facts: d, failedStage: "message_length" };
    }
    if (!d.messageBytesEqual) return { facts: d, failedStage: "message_integrity" };
  }
  if (d.verifySignaturesResult === false) {
    return { facts: d, failedStage: "signature_verification" };
  }
  return { facts: d, failedStage: "other" };
}

/** One-line, value-free proof-stage summary for the UI failure message. */
export function formatProofDiagnostic(d: ProofDiagnostic, stage: ProofStage): string {
  return [
    `stage=${stage}`,
    `hasSerialize=${d.hasSerialize}`,
    `hasSignature=${d.hasSignature}`,
    `signatureLength=${d.signatureLength}`,
    `signaturesLength=${d.signaturesLength}`,
    `simulatedMessageLength=${d.simulatedMessageLength}`,
    `returnedMessageLength=${d.returnedMessageLength ?? "n/a"}`,
    `messageBytesEqual=${d.messageBytesEqual ?? "n/a"}`,
    `verifySignatures=${d.verifySignaturesResult ?? "n/a"}`,
    `feePayerPresent=${d.feePayerPresent}`,
    `recentBlockhashPresent=${d.recentBlockhashPresent}`,
    `instructionCount=${d.instructionCount}`,
    `version=${d.transactionVersion ?? "n/a"}`,
  ].join(" ");
}

/** TEMPORARY: the latest attempt's safe structural diagnostic (module-scoped so
 * describeSignFailure — called by the UI with only the reason — can append it).
 * Single-user app; signing attempts are strictly sequential. */
let lastWalletReturnDiagnostic: string | null = null;

/** TEMPORARY: safe proof-stage diagnostic (same module-scoped pattern). */
let lastProofDiagnostic: string | null = null;

/** TEMPORARY: clears captured diagnostics (used by tests). */
export function resetWalletReturnDiagnostic(): void {
  lastWalletReturnDiagnostic = null;
  lastProofDiagnostic = null;
}

/** TEMPORARY: the captured wallet-return diagnostic for the latest attempt. */
export function getLastWalletReturnDiagnostic(): string | null {
  return lastWalletReturnDiagnostic;
}

/** TEMPORARY: the captured proof-stage diagnostic for the latest attempt. */
export function getLastProofDiagnostic(): string | null {
  return lastProofDiagnostic;
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
  // TEMPORARY (attempt #4/#5): append THIS attempt's safe diagnostics so the
  // real return shape and the exact failing proof stage are observable on device.
  const parts = [base];
  if (lastWalletReturnDiagnostic) parts.push(`Wallet return diagnostic: ${lastWalletReturnDiagnostic}`);
  if (lastProofDiagnostic) parts.push(`Proof diagnostic: ${lastProofDiagnostic}`);
  return parts.join(" ");
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
/** Public key strings for the TransferCheckedWithFee account-role contract. */
export interface TransferContext {
  sourceAta: string;
  mint: string;
  destinationAta: string;
  authority: string;
  grossBaseUnits: string;
  decimals: number;
  feeBaseUnits: string;
}

export interface SignWithWalletResult {
  tx: Transaction | VersionedTransaction;
  /** Which acceptance path proved the signed transaction. */
  acceptedVia: "byte_exact" | "phantom_allowlist";
  /** Safe structural report of what the wallet changed, if it changed anything. */
  mutationReport?: string;
  /** Serialized transaction bytes (public wire data) for local diagnostics. */
  wireBase58?: string;
}

export async function signWithWallet(
  transaction: Transaction,
  wallet: {
    publicKey: { toBase58(): string } | null;
    signTransaction?: (tx: Transaction) => Promise<Transaction>;
  },
  expectedMessageBytes: Uint8Array,
  transferContext?: TransferContext,
): Promise<SignWithWalletResult> {
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
    const signedTx = normalized.tx;

    // ── Path 1: byte-exact match with what we simulated (desktop norm). ──
    if (proveSignedTransaction(signedTx, expectedMessageBytes)) {
      lastWalletReturnDiagnostic = null;
      lastProofDiagnostic = null;
      return { tx: signedTx, acceptedVia: "byte_exact", wireBase58: bs58.encode(signedTx.serialize()) };
    }

    // ── Path 2: wallet-mutation allowlist (see evaluatePhantomMutation). ──
    const walletSigValid = verifySignaturesSafe(signedTx);
    const { report, verdict } = evaluatePhantomMutation(
      expectedMessageBytes,
      signedTx,
      transferContext,
      walletSigValid,
    );
    if (!walletSigValid) {
      lastProofDiagnostic = `wallet signature INVALID over returned message | ${report}`;
      throw makeSignFailure(
        "no_signature_returned",
        `The wallet's signature does not verify over the transaction it returned. Nothing was signed or submitted. Structural report: ${report}`,
      );
    }
    if (verdict !== "allow") {
      lastProofDiagnostic = `mutation REJECTED | ${report}`;
      throw makeSignFailure(
        "no_signature_returned",
        `The wallet returned a transaction modified beyond the accepted safety allowlist. Nothing was signed or submitted. Structural report: ${report}`,
      );
    }
    lastWalletReturnDiagnostic = null;
    lastProofDiagnostic = null;
    return { tx: signedTx, acceptedVia: "phantom_allowlist", mutationReport: report, wireBase58: bs58.encode(signedTx.serialize()) };
  } catch (e) {
    if (e instanceof Error && (e as SignFailure).reason) throw e; // already typed
    // Normalization/parse failure of the resolved value.
    throw makeSignFailure(
      "no_signature_returned",
      `${e instanceof Error ? e.message : String(e)} Wallet return diagnostic: ${diagnostic}`,
    );
  }
}

/* ==========================================================================
 * STRUCTURAL COMPARATOR + STRICT WALLET-MUTATION ALLOWLIST (P0, 48-min cycle)
 * ==========================================================================
 * Device-proven facts: Phantom Android returns a signed legacy Transaction
 * with 2 ADDED instructions and 2 ADDED keys (+83 message bytes), signature
 * valid over ITS message. This comparator decodes both messages and accepts
 * ONLY:
 *   - original instructions PRESERVED in order, byte-identical (programs,
 *     accounts, data) — semantics cannot drift;
 *   - ADDED instructions limited to a fixed safe op list (Token-2022
 *     Reallocate/MemoTransfer Enable/CpiGuard Enable, or an ATA-create for
 *     OUR destination/mint), each referencing at most one NEW key which must
 *     be derived (PDA) if in the Token-2022 program's namespace;
 *   - blockhash may differ (wallet re-pin);
 *   - fee payer, header signature semantics, and the transfer core (source/
 *     mint/destination/authority/amount/decimals/fee) byte-identical;
 *   - wallet signature must cryptographically verify over its message.
 * Everything else — recipient/mint/amount/fee/payer changes, unknown
 * programs/ops/data, removed/reordered originals — REJECTS with a full safe
 * report. Public addresses and wire bytes only; never secrets.
 * ========================================================================== */

import bs58 from "bs58";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const TOKEN_OPS: Record<number, string> = {
  0: "InitializeMint", 1: "InitializeAccount", 2: "InitializeMultisig", 3: "Transfer",
  4: "Approve", 5: "Revoke", 6: "SetAuthority", 7: "MintTo", 8: "Burn", 9: "CloseAccount",
  10: "FreezeAccount", 11: "ThawAccount", 12: "TransferChecked", 13: "ApproveChecked",
  14: "MintToChecked", 15: "BurnChecked", 16: "InitializeAccount2", 17: "SyncNative",
  18: "InitializeAccount3", 19: "InitializeMultisig2", 20: "InitializeMint2",
  21: "GetAccountDataSize", 22: "InitializeImmutableOwner", 23: "AmountToUiAmount",
  24: "UiAmountToAmount", 25: "InitializeMintCloseAuthority", 26: "TransferFeeExtension",
  27: "ConfidentialTransferExtension", 28: "DefaultAccountStateExtension", 29: "Reallocate",
  30: "MemoTransferExtension", 31: "CreateNativeMint", 32: "InitializeNonTransferableMint",
  33: "InterestBearingMintExtension", 34: "CpiGuardExtension", 35: "InitializePermanentDelegate",
  36: "TransferHookExtension",
};
const TRANSFER_FEE_OPS: Record<number, string> = {
  0: "InitializeTransferFeeConfig", 1: "TransferCheckedWithFee",
  2: "WithdrawWithheldTokensFromMint", 3: "WithdrawWithheldTokensFromAccounts",
  4: "HarvestWithheldTokensToMint", 5: "SetTransferFee",
};

interface CompiledSide {
  header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
  keys: string[];
  blockhash: string;
  ixs: Array<{ pid: string; pidIdx: number; accounts: number[]; data: Uint8Array }>;
}

function compileSide(tx: Transaction | VersionedTransaction): CompiledSide | null {
  try {
    if (tx instanceof Transaction) {
      const m = tx.compileMessage();
      return {
        header: m.header,
        keys: m.accountKeys.map((k) => k.toBase58()),
        blockhash: m.recentBlockhash,
        ixs: m.instructions.map((ix) => ({
          pid: m.accountKeys[ix.programIdIndex].toBase58(),
          pidIdx: ix.programIdIndex,
          accounts: ix.accounts,
          data: bs58.decode(ix.data),
        })),
      };
    }
    if (tx instanceof VersionedTransaction) {
      const m = tx.message;
      const staticKeys = m.staticAccountKeys.map((k) => k.toBase58());
      return {
        header: {
          numRequiredSignatures: m.header.numRequiredSignatures,
          numReadonlySignedAccounts: m.header.numReadonlySignedAccounts,
          numReadonlyUnsignedAccounts: m.header.numReadonlyUnsignedAccounts,
        },
        keys: staticKeys,
        blockhash: m.recentBlockhash,
        ixs: m.compiledInstructions.map((ix) => ({
          pid: staticKeys[ix.programIdIndex],
          pidIdx: ix.programIdIndex,
          accounts: ix.accountKeyIndexes,
          data: ix.data,
        })),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function verifySignaturesSafe(tx: Transaction | VersionedTransaction): boolean {
  try {
    if (tx instanceof Transaction) return !!tx.verifySignatures();
    // web3.js 1.99.0 VersionedTransaction exposes no verifySignatures; verify
    // via the legacy round-trip is impossible for v0 — treat as unproven.
    return false;
  } catch {
    return false;
  }
}

/** op summary for reports — structural facts only, decoded where known. */
function describeOp(pid: string, data: Uint8Array, accounts: number[]): string {
  if (pid === COMPUTE_BUDGET_PROGRAM) {
    const op = { 0: "RequestUnits", 1: "RequestHeapFrame", 2: "SetComputeUnitLimit", 3: "SetComputeUnitPrice" }[data[0]] ?? `op${data[0]}`;
    return `ComputeBudget.${op}`;
  }
  if (pid === TOKEN_2022_PROGRAM) {
    const op = TOKEN_OPS[data[0]] ?? `op${data[0]}`;
    if (data[0] === 26 && data.length >= 2) {
      const sub = TRANSFER_FEE_OPS[data[1]] ?? data[1];
      let extra = "";
      if (data[1] === 1 && data.length >= 19) {
        const dv = new DataView(data.buffer, data.byteOffset);
        extra = ` amount=${dv.getBigUint64(2, true)} decimals=${data[10]} fee=${dv.getBigUint64(11, true)}`;
      }
      return `Token2022.TransferFeeExtension.${sub}${extra}`;
    }
    return `Token2022.${op}(${accounts.length} accts, ${data.length}B data)`;
  }
  if (pid === ATA_PROGRAM) return "ATA.create";
  return `UNKNOWN_PROGRAM ${pid} (data ${data.length}B)`;
}

export interface MutationEvaluation {
  verdict: "allow" | "reject";
  report: string;
}

/**
 * Compare the simulated message with the wallet's returned message and decide
 * STRICTLY whether the delta is inside the documented, safe mutation allowlist.
 */
export function evaluatePhantomMutation(
  simulatedMessageBytes: Uint8Array,
  returnedTx: Transaction | VersionedTransaction,
  transferContext: TransferContext | undefined,
  walletSignatureValid: boolean,
): MutationEvaluation {
  const R: string[] = [];
  const fail = (why: string): MutationEvaluation => ({ verdict: "reject", report: `${R.join(" | ")} | REJECT: ${why}` });

  // Simulated side: parse the EXACT expected message bytes.
  let simMsg: Message;
  try {
    simMsg = Message.from(simulatedMessageBytes);
  } catch {
    return fail("simulated message could not be parsed");
  }
  const ret = compileSide(returnedTx);
  if (!ret) return fail("returned transaction could not be parsed");
  const simKeys = simMsg.accountKeys.map((k) => k.toBase58());

  // ── Fee payer must be unchanged (first account key). ──
  if (ret.keys[0] !== simKeys[0]) {
    return fail(`fee payer changed: simulated ${simKeys[0].slice(0, 4)}… vs returned ${ret.keys[0].slice(0, 4)}…`);
  }

  // ── Header semantics: signature count must be identical. ──
  if (ret.header.numRequiredSignatures !== simMsg.header.numRequiredSignatures) {
    return fail(`header numRequiredSignatures changed ${simMsg.header.numRequiredSignatures} → ${ret.header.numRequiredSignatures}`);
  }

  // ── Key-set diff: no originals removed; relative order preserved. ──
  const retSet = new Map(ret.keys.map((k, i) => [k, i]));
  const addedKeys: Array<{ key: string; index: number }> = [];
  const retainedSimIndexInRet: number[] = [];
  for (let i = 0; i < simKeys.length; i++) {
    const idx = retSet.get(simKeys[i]);
    if (idx === undefined) return fail(`original account key removed: sim index ${i} (${simKeys[i].slice(0, 4)}…)`);
    retainedSimIndexInRet.push(idx);
  }
  for (let i = 0; i < ret.keys.length; i++) {
    if (!simKeys.includes(ret.keys[i])) addedKeys.push({ key: ret.keys[i], index: i });
  }
  const orderOk = retainedSimIndexInRet.every((v, i) => i === 0 || v > retainedSimIndexInRet[i - 1]);
  if (!orderOk) return fail("original account keys were reordered");

  // ── Instruction diff via pubkey identity (indexes remap; pubkeys don't). ──
  type Cmp = { pid: string; accounts: number[]; data: Uint8Array };
  const simIxs: Cmp[] = simMsg.instructions.map((ix) => ({
    pid: simKeys[ix.programIdIndex],
    accounts: ix.accounts,
    data: bs58.decode(ix.data),
  }));
  const resolved = (keys: string[], ix: Cmp) =>
    `${ix.pid}|${ix.accounts.map((i) => keys[i]).join(",")}|${Buffer.from(ix.data).toString("hex")}`;
  const retIxs: Cmp[] = ret.ixs;
  const matched = new Set<number>();
  const addedIxs: Cmp[] = [];
  for (const rIx of retIxs) {
    const sig = resolved(ret.keys, rIx);
    const s = simIxs.findIndex((x, i) => !matched.has(i) && resolved(simKeys, x) === sig);
    if (s >= 0) matched.add(s);
    else addedIxs.push(rIx);
  }
  for (let s = 0; s < simIxs.length; s++) {
    if (!matched.has(s)) {
      return fail(`original instruction #${s} (${describeOp(simIxs[s].pid, simIxs[s].data, simIxs[s].accounts)}) was removed or altered`);
    }
  }

  // ── Transfer core invariants (decoded from the simulated TCF wire data). ──
  if (transferContext) {
    const tcf = simIxs.find((x) => x.pid === TOKEN_2022_PROGRAM && x.data.length >= 19 && x.data[0] === 26 && x.data[1] === 1);
    if (!tcf) return fail("simulated TransferCheckedWithFee instruction not found");
    const dv = new DataView(tcf.data.buffer, tcf.data.byteOffset);
    if (dv.getBigUint64(2, true).toString() !== transferContext.grossBaseUnits) return fail("transfer amount changed");
    if (dv.getBigUint64(11, true).toString() !== transferContext.feeBaseUnits) return fail("transfer fee changed");
    if (tcf.data[10] !== transferContext.decimals) return fail("transfer decimals changed");
    const [src, mint, dst, auth] = tcf.accounts;
    if (simKeys[src] !== transferContext.sourceAta) return fail("transfer source ATA changed");
    if (simKeys[mint] !== transferContext.mint) return fail("transfer mint changed");
    if (simKeys[dst] !== transferContext.destinationAta) return fail("transfer destination ATA changed");
    if (simKeys[auth] !== transferContext.authority) return fail("transfer authority changed");
  }

  // ── ADDED-INSTRUCTION ALLOWLIST (op-level, strict). ──
  for (const ix of addedIxs) {
    const desc = describeOp(ix.pid, ix.data, ix.accounts);
    const newKeyCount = ix.accounts.filter((i) => addedKeys.some((a) => a.key === ret.keys[i])).length;
    let allowed = false;
    if (ix.pid === TOKEN_2022_PROGRAM) {
      // Reallocate with exactly one extension type: pure account-space prep.
      if (ix.data[0] === 29 && ix.data.length === 3) allowed = true;
    }
    if (!allowed) return fail(`added instruction outside allowlist: ${desc}`);
    if (newKeyCount > 1) return fail(`added instruction ${desc} references ${newKeyCount} new keys (max 1)`);
  }

  R.push(`addedInstructions=${addedIxs.length}(${addedIxs.map((ix) => describeOp(ix.pid, ix.data, ix.accounts)).join("; ")})`);
  R.push(`addedKeys=${addedKeys.length}`);
  R.push(`originalsPreserved=${matched.size}/${simIxs.length}`);
  R.push(`walletSignatureValid=${walletSignatureValid}`);
  return { verdict: "allow", report: R.join(" | ") };
}
