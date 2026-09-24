import { describe, expect, it } from "vitest";
import {
  Transaction,
  VersionedTransaction,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import {
  broadcastSignedTransaction,
  createSubmissionGuard,
  describeSignFailure,
  extractSigningWalletSource,
  proveSignedTransaction,
  signWithWallet,
  normalizeSignedTransactionReturn,
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

describe("normalizeSignedTransactionReturn (Phantom Android return shapes)", () => {
  // Deterministic keypair — tests never invoke a real wallet or network.
  const payer = Keypair.generate();
  const to = Keypair.generate().publicKey;

  function buildLegacyTx() {
    return new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 1 }),
    );
  }

  function signedLegacyBytes(): Uint8Array {
    const tx = buildLegacyTx();
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); // any 32-byte value
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    return tx.serialize();
  }

  function signedVersionedBytes(): Uint8Array {
    const tx = buildLegacyTx();
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.feePayer = payer.publicKey;
    // Build a TRUE v0 message the way real apps do (TransactionMessage),
    // then sign its serialized bytes with the same @noble/curves ed25519
    // primitive web3.js itself uses.
    const { TransactionMessage } = require("@solana/web3.js");
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: tx.recentBlockhash,
      instructions: tx.instructions,
    }).compileToV0Message();
    const sig = ed25519.sign(msg.serialize(), payer.secretKey.slice(0, 32));
    return new VersionedTransaction(msg, [sig]).serialize();
  }

  it("case A: legacy Transaction object → unchanged", () => {
    const tx = buildLegacyTx();
    const out = normalizeSignedTransactionReturn(tx);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("legacy");
    expect(out!.tx).toBe(tx);
  });

  it("case B: serialized SIGNED legacy bytes → Transaction.from, signature intact", () => {
    const bytes = signedLegacyBytes();
    const out = normalizeSignedTransactionReturn(bytes);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("legacy");
    const legacy = out!.tx as Transaction;
    expect(legacy.signatures[0].signature).toBeTruthy();
    expect(legacy.verifySignatures()).toBe(true);
  });

  it("case B: serialized SIGNED versioned (v0) bytes → VersionedTransaction", () => {
    const out = normalizeSignedTransactionReturn(signedVersionedBytes());
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("versioned");
    expect((out!.tx as VersionedTransaction).version).toBe(0);
    expect((out!.tx as VersionedTransaction).signatures[0].every((b) => b !== 0)).toBe(true);
  });

  it("case B: Buffer and ArrayBuffer byte carriers → same result as Uint8Array", () => {
    const bytes = signedLegacyBytes();
    const fromBuffer = normalizeSignedTransactionReturn(Buffer.from(bytes));
    const fromAb = normalizeSignedTransactionReturn(bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer);
    expect(fromBuffer!.kind).toBe("legacy");
    expect(fromAb!.kind).toBe("legacy");
  });

  it("case C: { signedTransaction: bytes } envelope → unwrapped recursively", () => {
    const out = normalizeSignedTransactionReturn({ signedTransaction: signedLegacyBytes() });
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("legacy");
  });

  it("case D: falsy returns → null (preserves no_signature_returned)", () => {
    expect(normalizeSignedTransactionReturn(null)).toBeNull();
    expect(normalizeSignedTransactionReturn(undefined)).toBeNull();
    expect(normalizeSignedTransactionReturn(false)).toBeNull();
    expect(normalizeSignedTransactionReturn(0)).toBeNull();
    expect(normalizeSignedTransactionReturn("")).toBeNull();
  });

  it("malformed bytes → throws (safely rejected, nothing broadcast)", () => {
    // Legacy-looking count byte but truncated garbage.
    expect(() => normalizeSignedTransactionReturn(new Uint8Array([1, 9, 9, 9]))).toThrow();
    // Versioned-looking prefix but unsupported version (0x80 | 9).
    expect(() =>
      normalizeSignedTransactionReturn(new Uint8Array([1, ...new Array(64).fill(7), 0x89, 1, 2, 3])),
    ).toThrow();
    // Envelope containing malformed bytes.
    expect(() =>
      normalizeSignedTransactionReturn({ signedTransaction: new Uint8Array([1, 2, 3]) }),
    ).toThrow();
  });

  it("unsigned bytes (all-zero signature) → parses, then fails the existing proof", () => {
    // Craft legacy wire bytes whose single signature slot is all zeros
    // (Transaction.from maps that to signature=null — the unsigned case).
    const tx = buildLegacyTx();
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.feePayer = payer.publicKey;
    const msgBytes = tx.compileMessage().serialize();
    const zeroBytes = new Uint8Array(1 + 64 + msgBytes.length);
    zeroBytes[0] = 1; // shortvec signature count
    // signature slot left all-zero; message bytes copied verbatim
    zeroBytes.set(msgBytes, 65);
    const out = normalizeSignedTransactionReturn(zeroBytes);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("legacy");
    expect(proveSignedTransaction(out!.tx, msgBytes)).toBe(false);
  });

  it("end-to-end signWithWallet: bytes return → proven → broadcast exactly once", async () => {
    const bytes = signedLegacyBytes();
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => bytes as unknown as Transaction,
    };
    // Expected message = the message inside those exact bytes.
    const norm = normalizeSignedTransactionReturn(bytes)!;
    const expected =
      norm.tx instanceof Transaction ? norm.tx.serializeMessage() : norm.tx.message.serialize();
    const signed = await signWithWallet(buildLegacyTx(), wallet, new Uint8Array(expected));
    expect(signed).toBeTruthy();

    let calls = 0;
    const connection = {
      sendRawTransaction: async () => {
        calls += 1;
        return "SIG_BYTES_OK";
      },
    } as never;
    const sig = await broadcastSignedTransaction(connection, signed);
    expect(sig).toBe("SIG_BYTES_OK");
    expect(calls).toBe(1);
  });

  it("signWithWallet: falsy return → no_signature_returned, never broadcasts", async () => {
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => null as unknown as Transaction,
    };
    await expect(signWithWallet(buildLegacyTx(), wallet, new Uint8Array([1]))).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("signWithWallet: malformed bytes return → typed failure, never broadcasts", async () => {
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => new Uint8Array([1, 2, 3]) as unknown as Transaction,
    };
    await expect(signWithWallet(buildLegacyTx(), wallet, new Uint8Array([1]))).rejects.toMatchObject({
      reason: "bridge_failure",
    });
  });

  it("signWithWallet: envelope return → proven and accepted", async () => {
    const bytes = signedLegacyBytes();
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => ({ signedTransaction: bytes }) as unknown as Transaction,
    };
    const normE = normalizeSignedTransactionReturn(bytes)!;
    const expected =
      normE.tx instanceof Transaction ? normE.tx.serializeMessage() : normE.tx.message.serialize();
    const signed = await signWithWallet(buildLegacyTx(), wallet, new Uint8Array(expected));
    expect(signed).toBeTruthy();
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
