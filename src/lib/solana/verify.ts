import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { Connection, ConfirmedTransactionMeta, TransactionResponseMeta } from "@solana/web3.js";

/** Derive the recipient's Token-2022 associated token account. */
export function deriveRecipientAta(
  recipientOwner: PublicKey,
  mint: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(
    mint,
    recipientOwner,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
}

export interface DeliveryVerification {
  signature: string;
  slot: number | null;
  confirmationStatus: string | null;
  /** True when the transaction exists on chain and carried no error. */
  transactionSucceeded: boolean;
  /** Mint of the verified destination token account (when checked). */
  mint?: string;
  /** Owner of the verified destination token account (when checked). */
  recipientOwner?: string;
  /** Destination ATA actually verified (when checked). */
  destinationAta?: string;
  /** Balance read from chain after the transfer. */
  postBalanceBaseUnits: bigint;
  /** Balance read before the transfer (0 for brand-new accounts). */
  preBalanceBaseUnits: bigint;
  actuallyReceived: bigint;
  matchesRequested: boolean;
  blockTime: number | null;
  explorerUrl: string;
}

type TxMeta = ConfirmedTransactionMeta | TransactionResponseMeta;

function readAccountKeys(meta: TxMeta | null): PublicKey[] {
  if (!meta) return [];
  const loaded = "loadedAddresses" in meta ? meta.loadedAddresses : undefined;
  return [
    ...((loaded?.writable ?? []) as PublicKey[]),
    ...((loaded?.readonly ?? []) as PublicKey[]),
  ];
}

/**
 * Post-transfer verification — STRICT. No fake success merely because a
 * confirmation returned. Proves, from the actual confirmed transaction and
 * the live chain state:
 *   - the transaction succeeded on chain (meta.err null) and was signed by
 *     the expected fee payer,
 *   - the destination token account is the EXACT intended ATA,
 *   - its mint is the EXACT intended mint,
 *   - its owner is the EXACT intended recipient,
 *   - the balance delta equals the EXACT requested net amount.
 */
export async function verifyDelivery(args: {
  connection: Connection;
  destinationAta: PublicKey;
  /** Balance observed before the transfer (0 for a brand-new account). */
  preBalanceLiveRead: bigint;
  requestedNet: bigint;
  requestedMint: PublicKey;
  requestedRecipientOwner: PublicKey;
  /** Our wallet — proves the confirmed transaction is OURS, not a lookalike. */
  expectedFeePayer: PublicKey;
  signature: string;
}): Promise<DeliveryVerification> {
  const {
    connection,
    destinationAta,
    preBalanceLiveRead: preBalanceBaseUnits,
    requestedNet,
    requestedMint,
    requestedRecipientOwner,
    expectedFeePayer,
    signature,
  } = args;

  // ── The exact transaction, with meta (this is what actually happened). ──
  const txInfo = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!txInfo || !txInfo.meta) {
    throw new Error(
      "The transaction could not be read on chain. The receipt is unverified.",
    );
  }
  const meta = txInfo.meta;
  if (meta.err !== null && meta.err !== undefined) {
    throw new Error(
      `The transaction failed on chain: ${JSON.stringify(meta.err)}. No delivery verified.`,
    );
  }

  // Account keys: static message keys + loaded v0 addresses (meta position).
  const staticKeys = txInfo.transaction.message.accountKeys.map(
    (k) => (typeof k === "string" ? new PublicKey(k) : k.pubkey),
  );
  const keys = [...staticKeys, ...readAccountKeys(meta)];

  // ── Our fee payer signed THIS transaction (never a lookalike). ──
  const feePayer = keys[0];
  if (!feePayer || !feePayer.equals(expectedFeePayer)) {
    throw new Error(
      "The confirmed transaction was not sent by this wallet. The receipt is unverified.",
    );
  }

  // ── Destination-ATA identity inside the transaction's account list. ──
  const ataInTx = keys.some((k) => k.equals(destinationAta));
  if (!ataInTx) {
    throw new Error(
      "The confirmed transaction does not touch the intended recipient token account. No delivery verified.",
    );
  }

  // ── The live destination account: existence, mint, owner, balance. ──
  const acc = await getAccount(connection, destinationAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  const post = acc.amount;
  const accMint = acc.mint.toBase58();
  const accOwner = acc.owner.toBase58();
  if (accMint !== requestedMint.toBase58()) {
    throw new Error(
      "The destination token account holds a different mint than requested. No delivery verified.",
    );
  }
  if (accOwner !== requestedRecipientOwner.toBase58()) {
    throw new Error(
      "The destination token account is not owned by the intended recipient. No delivery verified.",
    );
  }

  // Status (confirmation level + slot) — identity checks above already proved
  // success via meta.err; this only enriches the receipt.
  const status = await connection.getSignatureStatuses([signature]);
  const st = status.value[0];

  return {
    signature,
    slot: st?.slot ?? null,
    confirmationStatus: st?.confirmationStatus ?? null,
    transactionSucceeded: true,
    mint: accMint,
    recipientOwner: accOwner,
    destinationAta: destinationAta.toBase58(),
    postBalanceBaseUnits: post,
    preBalanceBaseUnits,
    actuallyReceived: post - preBalanceBaseUnits,
    matchesRequested: post - preBalanceBaseUnits === requestedNet,
    blockTime: txInfo.blockTime ?? null,
    explorerUrl: `https://solscan.io/tx/${signature}`,
  };
}

/**
 * Confirmation by signature-status polling. Wallet adapters may replace the
 * recent blockhash at signing time, so confirming with a client-side blockhash
 * can hang; polling getSignatureStatuses is robust to that.
 */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 90_000,
): Promise<{ ok: boolean; slot: number | null; error?: string }> {
  const start = Date.now();
  for (;;) {
    try {
      const { value } = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: false,
      });
      const st = value[0];
      if (st) {
        if (st.err) {
          return {
            ok: false,
            slot: st.slot ?? null,
            error: `Transaction failed on-chain: ${JSON.stringify(st.err)}`,
          };
        }
        if (
          st.confirmationStatus === "confirmed" ||
          st.confirmationStatus === "finalized"
        ) {
          return { ok: true, slot: st.slot ?? null };
        }
      }
    } catch {
      // transient RPC errors — keep polling until timeout
    }
    if (Date.now() - start > timeoutMs) {
      return { ok: false, slot: null, error: "Timed out waiting for confirmation." };
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** Read the destination balance before transfer (0 when account missing). */
export async function readBalanceOrZero(
  connection: Connection,
  destinationAta: PublicKey,
): Promise<bigint> {
  try {
    const acc = await getAccount(connection, destinationAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    return acc.amount;
  } catch {
    return 0n;
  }
}

export const explorerTxUrl = (signature: string) =>
  `https://solscan.io/tx/${signature}`;

export const explorerAccountUrl = (address: string) =>
  `https://solscan.io/account/${address}`;
