import { unpackMint } from "@solana/spl-token";
import {
  ExtensionType,
  getExtensionTypes,
  getTransferFeeConfig,
  getTransferHook,
  getPausableConfig,
  getDefaultAccountState,
  getPermanentDelegate,
  getScaledUiAmountConfig,
  getTokenMetadata,
  getEpochFee,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
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
  /** Human-readable summary shown on the inspection screen. */
  notes: string[];
}

/**
 * The applicable TransferFee tier for an epoch — mirrors the on-chain rule:
 * newer tier applies once currentEpoch >= newer.epoch, otherwise older.
 */
export function applicableTierOf(
  cfg: NonNullable<MintInspection["transferFeeConfig"]>,
): TransferFeeTier {
  return cfg.currentEpoch >= cfg.newerTransferFee.epoch
    ? cfg.newerTransferFee
    : cfg.olderTransferFee;
}

/** Tier with epoch re-checked against a live epoch value. */
export function tierForEpoch(
  cfg: NonNullable<MintInspection["transferFeeConfig"]>,
  epoch: number,
): TransferFeeTier {
  return epoch >= cfg.newerTransferFee.epoch
    ? cfg.newerTransferFee
    : cfg.olderTransferFee;
}

function tierFromUnpacked(tier: {
  epoch: bigint;
  maximumFee: bigint;
  transferFeeBasisPoints: number;
}): TransferFeeTier {
  return {
    epoch: Number(tier.epoch),
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

  const mintAcc = unpackMint(mint, accountInfo, accountInfo.owner);
  const extensionTypes: ExtensionType[] = getExtensionTypes(mintAcc.tlvData);
  const extensions = extensionTypes.map((t) => ExtensionType[t] as string);

  const notes: string[] = [];

  // Current epoch — required to pick the applicable fee tier.
  const epochInfo = await connection.getEpochInfo();
  const currentEpoch = Number(epochInfo.epoch);

  const tfe = getTransferFeeConfig(mintAcc);
  let transferFeeConfig: MintInspection["transferFeeConfig"] = null;
  if (tfe) {
    const newer = tierFromUnpacked(tfe.newerTransferFee);
    const older = tierFromUnpacked(tfe.olderTransferFee);
    const applicable = currentEpoch >= newer.epoch ? newer : older;
    transferFeeConfig = {
      currentEpoch,
      newerTransferFee: newer,
      olderTransferFee: older,
      transferFeeConfigAuthority:
        tfe.transferFeeConfigAuthority?.toBase58() ?? "",
      withdrawWithheldAuthority:
        tfe.withdrawWithheldAuthority?.toBase58() ?? "",
      withheldAmount: tfe.withheldAmount?.toString() ?? "0",
    };
    notes.push(
      `Applicable tier at epoch ${currentEpoch}: ${applicable.transferFeeBasisPoints} bps (tier epoch ${applicable.epoch}).`,
    );
    // Cross-check our tier selection against the official SPL helper.
    try {
      const official = getEpochFee(tfe, BigInt(currentEpoch));
      if (Number(official.epoch) !== applicable.epoch) {
        notes.push(
          `WARNING: official epoch fee tier (epoch ${official.epoch}) differs from computed tier — the official one wins at signing.`,
        );
      }
    } catch {
      /* non-fatal: informational only */
    }
  } else {
    notes.push("No TransferFeeConfig extension on this mint.");
  }

  // Transfer hook: the SDK initializes the TransferHook extension with the
  // System Program (PublicKey.default) as the "no hook" sentinel, and SPL's
  // own transfer runtime (process_transfer_with_fee) checks
  // `hook_program_id == system_program` before invoking a hook. The
  // 538mS… logging program is only the helper real hooks delegate to.
  const hookExt = getTransferHook(mintAcc);
  const systemProgramId = PublicKey.default.toBase58();
  const hookProgram = hookExt?.programId ?? null;
  const hookIsInactive =
    !hookProgram ||
    hookProgram.toBase58() === systemProgramId ||
    hookProgram.toBase58() === "538mS9CogUtyQF8MhBW7vkHMKCxGe1Rjm2NoZ6L7LSSf";
  const activeTransferHook = !hookIsInactive;
  if (hookProgram) {
    notes.push(
      activeTransferHook
        ? `Transfer hook program ${hookProgram.toBase58()} is ACTIVE — extra accounts will be required.`
        : "Transfer hook configured but resolves to the System Program / no-op (inactive).",
    );
  } else {
    notes.push("No transfer hook configured.");
  }

  const pausable = getPausableConfig(mintAcc);
  if (pausable) {
    notes.push(
      pausable.paused
        ? "MINT IS PAUSED — transfers will fail until unpaused."
        : "Pausable extension present; mint is not paused.",
    );
  }

  const defaultState = getDefaultAccountState(mintAcc);
  if (defaultState && Number(defaultState.state) === 2) {
    notes.push(
      "DefaultAccountState is FROZEN — newly created token accounts start frozen.",
    );
  }

  const permanentDelegate = getPermanentDelegate(mintAcc);
  if (permanentDelegate) {
    notes.push(
      "PermanentDelegate extension present: an authority can move any tokens. Verified at inspection.",
    );
  }

  // Token metadata is stored in a separate TLV record; fetch it via the
  // official helper (uses its own RPC call).
  let metadata: MintInspection["metadata"] = null;
  try {
    const md = await getTokenMetadata(connection, mint);
    if (md) {
      metadata = {
        name: md.name ?? "",
        symbol: md.symbol ?? "",
        uri: md.uri ?? "",
        updateAuthority: md.updateAuthority?.toBase58() ?? "",
      };
    }
  } catch {
    /* metadata is optional for the flow */
  }

  const scaled = getScaledUiAmountConfig(mintAcc);

  return {
    mint: mint.toBase58(),
    programId: ownerStr,
    decimals: mintAcc.decimals,
    supply: mintAcc.supply.toString(),
    extensions,
    transferFeeConfig,
    transferHookProgramId: hookProgram?.toBase58() ?? null,
    activeTransferHook,
    paused: pausable ? pausable.paused : null,
    defaultAccountState: defaultState
      ? Number(defaultState.state) === 2
        ? "frozen"
        : "initialized"
      : null,
    permanentDelegate: permanentDelegate?.delegate?.toBase58() ?? null,
    metadata,
    scaledUiAmount: scaled
      ? {
          multiplier: String(scaled.multiplier),
          newMultiplier: String(scaled.newMultiplier),
          newMultiplierEffectiveTimestamp: Number(
            scaled.newMultiplierEffectiveTimestamp,
          ),
        }
      : null,
    notes,
  };
}
