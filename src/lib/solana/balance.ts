import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Keypair,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionMessage,
  PublicKey as Web3PublicKey,
  type Connection,
} from "@solana/web3.js";
import {
  TRANSFER_COMPUTE_UNIT_LIMIT,
  TRANSFER_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
} from "./transfer";

export interface WalletBalance {
  solLamports: number;
  tokenBaseUnits: bigint | null;
  sourceAtaExists: boolean;
}

/** Read the sender's SOL + PreStock token balance in one pass. */
export async function readWalletBalance(
  connection: Connection,
  owner: Web3PublicKey,
  mint: Web3PublicKey,
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

export function lamportsToSol(lamports: number): string {
  return (lamports / 1_000_000_000).toFixed(5);
}

/**
 * Chain-derived transaction-fee estimate used by the pre-sign preflight.
 *
 * The ONLY honest way to estimate this is to build a real message with the
 * exact instruction shape and compute budget the real transfer will carry,
 * then ask the RPC node what IT will charge for that message
 * (`getFeeForMessage` — the mechanism the installed web3.js provides;
 * `feeCalculator` was removed). The returned value already includes both the
 * per-signature base fee from current chain state and the priority fee
 * implied by the pinned compute-unit price.
 *
 * Nothing here is a hardcoded network constant: the number comes from the
 * node. If the node cannot be reached, the caller treats the fee as unknown
 * (null → preflight stops with a visible error) rather than inventing one.
 */
export async function estimateTransactionFeeLamports(
  connection: Connection,
): Promise<number | null> {
  // Same budget the real builder pins (single source of truth, transfer.ts).
  const budgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: TRANSFER_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: TRANSFER_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
    }),
  ];
  // A single SystemProgram transfer gives the message the same signature
  // count and instruction shape class as the real transfer (which carries the
  // two budget instructions + one program instruction + optional ATA create).
  // The payer is a throwaway keypair (never broadcast, owns nothing) and the
  // blockhash is a LIVE one — the node only prices messages against blockhash
  // entries in its current fee cache, so the estimate is anchored to real
  // chain state, not invented constants.
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const shapePayer = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: shapePayer,
    recentBlockhash: blockhash,
    instructions: [
      ...budgetIxs,
      SystemProgram.transfer({
        fromPubkey: shapePayer,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();

  try {
    // The RPC returns the total fee in lamports it would charge for THIS
    // message shape.
    const feeResp = await connection.getFeeForMessage(message, "confirmed");
    const messageFee = feeResp.value;
    if (typeof messageFee !== "number" || messageFee <= 0) return null;
    return Math.ceil(messageFee * 2); // margin: wallet may bump priority fee
  } catch {
    return null; // caller must stop rather than guess
  }
}
