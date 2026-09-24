import { describe, expect, it } from "vitest";
import {
  broadcastSignedTransaction,
  createSubmissionGuard,
  describeSignFailure,
  extractSigningWalletSource,
  proveSignedTransaction,
  signWithWallet,
} from "./walletSign";

/**
 * Minimal Transaction-like double. Only the shape walletSign touches is
 * implemented — no real network, no real wallet, no real keys.
 */
function fakeSignedTx(overrides: Partial<{
  signature: Uint8Array | null;
  signatures: Uint8Array[];
  messageBytes: Uint8Array;
  verifyOk: boolean;
  hasVerify: boolean;
  hasSerializeMessage: boolean;
}> = {}) {
  const messageBytes = overrides.messageBytes ?? new Uint8Array([1, 2, 3]);
  const signature =
    "signature" in overrides
      ? overrides.signature
      : new Uint8Array([9, 9, 9]);
  return {
    signature,
    signatures: overrides.signatures ?? (signature ? [signature] : []),
    serializeMessage: overrides.hasSerializeMessage === false ? undefined : () => messageBytes,
    serialize: () => new Uint8Array([7, 7, 7]),
    verifySignatures: overrides.hasVerify === false ? undefined : () => overrides.verifyOk ?? true,
  };
}

const MSG = new Uint8Array([1, 2, 3]);

describe("createSubmissionGuard", () => {
  it("allows exactly one acquisition", () => {
    const g = createSubmissionGuard();
    expect(g.acquire()).toBe(true);
    expect(g.consumed).toBe(true);
  });

  it("rejects duplicate callbacks / remounts after acquisition", () => {
    const g = createSubmissionGuard();
    expect(g.acquire()).toBe(true);
    expect(g.acquire()).toBe(false);
    expect(g.acquire()).toBe(false);
  });

  it("a fresh guard (explicit new user action) is usable again", () => {
    const g = createSubmissionGuard();
    g.acquire();
    const fresh = createSubmissionGuard();
    expect(fresh.acquire()).toBe(true);
  });
});

describe("proveSignedTransaction", () => {
  it("accepts a genuinely signed transaction", () => {
    expect(proveSignedTransaction(fakeSignedTx(), MSG)).toBe(true);
  });

  it("rejects a null/foreign object", () => {
    expect(proveSignedTransaction(null as never, MSG)).toBe(false);
    expect(proveSignedTransaction({} as never, MSG)).toBe(false);
  });

  it("rejects missing / empty / all-zero fee-payer signature (no signature returned)", () => {
    expect(proveSignedTransaction(fakeSignedTx({ signature: null }), MSG)).toBe(false);
    expect(proveSignedTransaction(fakeSignedTx({ signature: new Uint8Array(0) }), MSG)).toBe(false);
    expect(proveSignedTransaction(fakeSignedTx({ signature: new Uint8Array(64).fill(0) }), MSG)).toBe(false);
  });

  it("rejects a wallet-modified message (bytes differ from what was simulated)", () => {
    const tampered = fakeSignedTx({ messageBytes: new Uint8Array([1, 2, 4]) });
    expect(proveSignedTransaction(tampered, MSG)).toBe(false);
  });

  it("rejects when ed25519 verification fails", () => {
    expect(proveSignedTransaction(fakeSignedTx({ verifyOk: false }), MSG)).toBe(false);
  });

  it("rejects when verification throws", () => {
    const tx = fakeSignedTx();
    tx.verifySignatures = () => {
      throw new Error("bad");
    };
    expect(proveSignedTransaction(tx, MSG)).toBe(false);
  });

  it("falls back to signatures[0] and tolerates wallets without serializeMessage/verify", () => {
    const sig = new Uint8Array([9, 9, 9]);
    const tx = fakeSignedTx({ signature: null, signatures: [sig], hasSerializeMessage: false, hasVerify: false });
    expect(proveSignedTransaction(tx, MSG)).toBe(true);
    // And with no signature anywhere, proof fails (nothing was signed).
    const unsigned = fakeSignedTx({ signature: null, signatures: [], hasSerializeMessage: false, hasVerify: false });
    expect(proveSignedTransaction(unsigned, MSG)).toBe(false);
  });
});

describe("signWithWallet", () => {
  const baseTx = { serializeMessage: () => MSG } as never;

  it("returns the signed transaction on success", async () => {
    const wallet = {
      publicKey: { toBase58: () => "Wallet" },
      signTransaction: async () => fakeSignedTx() as never,
    };
    const signed = await signWithWallet(baseTx, wallet, MSG);
    expect(signed).toBeTruthy();
  });

  it("user rejection → typed 'rejected', nothing broadcast", async () => {
    const wallet = {
      publicKey: { toBase58: () => "Wallet" },
      signTransaction: async () => {
        throw new Error("User rejected the request");
      },
    };
    await expect(signWithWallet(baseTx, wallet, MSG)).rejects.toMatchObject({ reason: "rejected" });
  });

  it("bridge drops the response → typed 'bridge_failure'", async () => {
    const wallet = {
      publicKey: { toBase58: () => "Wallet" },
      signTransaction: async () => {
        throw new Error("wallet closed the session");
      },
    };
    await expect(signWithWallet(baseTx, wallet, MSG)).rejects.toMatchObject({ reason: "bridge_failure" });
  });

  it("wallet returns an unsigned object → typed 'no_signature_returned'", async () => {
    const wallet = {
      publicKey: { toBase58: () => "Wallet" },
      signTransaction: async () => fakeSignedTx({ signature: null }) as never,
    };
    await expect(signWithWallet(baseTx, wallet, MSG)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("no signer available → typed 'signer_unavailable'", async () => {
    await expect(
      signWithWallet(baseTx, { publicKey: { toBase58: () => "W" } }, MSG),
    ).rejects.toMatchObject({ reason: "signer_unavailable" });
    await expect(
      signWithWallet(baseTx, { publicKey: null, signTransaction: async () => fakeSignedTx() as never }, MSG),
    ).rejects.toMatchObject({ reason: "signer_unavailable" });
  });
});

describe("broadcastSignedTransaction", () => {
  it("serializes the signed bytes and submits exactly once", async () => {
    let calls = 0;
    const connection = {
      sendRawTransaction: async () => {
        calls += 1;
        return "SIG123";
      },
    } as never;
    const sig = await broadcastSignedTransaction(connection, fakeSignedTx());
    expect(sig).toBe("SIG123");
    expect(calls).toBe(1);
  });

  it("surfaces RPC send failure", async () => {
    const connection = {
      sendRawTransaction: async () => {
        throw new Error("node is behind");
      },
    } as never;
    await expect(broadcastSignedTransaction(connection, fakeSignedTx())).rejects.toThrow(
      "node is behind",
    );
  });
});

describe("describeSignFailure", () => {
  it("maps every reason to accurate user text", () => {
    expect(describeSignFailure("rejected")).toMatch(/Nothing was signed or submitted/);
    expect(describeSignFailure("no_signature_returned")).toMatch(/Nothing was signed or submitted/);
    expect(describeSignFailure("bridge_failure")).toMatch(/Nothing was signed or submitted/);
    expect(describeSignFailure("signer_unavailable")).toMatch(/Nothing was signed or submitted/);
    expect(describeSignFailure("blockhash_expired")).toMatch(/Nothing was signed or submitted/);
    expect(describeSignFailure("broadcast_failed")).toContain("network");
  });
});

describe("extractSigningWalletSource", () => {
  it("prefers the injected provider's signer on mobile-shaped wallets", () => {
    const injected = { signTransaction: async () => ({}) };
    const adapter = { signTransaction: async () => ({}) };
    const w = extractSigningWalletSource(injected as never, adapter as never);
    expect(w.source).toBe("injected");
  });

  it("falls back to the adapter signer and reports signer_unavailable when neither exists", () => {
    const adapter = { signTransaction: async () => ({}) };
    expect(extractSigningWalletSource(undefined, adapter as never).source).toBe("adapter");
    const none = extractSigningWalletSource(undefined, undefined);
    expect(none.source).toBe("none");
    if (none.source === "none") expect(none.reason).toBe("signer_unavailable");
  });
});
