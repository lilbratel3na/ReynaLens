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
        return { exists: true, amount: acc.amount, frozen: acc.state === 2 };
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

/** Very rough SOL network fee estimate for display. */
export const ESTIMATED_SOL_FEE_LAMPORTS = 15_000;

export function lamportsToSol(lamports: number): string {
  return (lamports / 1_000_000_000).toFixed(5);
}
