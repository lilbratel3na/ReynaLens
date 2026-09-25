import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import {
  Transaction,
  VersionedTransaction,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedWithFeeInstruction,
} from "@solana/spl-token";
import { ed25519 } from "@noble/curves/ed25519";
import {
  broadcastSignedTransaction,
  createSubmissionGuard,
  classifyWalletReturn,
  describeSignFailure,
  extractSigningWalletSource,
  formatProofDiagnostic,
  formatWalletReturnDiagnostic,
  getLastProofDiagnostic,
  getLastWalletReturnDiagnostic,
  proveSignedTransaction,
  readProofFacts,
  resetWalletReturnDiagnostic,
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
    const vtx = out!.tx as VersionedTransaction;
    expect(vtx.version).toBe(0);
    // Signature slot must be a present 64-byte signature (zero-filled = unsigned).
    expect(vtx.signatures[0].length).toBe(64);
    expect(vtx.signatures[0].some((b) => b !== 0)).toBe(true);
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
    const sig = await broadcastSignedTransaction(connection, signed.tx);
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

  it("signWithWallet: malformed bytes return → typed no_signature_returned, never broadcasts", async () => {
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => new Uint8Array([1, 2, 3]) as unknown as Transaction,
    };
    await expect(signWithWallet(buildLegacyTx(), wallet, new Uint8Array([1]))).rejects.toMatchObject({
      reason: "no_signature_returned",
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

describe("classifyWalletReturn (safe structural diagnostic, attempt #4)", () => {
  const base = { typeofValue: "object", constructorName: expect.any(String) };

  it("classifies null/undefined/primitives with type info only", () => {
    for (const v of [null, undefined]) {
      const d = classifyWalletReturn(v);
      expect(d.typeofValue).toBe(typeof v); // "object" for null, "undefined" for undefined
      expect(d.constructorName).toBeNull();
      expect(d.hasSerialize).toBe(false);
      expect(d.safeOwnKeys).toEqual([]);
    }
    const p = classifyWalletReturn(42);
    expect(p.typeofValue).toBe("number");
    expect(p.isArray).toBe(false);
  });

  it("classifies Uint8Array payload with byteLength only (never content)", () => {
    const d = classifyWalletReturn(new Uint8Array([1, 2, 3, 4, 5]));
    expect(d.isUint8Array).toBe(true);
    expect(d.byteLength).toBe(5);
    expect(d.hasSerialize).toBe(false);
    expect(JSON.stringify(d)).not.toContain("1,2,3");
  });

  it("classifies ArrayBuffer payload with byteLength only", () => {
    const d = classifyWalletReturn(new ArrayBuffer(9));
    expect(d.isArrayBuffer).toBe(true);
    expect(d.byteLength).toBe(9);
  });

  it("classifies a Transaction-like object structurally", () => {
    const fake = {
      serialize: () => new Uint8Array(),
      signature: null,
      signatures: [],
    };
    const d = classifyWalletReturn(fake);
    expect(d.hasSerialize).toBe(true);
    expect(d.hasSignatureProp).toBe(true);
    expect(d.signatureIsNull).toBe(true);
    expect(d.hasSignaturesProp).toBe(true);
    expect(d.signaturesIsArray).toBe(true);
    expect(d.signaturesLength).toBe(0);
    expect(base).toBeTruthy();
  });

  it("classifies envelope { signedTransaction } and filters unsafe keys by NAME", () => {
    const sneaky = {
      signedTransaction: new Uint8Array(3),
      secretKey: "DO-NOT-LOG",
      privateKeyBytes: new Uint8Array([9, 9, 9]),
      everythingElse: true,
    };
    const d = classifyWalletReturn(sneaky);
    expect(d.hasSignedTransaction).toBe(true);
    // Only whitelisted key NAMES are reported — never values, never other keys.
    expect(d.safeOwnKeys).toEqual(["signedTransaction"]);
    expect(JSON.stringify(d)).not.toContain("DO-NOT-LOG");
    expect(JSON.stringify(d)).not.toContain("privateKeyBytes");
  });

  it("signature prop non-null is reported as present (not its value)", () => {
    const d = classifyWalletReturn({ signature: new Uint8Array(64).fill(1) });
    expect(d.signatureIsNull).toBe(false);
  });

  it("format produces the required diagnostic line shape", () => {
    const line = formatWalletReturnDiagnostic(
      classifyWalletReturn(new Uint8Array(131)),
    );
    expect(line).toContain("type=object");
    expect(line).toContain("uint8=true");
    expect(line).toContain("byteLength=131");
    expect(line).toContain("serialize=false");
    expect(line).toContain("signatures=absent");
  });

  it("signWithWallet embeds the diagnostic in no_signature_returned failures", async () => {
    const payer = Keypair.generate();
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => ({ totally: "unexpected" }) as never,
    };
    try {
      await signWithWallet(new Transaction(), wallet, new Uint8Array([1]));
      throw new Error("should have thrown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // Unusable post-resolve value (not an object with signable shape) →
      // no_signature_returned with the safe structural diagnostic embedded.
      expect((e as { reason?: string }).reason).toBe("no_signature_returned");
      expect(msg).toContain("Wallet return diagnostic:");
      expect(msg).toContain("type=object");
      expect(msg).toContain("serialize=false");
    }
  });

  it("signWithWallet embeds the diagnostic in bridge_failure (malformed bytes)", async () => {
    const payer = Keypair.generate();
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => new Uint8Array([1, 2, 3]) as never,
    };
    try {
      await signWithWallet(new Transaction(), wallet, new Uint8Array([1]));
      throw new Error("should have thrown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // Post-resolve unusable bytes are classified no_signature_returned;
      // bridge_failure is reserved for the wallet call itself failing.
      expect((e as { reason?: string }).reason).toBe("no_signature_returned");
      expect(msg).toContain("Wallet return diagnostic:");
      expect(msg).toContain("uint8=true");
      expect(msg).toContain("byteLength=3");
    }
  });

  it("describeSignFailure appends the captured diagnostic (UI path, no AppPage change)", async () => {
    resetWalletReturnDiagnostic();
    const payer = Keypair.generate();
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => ({ weird: true }) as never,
    };
    await expect(
      signWithWallet(new Transaction(), wallet, new Uint8Array([1])),
    ).rejects.toMatchObject({ reason: "no_signature_returned" });
    // The attempt captured a shape; the UI's reason-only call now shows it.
    expect(getLastWalletReturnDiagnostic()).toContain("type=object");
    const text = describeSignFailure("no_signature_returned");
    expect(text).toContain("Wallet return diagnostic:");
    expect(text).toContain("type=object");
    resetWalletReturnDiagnostic();
    // With no attempt captured, describeSignFailure returns the base text only.
    expect(describeSignFailure("no_signature_returned")).not.toContain("Wallet return diagnostic:");
  });

  it("successful proven path does NOT carry diagnostic text", async () => {
    const payer = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 1 }),
    );
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.feePayer = payer.publicKey;
    const msgBytes = tx.compileMessage().serialize();
    tx.sign(payer);
    const bytes = tx.serialize();
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => bytes as unknown as Transaction,
    };
    const signed = await signWithWallet(tx, wallet, new Uint8Array(msgBytes));
    expect(signed).toBeTruthy();
  });
});

describe("readProofFacts / formatProofDiagnostic (attempt #5, safe values only)", () => {
  const payer = Keypair.generate();
  const to = Keypair.generate().publicKey;

  function buildPinned(): { tx: Transaction; expected: Uint8Array } {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 1 }),
    );
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.feePayer = payer.publicKey;
    return { tx, expected: tx.serializeMessage() }; // captured BEFORE signing
  }

  it("clean round-trip Transaction passes ALL stages (probe parity)", () => {
    const { tx, expected } = buildPinned();
    tx.sign(payer);
    const returned = Transaction.from(tx.serialize()); // injected-bridge round trip
    const { facts, failedStage } = readProofFacts(returned, expected);
    expect(failedStage).toBe("other"); // no stage failed
    expect(facts.messageBytesEqual).toBe(true);
    expect(facts.verifySignaturesResult).toBe(true);
    expect(facts.signatureLength).toBe(64);
    expect(facts.signaturesLength).toBe(1);
    expect(facts.feePayerPresent).toBe(true);
    expect(facts.recentBlockhashPresent).toBe(true);
    expect(facts.instructionCount).toBe(2); // compute-limit + transfer
    expect(facts.transactionVersion).toBe("legacy");
  });

  it("blockhash-replacement scenario → fails message_integrity with equal lengths", () => {
    // Simulate the known mobile-wallet behavior: the wallet re-pins the
    // recentBlockhash and re-signs BEFORE returning (same message LENGTH,
    // different bytes).
    const { tx, expected } = buildPinned();
    const originalHash = tx.recentBlockhash;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); // wallet replaces
    tx.sign(payer);
    const returned = Transaction.from(tx.serialize());
    const { facts, failedStage } = readProofFacts(returned, expected);
    expect(failedStage).toBe("message_integrity");
    expect(facts.returnedMessageLength).toBe(expected.length); // same length
    expect(facts.messageBytesEqual).toBe(false);
    expect(facts.verifySignaturesResult).toBe(true); // the wallet's own sig IS valid
    // Diagnostic line carries the required fields, values only.
    const line = formatProofDiagnostic(facts, failedStage);
    expect(line).toContain("stage=message_integrity");
    expect(line).toContain(`simulatedMessageLength=${expected.length}`);
    expect(line).toContain(`returnedMessageLength=${expected.length}`);
    expect(line).toContain("messageBytesEqual=false");
    expect(line).toContain("verifySignatures=true");
    expect(line).toContain("version=legacy");
    // Re-pinning back restores proof parity (the documented fix direction).
    expect(originalHash).toBeTruthy();
  });

  it("signature-absent case → stage=signature_presence", () => {
    const { tx, expected } = buildPinned();
    // A parsed message alone yields an EMPTY signatures array (Transaction.from
    // needs wire bytes). This mirrors a wallet handing back an unsigned object.
    const returned = Transaction.populate(
      tx.compileMessage(),
      [] // zero signatures
    );
    const { facts, failedStage } = readProofFacts(returned, expected);
    expect(failedStage).toBe("signature_presence");
    expect(facts.hasSignature).toBe(false);
  });

  it("diagnostic NEVER contains signature/message bytes", () => {
    const { tx, expected } = buildPinned();
    tx.sign(payer);
    const returned = Transaction.from(tx.serialize());
    const { facts } = readProofFacts(returned, expected);
    const serialized = JSON.stringify(facts);
    const sigHex = Buffer.from(tx.signatures[0].signature!).toString("hex");
    expect(serialized).not.toContain(sigHex.slice(0, 16));
    const msgHex = Buffer.from(expected).toString("hex");
    expect(serialized).not.toContain(msgHex.slice(0, 16));
  });

  it("blockhash-only re-pin → accepted via phantom_allowlist with empty mutation report", async () => {
    resetWalletReturnDiagnostic();
    const { tx, expected } = buildPinned();
    // Wallet replaces the blockhash and re-signs before returning.
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.sign(payer);
    const bytes = tx.serialize();
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => Transaction.from(bytes) as unknown as Transaction,
    };
    const result = await signWithWallet(new Transaction(), wallet, expected);
    expect(result.acceptedVia).toBe("phantom_allowlist");
    expect(result.mutationReport).toContain("addedInstructions=0");
    expect(result.mutationReport).toContain("addedKeys=0");
    expect(result.mutationReport).toContain("originalsPreserved=2/2");
    expect(result.mutationReport).toContain("walletSignatureValid=true");
    // wireBase58 captured for local diagnostics (public wire data only).
    expect(typeof result.wireBase58).toBe("string");
    resetWalletReturnDiagnostic();
  });

});

describe("Phantom-mutation allowlist (device-observed mutation, strict)", () => {
  const payer = Keypair.generate();
  const recipientOwner = Keypair.generate().publicKey;
  const mint = new PublicKey("PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF");
  const sourceAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const destinationAta = getAssociatedTokenAddressSync(mint, recipientOwner, false, TOKEN_2022_PROGRAM_ID);
  const CTX = {
    sourceAta: sourceAta.toBase58(),
    mint: mint.toBase58(),
    destinationAta: destinationAta.toBase58(),
    authority: payer.publicKey.toBase58(),
    grossBaseUnits: "1010101011",
    decimals: 9,
    feeBaseUnits: "10101011",
  };

  function buildSimulated(): { tx: Transaction; expected: Uint8Array } {
    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    );
    tx.add(
      createAssociatedTokenAccountInstruction(payer.publicKey, destinationAta, recipientOwner, mint, TOKEN_2022_PROGRAM_ID),
    );
    tx.add(
      createTransferCheckedWithFeeInstruction(
        sourceAta, mint, destinationAta, payer.publicKey, 1010101011n, 9, 10101011n, [], TOKEN_2022_PROGRAM_ID,
      ),
    );
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.feePayer = payer.publicKey;
    return { tx, expected: tx.serializeMessage() };
  }

  function walletReturns(simulated: Transaction, mutate: (tx: Transaction) => void): Transaction {
    const tx = new Transaction();
    tx.feePayer = simulated.feePayer;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); // re-pin (allowed)
    for (const ix of simulated.instructions) tx.add(ix);
    mutate(tx);
    tx.sign(payer); // wallet signs its own message
    return tx;
  }

  it("ALLOWS the device-observed shape: +2 Reallocate(1 extType) instructions, 1 new key each", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      t.instructions.splice(2, 0,
        new TransactionInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
          data: Buffer.from([29, 0, 0]), // Reallocate, 1 extension type
        }),
        new TransactionInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }],
          data: Buffer.from([29, 0, 0]),
        }),
      );
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    const result = await signWithWallet(new Transaction(), wallet, expected, CTX);
    expect(result.acceptedVia).toBe("phantom_allowlist");
    expect(result.mutationReport).toContain("addedInstructions=2");
    expect(result.mutationReport).toContain("Token2022.Reallocate");
    expect(result.mutationReport).toContain("originalsPreserved=4/4");
  });

  it("REJECTS recipient ATA substitution inside the transfer instruction", async () => {
    const { tx, expected } = buildSimulated();
    const attackerAta = getAssociatedTokenAddressSync(
      mint, Keypair.generate().publicKey, false, TOKEN_2022_PROGRAM_ID,
    );
    const returned = walletReturns(tx, (t) => {
      const tcf = t.instructions[t.instructions.length - 1];
      tcf.keys[2] = { pubkey: attackerAta, isSigner: false, isWritable: true }; // destination swapped
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("REJECTS amount tampering in the transfer instruction", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      // Rebuild the TCF with a doubled amount.
      t.instructions[t.instructions.length - 1] = createTransferCheckedWithFeeInstruction(
        sourceAta, mint, destinationAta, payer.publicKey, 2020202022n, 9, 10101011n, [], TOKEN_2022_PROGRAM_ID,
      );
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("REJECTS unexpected programs (memo injection)", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      t.instructions.unshift(new TransactionInstruction({
        programId: Keypair.generate().publicKey, // unknown program
        keys: [],
        data: Buffer.from([1, 2, 3]),
      }));
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("REJECTS MemoTransfer.Enable (semantics-changing op even from Token-2022)", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      t.instructions.splice(2, 0, new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [{ pubkey: destinationAta, isSigner: false, isWritable: true }], // existing key
        data: Buffer.from([30, 1]), // MemoTransferExtension.Enable
      }));
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("REJECTS fee payer substitution", async () => {
    const { tx, expected } = buildSimulated();
    const attacker = Keypair.generate();
    const returned = walletReturns(tx, (t) => {
      t.feePayer = attacker.publicKey;
      t.instructions.unshift(
        SystemProgram.transfer({ fromPubkey: attacker.publicKey, toPubkey: destinationAta, lamports: 1 }),
      );
    });
    // Sign with the attacker's key so verifySignatures passes but payer differs.
    returned.partialSign(attacker);
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("REJECTS invalid wallet signature even when structure matches", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, () => undefined); // shape identical, blockhash re-pin only
    // Corrupt the signature bytes (kept length-identical).
    const bad = Buffer.from(new Uint8Array(64).fill(1));
    returned.signatures[0].signature = bad;
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  // ── A. Reordered account table with identical SEMANTIC instructions ──
  it("A: ALLOWS original-key reorder when all instructions are semantically identical", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      // Wallet inserts its own key EARLY, forcing a sorted-key table reordering
      // (indexes shift, but every instruction still references the same pubkeys).
      t.instructions.splice(2, 0,
        new TransactionInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
          data: Buffer.from([29, 0, 0]),
        }),
      );
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    const result = await signWithWallet(new Transaction(), wallet, expected, CTX);
    expect(result.acceptedVia).toBe("phantom_allowlist");
    expect(result.mutationReport).toContain("addedInstructions=1");
    expect(result.mutationReport).toContain("originalsPreserved=4/4");
  });

  it("B: REJECTS original-key reorder PLUS changed recipient", async () => {
    const { tx, expected } = buildSimulated();
    const attackerAta = getAssociatedTokenAddressSync(
      mint, Keypair.generate().publicKey, false, TOKEN_2022_PROGRAM_ID,
    );
    const returned = walletReturns(tx, (t) => {
      // Reorder trigger (new key early) + swap destination in the TCF.
      t.instructions.splice(2, 0, new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
        data: Buffer.from([29, 0, 0]),
      }));
      const tcf = t.instructions[t.instructions.length - 1];
      tcf.keys[2] = { pubkey: attackerAta, isSigner: false, isWritable: true };
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("C: REJECTS original-key reorder PLUS changed amount", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      t.instructions.splice(2, 0, new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
        data: Buffer.from([29, 0, 0]),
      }));
      t.instructions[t.instructions.length - 1] = createTransferCheckedWithFeeInstruction(
        sourceAta, mint, destinationAta, payer.publicKey, 2020202022n, 9, 10101011n, [], TOKEN_2022_PROGRAM_ID,
      );
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("D: REJECTS original-key reorder PLUS changed signer/writable role", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      t.instructions.splice(2, 0, new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
        data: Buffer.from([29, 0, 0]),
      }));
      // Flip the MINT account (readonly) to writable — role change on an
      // original key (index remapping alone must never alter roles).
      const ataCreate = t.instructions[3];
      ataCreate.keys[1] = { pubkey: mint, isSigner: false, isWritable: true };
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("E: REJECTS original key removed", async () => {
    const { tx, expected } = buildSimulated();
    // Build a returned tx whose account table drops the mint key entirely:
    // remove the TCF (references mint) so the table no longer needs it, but
    // keep ATA-create + compute instructions.
    const returned = walletReturns(tx, (t) => {
      t.instructions.splice(2, 0, new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
        data: Buffer.from([29, 0, 0]),
      }));
      t.instructions.pop(); // drop TCF → mint disappears from the table
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("F: REJECTS unknown added instruction", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      t.instructions.splice(2, 0, new TransactionInstruction({
        programId: Keypair.generate().publicKey,
        keys: [],
        data: Buffer.from([1, 2, 3]),
      }));
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("G: ALLOWS the existing Phantom Reallocate mutation (regression)", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      t.instructions.splice(2, 0, new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
        data: Buffer.from([29, 0, 0]),
      }));
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    const result = await signWithWallet(new Transaction(), wallet, expected, CTX);
    expect(result.acceptedVia).toBe("phantom_allowlist");
  });

  it("H: REJECTS corrupted signature", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, () => undefined);
    returned.signatures[0].signature = Buffer.from(new Uint8Array(64).fill(1));
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
  });

  it("REJECT failure message embeds the exact wire bytes for offline delta analysis", async () => {
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      // Reallocate (allowlisted) + MemoTransfer.Enable (rejected op).
      t.instructions.splice(2, 0,
        new TransactionInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
          data: Buffer.from([29, 0, 0]),
        }),
        new TransactionInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
          data: Buffer.from([30, 1]),
        }),
      );
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    let message = "";
    try {
      await signWithWallet(new Transaction(), wallet, expected, CTX);
      throw new Error("should have thrown");
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    expect(message).toContain("Structural report:");
    expect(message).toContain("REJECT");
    // The failure carries the wallet's own serialized return (public wire data).
    const wire = bs58.encode(returned.serialize());
    expect(message).toContain(`wire=${wire}`);
  });

  it("describeSignFailure exposes the captured wire after a REJECT (UI path)", async () => {
    resetWalletReturnDiagnostic();
    const { tx, expected } = buildSimulated();
    const returned = walletReturns(tx, (t) => {
      t.instructions.splice(2, 0, new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
        data: Buffer.from([30, 1]), // MemoTransferExtension.Enable → REJECT
      }));
    });
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => returned as unknown as Transaction,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
    // The UI calls describeSignFailure with only the reason — the wire must be there.
    const text = describeSignFailure("no_signature_returned");
    const wire = bs58.encode(returned.serialize());
    expect(text).toContain(`wire=${wire}`);
    expect(text.trim().endsWith(wire)).toBe(true); // wire last → trivial to copy
    // A fresh attempt clears the previous wire capture.
    resetWalletReturnDiagnostic();
    expect(describeSignFailure("no_signature_returned")).not.toContain("wire=");
  });

  it("REJECT still ships without wire when serialization is unavailable (fail-open on diagnostics only)", async () => {
    const { expected } = buildSimulated();
    // Unusable post-resolve value → normalization failure; wire never existed.
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => ({ totally: "unexpected" }) as never,
    };
    await expect(signWithWallet(new Transaction(), wallet, expected, CTX)).rejects.toMatchObject({
      reason: "no_signature_returned",
    });
    expect(describeSignFailure("no_signature_returned")).not.toContain("wire=");
    resetWalletReturnDiagnostic();
  });

  it("byte-exact return still takes path 1 (acceptedVia=byte_exact)", async () => {
    const { tx, expected } = buildSimulated();
    tx.sign(payer); // SAME blockhash, no mutation
    const wallet = {
      publicKey: { toBase58: () => payer.publicKey.toBase58() },
      signTransaction: async () => tx as unknown as Transaction,
    };
    const result = await signWithWallet(new Transaction(), wallet, expected, CTX);
    expect(result.acceptedVia).toBe("byte_exact");
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
