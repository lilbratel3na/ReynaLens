/**
 * Exact-out calculation in integer base units.
 *
 * Token-2022 TransferFeeConfig rules (SPL implementation):
 *   epoch-based tier selection: newerTransferFee applies once epoch >= newer.epoch
 *   fee    = ceil(amount * bps / 10000)
 *   net    = amount - fee
 *   maxFee = absolute cap on the fee
 *
 * ReynaLens inverts this: given the desired NET, find the smallest GROSS such
 * that ceil(gross * bps / 10000) capped at maximumFee equals fee(gross) and
 * gross - fee(gross) == net. The inverse-ceil formula is exact in integer
 * arithmetic — there is no floating point anywhere below.
 */

export interface TransferFeeTier {
  epoch: number;
  maximumFee: string;
  transferFeeBasisPoints: number;
}

export interface ExactOutResult {
  net: bigint;
  gross: bigint;
  fee: bigint;
  feeBps: number;
  cappedByMaximumFee: boolean;
  tierEpoch: number;
  steps: string[]; // human-readable audit trail for the UI
}

export interface ExactOutInput {
  net: bigint;
  decimals: number;
  feeBps: number;
  maximumFee: bigint;
  tierEpoch: number;
}

export function pickApplicableTier(
  newer: TransferFeeTier,
  older: TransferFeeTier,
  currentEpoch: number,
): TransferFeeTier {
  return currentEpoch >= newer.epoch ? newer : older;
}

/**
 * Mirror of the SPL Token-2022 `calculateFee` (TransferFeeConfig::calculate_fee,
 * assembly in Rust: (amount * bps + 9999) / 10000, then min(maximumFee)).
 */
export function calculateFeeForward(
  amount: bigint,
  feeBps: number,
  maximumFee: bigint,
): bigint {
  if (feeBps === 0) return 0n;
  const bps = BigInt(feeBps);
  let fee = (amount * bps + 9999n) / 10000n;
  if (fee > maximumFee) fee = maximumFee;
  return fee;
}

/**
 * Exact-out: smallest gross such that calculateFeeForward(gross) applied to
 * the gross amount yields net == gross - fee. This is the inverse-ceil
 * formula: gross = ceil((net * 10000 + fee_num - 1) / fee_num) where
 * fee_num = 10000 - bps (i.e. ceil(net / (1 - bps/10000))).
 */
export function calculateExactOut(input: ExactOutInput): ExactOutResult {
  const { net, decimals, feeBps, maximumFee, tierEpoch } = input;
  if (net < 0n) throw new Error("Requested amount must be non-negative.");
  if (feeBps < 0 || feeBps > 10000) {
    throw new Error("Fee basis points out of range.");
  }

  const steps: string[] = [];
  steps.push(`Requested net: ${net} base units (decimals=${decimals}).`);
  steps.push(
    `Applicable fee tier: ${feeBps} bps (tier from epoch ${tierEpoch}).`,
  );

  if (net === 0n) {
    return {
      net: 0n,
      gross: 0n,
      fee: 0n,
      feeBps,
      cappedByMaximumFee: false,
      tierEpoch,
      steps,
    };
  }

  let gross: bigint;
  let fee: bigint;
  let cappedByMaximumFee = false;

  if (feeBps === 0) {
    gross = net;
    fee = 0n;
    steps.push("0 bps tier: gross == net, no fee.");
  } else if (feeBps >= 10000) {
    // Fee >= 100%: every transfer is capped at maximumFee, so the only way
    // net == requested is maximumFee == 0. Otherwise impossible.
    if (maximumFee === 0n) {
      gross = net;
      fee = 0n;
      steps.push("Fee 100%+ but maximumFee is 0: gross == net.");
    } else {
      throw new Error(
        "Fee is 100% or more with a non-zero maximumFee: no gross amount can deliver the requested net.",
      );
    }
  } else {
    const bps = BigInt(feeBps);
    const denominator = 10000n - bps;
    // ceil(net * 10000 / denominator) without floats:
    gross = (net * 10000n + denominator - 1n) / denominator;
    fee = calculateFeeForward(gross, feeBps, maximumFee);
    steps.push(
      `Inverse-ceil: gross = ceil(net * 10000 / (10000 - bps)) = ${gross}.`,
    );

    // Fixpoint check: fee is charged on the gross, not on the net. Iterate a
    // bounded number of times; for bps < 10000 this converges in <=2 steps.
    for (let i = 0; fee + net !== gross && i < 8; i++) {
      const next = net + fee;
      if (next === gross) break;
      gross = next;
      fee = calculateFeeForward(gross, feeBps, maximumFee);
      steps.push(`Fixpoint iteration ${i + 1}: gross=${gross}, fee=${fee}.`);
    }

    cappedByMaximumFee = fee === maximumFee && maximumFee < (gross * bps + 9999n) / 10000n;
    steps.push(
      `Fee charged on gross: fee = ceil(gross * bps / 10000) = ${fee}.`,
    );
  }

  if (fee > maximumFee) {
    throw new Error("Internal error: fee exceeded maximumFee.");
  }

  const netDelivered = gross - fee;
  if (netDelivered !== net) {
    throw new Error(
      `Exact-out invariant failed: gross ${gross} - fee ${fee} = ${netDelivered} != requested ${net}. Refusing to produce a transaction.`,
    );
  }
  steps.push(`Invariant satisfied: gross - fee == net (${gross} - ${fee} = ${net}).`);

  return {
    net,
    gross,
    fee,
    feeBps,
    cappedByMaximumFee,
    tierEpoch,
    steps,
  };
}


/** Parse a decimal UI string like "100.05" into integer base units. */
export function parseUiAmountToBaseUnits(
  ui: string,
  decimals: number,
): bigint | { error: string } {
  const trimmed = ui.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    return { error: "Enter a valid decimal amount, e.g. 100 or 100.05." };
  }
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > decimals) {
    return {
      error: `Too many decimal places: ${decimals} allowed for this asset.`,
    };
  }
  const paddedFrac = fracPart.padEnd(decimals, "0");
  const digits = (wholePart === "" ? "0" : wholePart) + paddedFrac;
  const baseUnits = BigInt(digits === "" ? "0" : digits);
  return baseUnits;
}

/** Format base units to a UI decimal string (no floats). */
export function formatBaseUnits(
  baseUnits: bigint,
  decimals: number,
  minFrac = 0,
): string {
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals > 0 ? s.slice(s.length - decimals) : "";
  let out = decimals > 0 ? `${whole}.${frac}` : whole;
  if (minFrac > 0) {
    const [w, f = ""] = out.split(".");
    out = `${w}.${(f ?? "").padEnd(minFrac, "0")}`;
  }
  return (negative ? "-" : "") + out;
}

/** Shorten an address for compact display (not for confirmation). */
export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
