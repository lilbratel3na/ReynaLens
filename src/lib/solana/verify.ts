import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Connection, PublicKey } from "@solana/web3.js";

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
  /** Balance read from chain after the transfer. */
  postBalanceBaseUnits: bigint;
  /** Balance read before the transfer (0 for brand-new accounts). */
  preBalanceBaseUnits: bigint;
  actuallyReceived: bigint;
  matchesRequested: boolean;
  blockTime: number | null;
  explorerUrl: string;
}

/**
 * Post-transfer verification: read the destination token account and prove the
 * actual delta equals the requested net amount.
 */
export async function verifyDelivery(args: {
  connection: Connection;
  destinationAta: PublicKey;
  preBalanceBaseUnits: bigint;
  requestedNet: bigint;
  signature: string;
}): Promise<DeliveryVerification> {
  const {
    connection,
    destinationAta,
    preBalanceBaseUnits,
    requestedNet,
    signature,
  } = args;

  const acc = await getAccount(connection, destinationAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  const post = acc.amount;

  // Also confirm the tx status on chain.
  const status = await connection.getSignatureStatuses([signature]);
  const st = status.value[0];

  return {
    signature,
    slot: st?.slot ?? null,
    confirmationStatus: st?.confirmationStatus ?? null,
    postBalanceBaseUnits: post,
    preBalanceBaseUnits,
    actuallyReceived: post - preBalanceBaseUnits,
    matchesRequested: post - preBalanceBaseUnits === requestedNet,
    blockTime: null,
    explorerUrl: `https://solscan.io/tx/${signature}`,
  };
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
