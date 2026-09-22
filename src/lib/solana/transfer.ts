import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedWithFeeInstruction,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import type { MintInspection } from "./inspectMint";
import type { ExactOutResult } from "./exactOut";
import { TOKEN_2022_PROGRAM_ID as TOKEN_2022_STR } from "./prestocks";

export interface BuiltTransfer {
  transaction: Transaction;
  destinationAta: PublicKey;
  /** Extra accounts resolved for a transfer hook, if any. */
  hookAccounts: PublicKey[];
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
 * Fetch the ExtraAccountMetaList account for a transfer hook, if present.
 * Only static (non-PDA-deriving) metas are supported; anything else is a
 * hard stop per Kill Switch F.
 */
async function resolveHookAccounts(
  connection: Connection,
  hookProgramId: PublicKey,
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
): Promise<{ accounts: PublicKey[]; errorMessage?: string }> {
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBytes()],
    hookProgramId,
  );
  const info = await connection.getAccountInfo(extraAccountMetaList);
  if (!info) {
    return {
      accounts: [],
      errorMessage: `Transfer hook ${hookProgramId.toBase58()} is active but no ExtraAccountMetaList account was found for this mint. ReynaLens will not construct a hook-unaware transaction.`,
    };
  }
  // ExtraAccountMetaList layout: 4-byte length prefix, u32 count, then metas.
  // Meta layouts (discriminator first byte):
  //   0 = Literal (Pubkey + u8 is_signer + u8 is_writable)  → 35 bytes
  //   1 = AccountMetaValue (u8 index into [src, mint, dst, owner]) → 2 bytes
  const data = info.data;
  if (data.length < 8) {
    return { accounts: [], errorMessage: "Malformed ExtraAccountMetaList." };
  }
  const count = data.readUInt32LE(4);
  const accounts: PublicKey[] = [];
  let offset = 8;
  for (let i = 0; i < count; i++) {
    const discriminator = data[offset];
    if (discriminator === 0) {
      if (offset + 35 > data.length) {
        return {
          accounts: [],
          errorMessage: "Truncated ExtraAccountMetaList — cannot resolve hook accounts.",
        };
      }
      const pk = new PublicKey(data.subarray(offset + 1, offset + 33));
      accounts.push(pk);
      offset += 35;
    } else if (discriminator === 1) {
      const index = data[offset + 1];
      const mapping = [source, mint, destination, owner];
      if (index >= mapping.length) {
        return {
          accounts: [],
          errorMessage: "Unresolvable ExtraAccountMeta index.",
        };
      }
      accounts.push(mapping[index]);
      offset += 2;
    } else {
      return {
        accounts: [],
        errorMessage: `Unsupported ExtraAccountMeta discriminator ${discriminator}. ReynaLens cannot construct this hook's transaction.`,
      };
    }
  }
  return { accounts };
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

  const hookAccounts: PublicKey[] = [];
  if (mintInspection.activeTransferHook && mintInspection.transferHookProgramId) {
    const resolved = await resolveHookAccounts(
      args.connection,
      new PublicKey(mintInspection.transferHookProgramId),
      sourceAta,
      new PublicKey(mintInspection.mint),
      destinationAta,
      owner,
    );
    if (resolved.errorMessage) {
      throw new Error(resolved.errorMessage);
    }
    hookAccounts.push(...resolved.accounts);
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
  // Hook accounts come after the 4 core accounts (src, mint, dst, authority).
  transferIx.keys.push(
    ...hookAccounts.map((pk) => ({
      pubkey: pk,
      isSigner: false,
      isWritable: true,
    })),
  );
  ixs.push(transferIx);

  const transaction = new Transaction().add(...ixs);
  return { transaction, destinationAta, hookAccounts };
}

/** Pre-flight simulation gate. Returns failure reasons instead of throwing. */
export async function simulateTransfer(
  connection: Connection,
  transaction: Transaction,
  feePayer: PublicKey,
): Promise<{ ok: boolean; error?: string; logs?: string[] }> {
  try {
    // simulateTransaction on a Transaction must be signed by the fee payer
    // (partial signature) — wallet adapters sign via sendTransaction, so we
    // simulate with sigVerify=false and let the runtime replace the blockhash.
    const { value } = await connection.simulateTransaction(transaction, [feePayer], {
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
