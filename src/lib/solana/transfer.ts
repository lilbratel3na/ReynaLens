import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedWithFeeInstruction,
  getExtraAccountMetaAddress,
  getExtraAccountMetas,
  resolveExtraAccountMeta,
} from "@solana/spl-token";
// The `buffer` polyfill package (same one @solana/web3.js uses). Imported
// explicitly so `Buffer.alloc` below resolves at runtime in the browser —
// Vite does not inject a global Buffer.
import { Buffer } from "buffer";
import type { AccountMeta } from "@solana/web3.js";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import type { MintInspection } from "./inspectMint";
import type { ExactOutResult } from "./exactOut";
import { TOKEN_2022_PROGRAM_ID as TOKEN_2022_STR } from "./prestocks";

export interface BuiltTransfer {
  transaction: Transaction;
  destinationAta: PublicKey;
  /** Extra accounts resolved for a transfer hook, if any. */
  hookAccounts: AccountMeta[];
}

export interface BuildTransferArgs {
  connection: Connection;
  owner: PublicKey;
  sourceAta: PublicKey;
  mintInspection: MintInspection;
  recipient: PublicKey;
  destinationAta: PublicKey;
  needsAtaCreation: boolean;
  exactOut: ExactOutResult;
  decimals: number;
}

/**
 * Fetch and resolve the ExtraAccountMetaList for a transfer hook, if present.
 * Uses the official SPL resolvers so PDA-derived extra accounts are supported;
 * anything that cannot be resolved is a hard stop per Kill Switch F.
 */
async function resolveHookAccounts(
  connection: Connection,
  hookProgramId: PublicKey,
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
): Promise<{ metas: AccountMeta[]; errorMessage?: string }> {
  const extraAccountMetaList = getExtraAccountMetaAddress(mint, hookProgramId);
  const info = await connection.getAccountInfo(extraAccountMetaList);
  if (!info) {
    return {
      metas: [],
      errorMessage: `Transfer hook ${hookProgramId.toBase58()} is active but no ExtraAccountMetaList account was found for this mint. ReynaLens will not construct a hook-unaware transaction.`,
    };
  }
  let parsed;
  try {
    parsed = getExtraAccountMetas(info);
  } catch {
    return {
      metas: [],
      errorMessage: "Malformed ExtraAccountMetaList — cannot resolve hook accounts. ReynaLens will not construct a hook-unaware transaction.",
    };
  }
  // The first three accounts the hook sees, in order (src, mint, dst).
  const previousMetas: AccountMeta[] = [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: destination, isSigner: false, isWritable: true },
  ];
  const resolved: AccountMeta[] = [];
  for (const extraMeta of parsed) {
    try {
      const meta = await resolveExtraAccountMeta(
        connection,
        extraMeta,
        [...previousMetas, ...resolved],
        Buffer.alloc(0), // instruction data not referenced by standard seeds
        hookProgramId,
      );
      resolved.push(meta);
    } catch (e) {
      return {
        metas: [],
        errorMessage: `Could not resolve a transfer-hook account: ${e instanceof Error ? e.message : String(e)}. ReynaLens will not bypass the hook (Kill Switch F).`,
      };
    }
  }
  return { metas: resolved };
}

/**
 * Construct the Token-2022 transfer transaction:
 *   [ATA creation if needed] → transferCheckedWithFee(gross, decimals, fee)
 * with a compute budget sized for hook-heavy transfers.
 */
export async function buildTransferTransaction(
  args: BuildTransferArgs,
): Promise<BuiltTransfer> {
  const {
    owner,
    sourceAta,
    mintInspection,
    recipient,
    destinationAta,
    needsAtaCreation,
    exactOut,
    decimals,
  } = args;

  if (mintInspection.programId !== TOKEN_2022_STR) {
    throw new Error(
      "Refusing to build: mint is not owned by the Token-2022 program.",
    );
  }
  if (!mintInspection.transferFeeConfig) {
    throw new Error(
      "Refusing to build: mint has no TransferFeeConfig — the exact-out problem is not defined for this asset (Kill Switch A).",
    );
  }

  const ixs: TransactionInstruction[] = [];

  // Generous compute budget; ATA creation + fee accounting can exceed default.
  ixs.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
  );

  if (needsAtaCreation) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        owner, // payer
        destinationAta,
        recipient, // token account owner
        new PublicKey(mintInspection.mint),
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }

  const cfg = mintInspection.transferFeeConfig;
  const tier =
    cfg.currentEpoch >= cfg.newerTransferFee.epoch
      ? cfg.newerTransferFee
      : cfg.olderTransferFee;
  const feeBps = tier.transferFeeBasisPoints;
  const maximumFee = BigInt(tier.maximumFee);
  const fee = exactOut.fee > maximumFee ? maximumFee : exactOut.fee;

  const hookAccounts: AccountMeta[] = [];
  if (mintInspection.activeTransferHook && mintInspection.transferHookProgramId) {
    const resolved = await resolveHookAccounts(
      args.connection,
      new PublicKey(mintInspection.transferHookProgramId),
      sourceAta,
      new PublicKey(mintInspection.mint),
      destinationAta,
    );
    if (resolved.errorMessage) {
      throw new Error(resolved.errorMessage);
    }
    hookAccounts.push(...resolved.metas);
  }

  // Official SPL helper: TransferCheckedWithFee (extension instruction 1).
  const transferIx = createTransferCheckedWithFeeInstruction(
    sourceAta,
    new PublicKey(mintInspection.mint),
    destinationAta,
    owner, // authority = the sender (fee payer / transfer authority)
    exactOut.gross, // gross amount to send
    decimals,
    fee, // expected fee — validated on-chain
    [],
    TOKEN_2022_PROGRAM_ID,
  );
  // Hook accounts come after the 4 core accounts (src, mint, dst, authority),
  // preserving the signer/writable flags from the official resolver.
  transferIx.keys.push(...hookAccounts);
  ixs.push(transferIx);

  const transaction = new Transaction().add(...ixs);
  // Pin an explicit fee payer so simulate/send never fail with "fee payer
  // required". The wallet still signs and broadcasts.
  transaction.feePayer = owner;
  return { transaction, destinationAta, hookAccounts };
}

/** Pre-flight simulation gate. Returns failure reasons instead of throwing. */
export async function simulateTransfer(
  connection: Connection,
  transaction: Transaction,
  feePayer: PublicKey,
): Promise<{ ok: boolean; error?: string; logs?: string[] }> {
  try {
    // compileMessage() throws "Transaction recentBlockhash required" when the
    // transaction was built without one (which buildTransferTransaction does
    // on purpose — a blockhash pinned at build time would go stale). Fill it
    // in here for simulation only; the signing path always fetches a fresh
    // blockhash afterwards, so this never leaks into the signed transaction.
    if (!transaction.recentBlockhash) {
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
    }
    // Simulate via the VersionedTransaction overload with sigVerify=false and
    // replaceRecentBlockhash=true. No partial signing is involved: the wallet
    // adapter signs and broadcasts later. (The legacy (tx, signers) overload
    // requires actual Signers and suffers from signature-collision caching.)
    const vtx = new VersionedTransaction(transaction.compileMessage());
    const { value } = await connection.simulateTransaction(vtx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    if (value.err) {
      const logs = value.logs ?? [];
      return { ok: false, error: humanizeSimError(value.err, logs), logs };
    }
    return { ok: true, logs: value.logs ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function humanizeSimError(err: unknown, logs: string[] = []): string {
  const joined = logs.join("\n");
  if (joined.includes("TransferFee(IncorrectFee)"))
    return "Token-2022 rejected the expected fee (fee configuration changed). Recalculate and retry.";
  if (joined.includes("frozen")) return "Destination token account is frozen.";
  if (joined.includes("IncorrectProgramId"))
    return "Wrong token program for this asset (Token-2022 vs legacy Token).";
  if (joined.includes("insufficient"))
    return "Insufficient balance to deliver the requested amount after the transfer fee.";
  return `Simulation failed: ${JSON.stringify(err)}`;
}
