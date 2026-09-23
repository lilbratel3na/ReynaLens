import { describe, expect, it } from "vitest";
import { evaluatePreflight } from "./preflight";

const BASE = {
  gross: 1_010_101_011n, // observed device case: net 1.000000000 at 100 bps
  decimals: 9,
  ticker: "OPENAI",
  solLamports: 100_000, // 0.0001 SOL
  txFeeLamports: 11_000,
  ataRentLamports: 0,
};

describe("evaluatePreflight", () => {
  it("passes when the wallet holds exactly the gross amount", () => {
    const r = evaluatePreflight({ ...BASE, tokenBalance: BASE.gross });
    expect(r.kind).toBe("ok");
  });

  it("stops before signature on zero token balance with a friendly message", () => {
    const r = evaluatePreflight({ ...BASE, tokenBalance: 0n });
    expect(r.kind).toBe("insufficient_token");
    if (r.kind === "insufficient_token") {
      expect(r.message).toContain("Insufficient OPENAI");
      expect(r.message).toContain("1.010101011");
      // Must not leak raw RPC/JSON anywhere.
      expect(r.message).not.toMatch(/jsonrpc|403/);
    }
  });

  it("reports the shortfall against a partial balance", () => {
    const r = evaluatePreflight({ ...BASE, tokenBalance: 500_000_000n });
    expect(r.kind).toBe("insufficient_token");
    if (r.kind === "insufficient_token") {
      expect(r.message).toContain("0.5 OPENAI");
    }
  });

  it("checks SOL against tx fee + ATA rent together", () => {
    const r = evaluatePreflight({
      ...BASE,
      tokenBalance: BASE.gross,
      solLamports: 15_000,
      txFeeLamports: 11_000,
      ataRentLamports: 2_077_680, // ~0.002 SOL typical Token-2022 ATA rent
    });
    expect(r.kind).toBe("insufficient_sol");
    if (r.kind === "insufficient_sol") {
      expect(r.message).toContain("rent for creating the recipient's token account");
    }
  });

  it("passes SOL check when rent is not required", () => {
    const r = evaluatePreflight({
      ...BASE,
      tokenBalance: BASE.gross,
      solLamports: 20_000,
      txFeeLamports: 11_000,
      ataRentLamports: 0,
    });
    expect(r.kind).toBe("ok");
  });

  it("token check runs before the SOL check", () => {
    const r = evaluatePreflight({ ...BASE, tokenBalance: 0n, solLamports: 0 });
    expect(r.kind).toBe("insufficient_token");
  });
});
