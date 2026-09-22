import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

/**
 * Gate 1 evidence: verifyDelivery must compute the amount actually received as
 * the destination balance DELTA (post − pre), not the recipient's final
 * balance. Stubbing @solana/spl-token's getAccount lets us prove the semantics
 * without an RPC round-trip.
 */

const DEST = "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt";

const { TOKEN_2022_STR } = vi.hoisted(() => ({
  TOKEN_2022_STR: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
}));

vi.mock("@solana/spl-token", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  return {
    getAccount: vi.fn(),
    getAssociatedTokenAddressSync: vi.fn(() => new PublicKey(DEST)),
    TOKEN_2022_PROGRAM_ID: new PublicKey(TOKEN_2022_STR),
  };
});

import { getAccount } from "@solana/spl-token";
import { readBalanceOrZero, verifyDelivery } from "./verify";

function connectionStub() {
  return {
    getSignatureStatuses: async () => ({
      value: [{ slot: 42, confirmationStatus: "confirmed", err: null }],
    }),
  } as never;
}

beforeEach(() => {
  vi.mocked(getAccount).mockReset();
});

describe("verifyDelivery (Gate 1: delta-based receipt)", () => {
  it("reports the DELTA as received — pre=50, post=150, requested=100 → received 100, verified", async () => {
    vi.mocked(getAccount).mockResolvedValue({ amount: 150n } as never);
    const proof = await verifyDelivery({
      connection: connectionStub(),
      destinationAta: new PublicKey(DEST),
      preBalanceBaseUnits: 50n,
      requestedNet: 100n,
      signature: "5" + "x".repeat(86),
    });
    expect(proof.postBalanceBaseUnits).toBe(150n);
    // The received amount is post − pre, NOT the final balance:
    expect(proof.actuallyReceived).toBe(100n);
    expect(proof.actuallyReceived).not.toBe(proof.postBalanceBaseUnits);
    expect(proof.matchesRequested).toBe(true);
  });

  it("flags a mismatch when delta ≠ requested — pre=0, post=150, requested=100", async () => {
    vi.mocked(getAccount).mockResolvedValue({ amount: 150n } as never);
    const proof = await verifyDelivery({
      connection: connectionStub(),
      destinationAta: new PublicKey(DEST),
      preBalanceBaseUnits: 0n,
      requestedNet: 100n,
      signature: "5" + "x".repeat(86),
    });
    expect(proof.actuallyReceived).toBe(150n);
    expect(proof.matchesRequested).toBe(false);
  });

  it("readBalanceOrZero falls back to 0 when the destination account does not exist", async () => {
    vi.mocked(getAccount).mockRejectedValue(new Error("AccountNotFound"));
    const pre = await readBalanceOrZero(connectionStub(), new PublicKey(DEST));
    expect(pre).toBe(0n);
  });
});
