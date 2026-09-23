/**
 * Pre-sign preflight (P0): everything required BEFORE the wallet is asked to
 * sign. The evaluator below is pure and unit-tested; the rent estimator reads
 * real chain data (never a hardcoded rent constant).
 */

import {
  unpackMint,
  getAccountLenForMint,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { formatBaseUnits } from "./exactOut";
import type { MintInspection } from "./inspectMint";

export type PreflightResult =
  | { kind: "ok" }
  | { kind: "insufficient_token"; message: string }
  | { kind: "insufficient_sol"; message: string };

export interface PreflightInput {
  /** LIVE sender Token-2022 balance in base units (0 when no account). */
  tokenBalance: bigint;
  /** Gross base units the transfer must send (from the exact-out engine). */
  gross: bigint;
  decimals: number;
  ticker: string;
  /** LIVE sender SOL lamports. */
  solLamports: number;
  /** Estimated transaction fee (signatures + compute budget) in lamports. */
  txFeeLamports: number;
  /** Rent-exemption lamports for the recipient ATA when it must be created. */
  ataRentLamports: number;
}

/**
 * Gate the wallet-signature request on real balances. Called AFTER the real
 * transaction is built and BEFORE any signing prompt — an insufficient wallet
 * must stop the flow with a clear message and never open the wallet.
 */
export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const { tokenBalance, gross, decimals, ticker, solLamports, txFeeLamports, ataRentLamports } =
    input;

  if (tokenBalance < gross) {
    // Trim trailing zeros for readability without any precision loss — the
    // raw base-unit numbers remain the sole source of truth.
    const fmt = (v: bigint) => formatBaseUnits(v, decimals).replace(/\.?0+$/, "");
    return {
      kind: "insufficient_token",
      message: `Insufficient ${ticker} balance. You need ${fmt(gross)} ${ticker} to send this amount (you hold ${fmt(tokenBalance)} ${ticker}).`,
    };
  }

  const requiredLamports = txFeeLamports + ataRentLamports;
  if (solLamports < requiredLamports) {
    const rentPart =
      ataRentLamports > 0
        ? ` including ${formatBaseUnits(BigInt(ataRentLamports), 9)} SOL rent for creating the recipient's token account`
        : "";
    return {
      kind: "insufficient_sol",
      message: `Insufficient SOL for network fees. This transaction needs ${formatBaseUnits(BigInt(requiredLamports), 9)} SOL${rentPart}. You hold ${formatBaseUnits(BigInt(solLamports), 9)} SOL.`,
    };
  }

  return { kind: "ok" };
}

/**
 * Rent-exemption requirement for creating the recipient's Token-2022 ATA,
 * derived from CURRENT chain/runtime state:
 *   1. measure the actual on-chain space of an existing token account for
 *      THIS mint (accounts inherit extension space from the mint), then
 *   2. ask the RPC for getMinimumBalanceForRentExemption(that space).
 *
 * Fallback: the official account-length helper over the mint's LIVE extension
 * set (`getAccountLenForMint` on the unpacked mint — accounts carry the
 * account-side of the mint's extensions, e.g. TransferHook → TransferHookAccount).
 * Returns null only if the chain cannot be read at all — the caller then skips
 * the rent portion of the SOL check rather than inventing a number.
 */
export async function estimateAtaRentLamports(
  connection: Connection,
  mintInspection: MintInspection,
  mint: PublicKey,
): Promise<number | null> {
  // 1. Measure a real token account of this mint (its data length is exactly
  // the space a freshly created ATA for this mint will occupy).
  try {
    const largest = await connection.getTokenLargestAccounts(mint);
    const sample = largest.value.find((a) => a.amount !== "0") ?? largest.value[0];
    if (sample) {
      const info = await connection.getAccountInfo(sample.address);
      if (info && info.data.length > 0) {
        return await connection.getMinimumBalanceForRentExemption(info.data.length);
      }
    }
  } catch {
    /* fall through to the layout-based fallback */
  }

  // 2. Fallback: the official helper over the mint's LIVE extension set.
  try {
    const accountInfo = await connection.getAccountInfo(mint);
    if (!accountInfo) return null;
    const mintAcc = unpackMint(mint, accountInfo, accountInfo.owner);
    const size = getAccountLenForMint(mintAcc);
    return await connection.getMinimumBalanceForRentExemption(size);
  } catch {
    return null;
  }
}
