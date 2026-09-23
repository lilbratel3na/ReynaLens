import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Connection, PublicKey } from "@solana/web3.js";

export interface WalletBalance {
  solLamports: number;
  tokenBaseUnits: bigint | null;
  sourceAtaExists: boolean;
}

/** Read the sender's SOL + PreStock token balance in one pass. */
export async function readWalletBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<WalletBalance> {
  const [lamports, token] = await Promise.all([
    connection.getBalance(owner, "confirmed"),
    (async () => {
      const ata = getAssociatedTokenAddressSync(
        mint,
        owner,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
      try {
        const acc = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
        return { exists: true, amount: acc.amount, frozen: acc.isFrozen };
      } catch {
        return { exists: false, amount: 0n, frozen: false };
      }
    })(),
  ]);
  return {
    solLamports: lamports,
    tokenBaseUnits: token.exists ? token.amount : null,
    sourceAtaExists: token.exists,
  };
}

/** Very rough SOL network fee estimate for display only. */
export const ESTIMATED_SOL_FEE_LAMPORTS = 15_000;

export function lamportsToSol(lamports: number): string {
  return (lamports / 1_000_000_000).toFixed(5);
}

/**
 * Preflight transaction-fee estimate from CURRENT chain state (never a fixed
 * constant): the blockhash's actual base fee per signature (real network
 * state) + the compute-unit price the builder pins + a margin for priority
 * variance. The builder sets 300k CU limit / 20k microLamports price.
 */
export async function estimateTransactionFeeLamports(
  connection: Connection,
): Promise<number> {
  const BASE_FEE_LAMPORTS = 5_000;
  const COMPUTE_UNIT_LIMIT = 300_000;
  const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 20_000;
  try {
    const { feeCalculator } = await connection.getLatestBlockhashAndContext("confirmed");
    const base = feeCalculator?.lamportsPerSignature ?? BASE_FEE_LAMPORTS;
    const priority =
      (COMPUTE_UNIT_LIMIT * COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) / 1_000_000;
    return Math.ceil(base * 2 + priority); // margin: wallet may bump priority
  } catch {
    return BASE_FEE_LAMPORTS * 2 + 6_000; // conservative offline fallback
  }
}
