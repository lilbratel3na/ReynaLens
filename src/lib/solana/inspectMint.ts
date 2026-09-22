import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from "@solana/spl-token";
import type { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID as TOKEN_2022_STR } from "./prestocks";

export interface TransferFeeTier {
  epoch: number;
  maximumFee: string;
  transferFeeBasisPoints: number;
}

export interface MintInspection {
  mint: string;
  programId: string;
  decimals: number;
  supply: string;
  extensions: string[];
  transferFeeConfig: {
    currentEpoch: number;
    newerTransferFee: TransferFeeTier;
    olderTransferFee: TransferFeeTier;
    transferFeeConfigAuthority: string;
    withdrawWithheldAuthority: string;
    withheldAmount: string;
  } | null;
  transferHookProgramId: string | null;
  /** Active hook = hook program configured AND not the noop program. */
  activeTransferHook: boolean;
  paused: boolean | null;
  defaultAccountState: string | null;
  permanentDelegate: string | null;
  metadata: {
    name: string;
    symbol: string;
    uri: string;
    updateAuthority: string;
  } | null;
  scaledUiAmount: {
    multiplier: string;
    newMultiplier: string;
    newMultiplierEffectiveTimestamp: number;
  } | null;
  /** Raw base-unit flag: true when the applicable fee at the current epoch is 0 bps. */
  zeroFeeAtCurrentEpoch: boolean;
  /** Human-readable summary shown on the inspection screen. */
  notes: string[];
}

function uint64ToBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  throw new Error(`Unexpected integer encoding: ${String(value)}`);
}

function tierFromUnpacked(tier: {
  epoch: number;
  maximumFee: bigint;
  transferFeeBasisPoints: number;
}): TransferFeeTier {
  return {
    epoch: tier.epoch,
    maximumFee: tier.maximumFee.toString(),
    transferFeeBasisPoints: tier.transferFeeBasisPoints,
  };
}

/**
 * Live Token-2022 mint inspection. Everything the app reasons about comes from
 * this single source of truth: decimals, extensions, transfer fee config at
 * the current epoch, hook, pause state and token metadata.
 */
export async function inspectMint(
  connection: Connection,
  mint: PublicKey,
): Promise<MintInspection> {
  const accountInfo = await connection.getAccountInfo(mint);
  if (!accountInfo) {
    throw new Error(
      `Mint ${mint.toBase58()} not found on mainnet. Refusing to continue with an unverified asset.`,
    );
  }
  const ownerStr = accountInfo.owner.toBase58();
  if (ownerStr !== TOKEN_2022_STR) {
    throw new Error(
      `Mint is owned by ${ownerStr}, not Token-2022 (${TOKEN_2022_STR}). ReynaLens only supports Token-2022 PreStocks.`,
    );
  }

  // unpackMint accepts a length param so it can parse Token-2022 mints.
  const mintAcc = unpackMint(mint, accountInfo, accountInfo.owner);
  const extensions = mintAcc.extensionData
    ? Array.from(mintAcc.extensionData.keys())
    : [];

  const notes: string[] = [];
  const tfe = mintAcc.transferFeeConfig;
  const hookExt = mintAcc.transferHook;
  const pausedExt = (mintAcc as unknown as {
    pause?: { paused?: boolean } | null;
  }).pause;

  // Current epoch — required to pick the applicable fee tier.
  const epochInfo = await connection.getEpochInfo();
  const currentEpoch = epochInfo.epoch;

  let zeroFeeAtCurrentEpoch = true;
  let transferFeeConfig: MintInspection["transferFeeConfig"] = null;
  if (tfe) {
    const applicable = currentEpoch >= tfe.newerTransferFee.epoch
      ? tfe.newerTransferFee
      : tfe.olderTransferFee;
    zeroFeeAtCurrentEpoch = applicable.transferFeeBasisPoints === 0;
    transferFeeConfig = {
      currentEpoch,
      newerTransferFee: tierFromUnpacked(tfe.newerTransferFee),
      olderTransferFee: tierFromUnpacked(tfe.olderTransferFee),
      transferFeeConfigAuthority: tfe.transferFeeConfigAuthority?.toBase58() ?? "",
      withdrawWithheldAuthority: tfe.withdrawWithheldTokensAuthority?.toBase58() ?? "",
      withheldAmount: tfe.withheldAmount?.toString() ?? "0",
    };
    notes.push(
      `Applicable tier at epoch ${currentEpoch}: ${applicable.transferFeeBasisPoints} bps (tier epoch ${applicable.epoch}).`,
    );
  } else {
    notes.push("No TransferFeeConfig extension on this mint.");
  }

  const noopProgram = "538mS9CogUtyQF8MhBW7vkHMKCxGe1Rjm2NoZ6L7LSSf";
  const hookProgram = hookExt?.programId ?? null;
  const activeTransferHook = !!hookProgram && hookProgram.toBase58() !== noopProgram;
  if (hookProgram) {
    notes.push(
      activeTransferHook
        ? `Transfer hook program ${hookProgram.toBase58()} is ACTIVE — extra accounts will be required.`
        : "Transfer hook configured but resolves to the no-op program (inactive).",
    );
  } else {
    notes.push("No transfer hook configured.");
  }

  const defaultAccountState = mintAcc.defaultAccountState?.accountState ?? null;

  return {
    mint: mint.toBase58(),
    programId: ownerStr,
    decimals: mintAcc.decimals,
    supply: mintAcc.supply.toString(),
    extensions,
    transferFeeConfig,
    transferHookProgramId: hookProgram?.toBase58() ?? null,
    activeTransferHook,
    paused: pausedExt?.paused ?? null,
    defaultAccountState,
    permanentDelegate: mintAcc.permanentDelegate?.delegate?.toBase58() ?? null,
    metadata: mintAcc.tokenMetadata
      ? {
          name: mintAcc.tokenMetadata.name,
          symbol: mintAcc.tokenMetadata.symbol,
          uri: mintAcc.tokenMetadata.uri,
          updateAuthority: mintAcc.tokenMetadata.updateAuthority.toBase58(),
        }
      : null,
    scaledUiAmount: mintAcc.scaledUiAmountConfig
      ? {
          multiplier: mintAcc.scaledUiAmountConfig.multiplier.toString(),
          newMultiplier: mintAcc.scaledUiAmountConfig.newMultiplier.toString(),
          newMultiplierEffectiveTimestamp:
            mintAcc.scaledUiAmountConfig.newMultiplierEffectiveTimestamp,
        }
      : null,
    zeroFeeAtCurrentEpoch,
    notes,
  };
}

export { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID };
