import { describe, expect, it } from "vitest";
import {
  calculateExactOut,
  calculateFeeForward,
  formatBaseUnits,
  parseUiAmountToBaseUnits,
  pickApplicableTier,
} from "./exactOut";

/** Model: the SPL Token-2022 deliverable-net function for a given gross. */
function deliveredNet(
  gross: bigint,
  bps: number,
  maximumFee: bigint,
): bigint {
  const fee = calculateFeeForward(gross, bps, maximumFee);
  return gross - fee;
}

describe("calculateFeeForward (mirrors SPL calculate_fee)", () => {
  it("computes ceil(amount * bps / 10000) and caps at maximumFee", () => {
    // 1% of 10_000_000_000 (100 tokens @ 9dp) = 100_000_000, uncapped:
    expect(calculateFeeForward(10_000_000_000n, 100, 18446744073709551615n)).toBe(100_000_000n);
    // rounding up: 1 bps of 9999 -> ceil(0.9999) = 1
    expect(calculateFeeForward(9999n, 1, 999n)).toBe(1n);
    // cap applies: 1% fee (100_000_000) clipped to 999
    expect(calculateFeeForward(10_000_000_000n, 100, 999n)).toBe(999n);
    // 0 bps => 0 fee regardless
    expect(calculateFeeForward(10_000_000_000n, 0, 5n)).toBe(0n);
  });
});

describe("calculateExactOut", () => {
  const cases: Array<{ bps: number; maxFee: bigint }> = [
    { bps: 100, maxFee: 18446744073709551615n }, // live PreStocks tier: 1%
    { bps: 50, maxFee: 18446744073709551615n }, // live older tier: 0.5%
    { bps: 100, maxFee: 1_000n }, // small cap
    { bps: 5000, maxFee: 12345n }, // 50% fee with cap
    { bps: 9999, maxFee: 7n }, // extreme bps with tiny cap
    { bps: 0, maxFee: 999n }, // no fee
  ];

  for (const { bps, maxFee } of cases) {
    it(`returns the minimal gross with gross - fee == net (bps=${bps}, maxFee=${maxFee})`, () => {
      for (const net of [1n, 2n, 3n, 7n, 999n, 1000n, 1001n, 100_000_007n, 10_000_000_000n]) {
        const r = calculateExactOut({
          net,
          decimals: 9,
          feeBps: bps,
          maximumFee: maxFee,
          tierEpoch: 1039,
        });
        // Invariant: exact delivery.
        expect(r.gross - r.fee).toBe(net);
        expect(r.fee).toBeLessThanOrEqual(maxFee);
        // Minimality: no smaller gross delivers this net.
        if (r.gross > 0n) {
          expect(deliveredNet(r.gross - 1n, bps, maxFee)).toBeLessThan(net);
        }
        // Continuity: delivering net+1 requires a gross >= this one.
        const r2 = calculateExactOut({
          net: net + 1n,
          decimals: 9,
          feeBps: bps,
          maximumFee: maxFee,
          tierEpoch: 1039,
        });
        expect(r2.gross).toBeGreaterThanOrEqual(r.gross);
      }
    });
  }

  it("handles the 100%-fee capped case exactly (gross = net + maximumFee)", () => {
    const r = calculateExactOut({
      net: 500n,
      decimals: 9,
      feeBps: 10000,
      maximumFee: 20n,
      tierEpoch: 1,
    });
    expect(r.gross).toBe(520n);
    expect(r.fee).toBe(20n);
    expect(r.gross - r.fee).toBe(500n);
  });

  it("handles 0 bps identically (gross == net)", () => {
    const r = calculateExactOut({
      net: 1_000_000_000n,
      decimals: 9,
      feeBps: 0,
      maximumFee: 999n,
      tierEpoch: 1,
    });
    expect(r.gross).toBe(1_000_000_000n);
    expect(r.fee).toBe(0n);
  });

  it("rejects negative and zero inputs appropriately", () => {
    expect(() =>
      calculateExactOut({ net: -1n, decimals: 9, feeBps: 100, maximumFee: 5n, tierEpoch: 1 }),
    ).toThrow();
    expect(() =>
      calculateExactOut({ net: 0n, decimals: 9, feeBps: 100, maximumFee: 5n, tierEpoch: 1 }),
    ).not.toThrow();
  });

  it("rejects out-of-range bps", () => {
    expect(() =>
      calculateExactOut({ net: 1n, decimals: 9, feeBps: 10001, maximumFee: 5n, tierEpoch: 1 }),
    ).toThrow(/basis points/i);
  });

  it("is consistent with the on-chain PreStocks example scale", () => {
    // 100 tokens @ 9 decimals with the live 1% tier:
    // gross = ceil(100e9 * 10000 / 9900) = 101_010_101_011
    // fee   = ceil(gross * 1%)          = 1_010_101_011
    // net   = 100_000_000_000 exactly
    const r = calculateExactOut({
      net: 100_000_000_000n,
      decimals: 9,
      feeBps: 100,
      maximumFee: 18446744073709551615n,
      tierEpoch: 1039,
    });
    expect(r.gross).toBe(101_010_101_011n);
    expect(r.fee).toBe(1_010_101_011n);
    expect(r.gross - r.fee).toBe(100_000_000_000n);
  });
});

describe("parseUiAmountToBaseUnits", () => {
  it("parses integers and fractions exactly in base units", () => {
    expect(parseUiAmountToBaseUnits("100", 9)).toBe(100_000_000_000n);
    expect(parseUiAmountToBaseUnits("100.05", 9)).toBe(100_050_000_000n);
    expect(parseUiAmountToBaseUnits(".5", 9)).toBe(500_000_000n);
    expect(parseUiAmountToBaseUnits("0.000000001", 9)).toBe(1n);
  });

  it("rejects malformed input and excess precision", () => {
    expect(parseUiAmountToBaseUnits("", 9)).toEqual({ error: expect.any(String) });
    expect(parseUiAmountToBaseUnits(".", 9)).toEqual({ error: expect.any(String) });
    expect(parseUiAmountToBaseUnits("1e3", 9)).toEqual({ error: expect.any(String) });
    expect(parseUiAmountToBaseUnits("1.0000000001", 9)).toEqual({
      error: expect.stringMatching(/decimal places/i),
    });
    expect(parseUiAmountToBaseUnits("-1", 9)).toEqual({ error: expect.any(String) });
    expect(parseUiAmountToBaseUnits("1 ", 9)).toBe(1_000_000_000n); // trimmed
  });
});

describe("formatBaseUnits", () => {
  it("round-trips without floats", () => {
    expect(formatBaseUnits(100_000_000_000n, 9)).toBe("100.000000000");
    expect(formatBaseUnits(1n, 9)).toBe("0.000000001");
    expect(formatBaseUnits(0n, 0)).toBe("0");
    // minFrac pads to at least that many fraction digits (never truncates):
    expect(formatBaseUnits(1_010_101_011n, 9, 12)).toBe("1.010101011000");
    expect(formatBaseUnits(-5n, 9)).toBe("-0.000000005");
  });
});

describe("pickApplicableTier", () => {
  const newer = { epoch: 1039, maximumFee: "1", transferFeeBasisPoints: 100 };
  const older = { epoch: 1032, maximumFee: "1", transferFeeBasisPoints: 50 };

  it("selects the newer tier only at or after its epoch", () => {
    expect(pickApplicableTier(newer, older, 1038)).toBe(older);
    expect(pickApplicableTier(newer, older, 1039)).toBe(newer);
    expect(pickApplicableTier(newer, older, 2000)).toBe(newer);
  });
});
