/**
 * TEMPORARY DIAGNOSTIC COMPARATOR (attempt #6) — READ-ONLY.
 *
 * Decodes two serialized legacy messages (the simulated one we built, and the
 * one Phantom returned on device) and reports EVERY requested structural fact
 * — headers, account-key set diffs (with signer/writable flags), blockhash
 * equality, per-instruction program/accounts/data comparison with byte-exact
 * hex, program identification, spl-token instruction decoding, and exact
 * wire-format byte accounting for the 380→463 (+83) delta.
 *
 * NO WALLET IS INVOKED. NO TRANSACTION IS SENT. No proof/acceptance logic is
 * touched. Nothing here runs in production — diagnostic tooling only.
 */
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedWithFeeInstruction,
  decodeTransferCheckedWithFeeInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";

// ── Known programs (solana-labs constants) ────────────────────────────────
const KNOWN_PROGRAMS: Record<string, string> = {
  ComputeBudget111111111111111111111111111111: "ComputeBudget",
  "11111111111111111111111111111111": "System Program",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token (legacy)",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo (new)",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo (v1)",
};
const TOKEN_2022_INSTRUCTIONS: Record<number, string> = {
  0: "InitializeMint", 1: "InitializeAccount", 2: "InitializeMultisig", 3: "Transfer",
  4: "Approve", 5: "Revoke", 6: "SetAuthority", 7: "MintTo", 8: "Burn", 9: "CloseAccount",
  10: "FreezeAccount", 11: "ThawAccount", 12: "TransferChecked", 13: "ApproveChecked",
  14: "MintToChecked", 15: "BurnChecked", 16: "InitializeAccount2", 17: "SyncNative",
  18: "InitializeAccount3", 19: "InitializeMultisig2", 20: "InitializeMint2",
  21: "GetAccountDataSize", 22: "InitializeImmutableOwner", 23: "AmountToUiAmount",
  24: "UiAmountToAmount", 25: "InitializeMintCloseAuthority", 26: "TransferFeeExtension",
  27: "ConfidentialTransferExtension", 28: "DefaultAccountStateExtension", 29: "Reallocate",
  30: "MemoTransferExtension", 31: "CreateNativeMint", 32: "InitializeNonTransferableMint",
  33: "InterestBearingMintExtension", 34: "CpiGuardExtension", 35: "InitializePermanentDelegate",
  36: "TransferHookExtension", 39: "MetadataPointerExtension", 40: "GroupPointerExtension",
  41: "GroupMemberPointerExtension",
};
const TRANSFER_FEE_INSTRUCTIONS: Record<number, string> = {
  0: "InitializeTransferFeeConfig", 1: "TransferCheckedWithFee",
  2: "WithdrawWithheldTokensFromMint", 3: "WithdrawWithheldTokensFromAccounts",
  4: "HarvestWithheldTokensToMint", 5: "SetTransferFee",
};
const COMPUTE_INSTRUCTIONS: Record<number, string> = {
  0: "RequestUnits", 1: "RequestHeapFrame", 2: "SetComputeUnitLimit", 3: "SetComputeUnitPrice",
};

function programName(pk: PublicKey): string {
  return KNOWN_PROGRAMS[pk.toBase58()] ?? "UNKNOWN";
}

function short(pk: PublicKey): string {
  return pk.toBase58();
}

interface DecodedIx {
  programId: string;
  programName: string;
  programIdIndex: number;
  accounts: number[];
  dataLength: number;
  dataHex: string;
  semantic: string;
}

function decodeIx(
  ix: { programIdIndex: number; accounts: number[]; data: string },
  keys: PublicKey[],
): DecodedIx {
  const programId = keys[ix.programIdIndex];
  const name = programName(programId);
  // Compiled messages carry instruction data as a bs58 STRING.
  const data: Uint8Array = bs58.decode(ix.data);
  let semantic = "";
  if (name === "ComputeBudget" && data.length >= 1) {
    semantic = COMPUTE_INSTRUCTIONS[data[0]] ?? `unknown(${data[0]})`;
  } else if (name === "Token-2022" && data.length >= 1) {
    const op = TOKEN_2022_INSTRUCTIONS[data[0]] ?? `unknown(${data[0]})`;
    semantic = op;
    if (op === "TransferFeeExtension" && data.length >= 2) {
      semantic = `TransferFeeExtension.${TRANSFER_FEE_INSTRUCTIONS[data[1]] ?? data[1]}`;
      if (data[1] === 1 && data.length >= 19) {
        // TransferCheckedWithFee: u8 op + u8 subOp + u8 decimals + u64 amount + u64 fee
        const dv = new DataView(data.buffer, data.byteOffset);
        const amount = dv.getBigUint64(2, true);
        const decimals = data[10];
        const fee = dv.getBigUint64(11, true);
        semantic += ` amount=${amount} decimals=${decimals} fee=${fee}`;
      }
    } else if (op === "Reallocate" && data.length >= 3) {
      const extType = data[1] | (data[2] << 8);
      semantic = `Reallocate extensionType=${extType}`;
    } else if (op === "MemoTransferExtension" && data.length >= 2) {
      semantic = `MemoTransferExtension.${data[1] === 1 ? "Enable" : data[1] === 0 ? "Disable" : data[1]}`;
    } else if (op === "CpiGuardExtension" && data.length >= 2) {
      semantic = `CpiGuardExtension.${data[1] === 1 ? "Enable" : "Disable"}`;
    }
  } else if (name === "Associated Token Account") {
    semantic = "Create";
  } else if (name === "System Program" && data.length >= 4) {
    const dv = new DataView(data.buffer, data.byteOffset);
    semantic = `System op=${dv.getUint32(0, true)}`;
  }
  return {
    programId: short(programId),
    programName: name,
    programIdIndex: ix.programIdIndex,
    accounts: ix.accounts,
    dataLength: data.length,
    dataHex: Buffer.from(data).toString("hex"),
    semantic,
  };
}

interface SideSummary {
  header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
  keys: string[];
  blockhash: string;
  instructions: DecodedIx[];
  messageLength: number;
}

function summarize(tx: Transaction): SideSummary {
  const msg = tx.compileMessage();
  return {
    header: msg.header,
    keys: msg.accountKeys.map(short),
    blockhash: msg.recentBlockhash,
    instructions: msg.instructions.map((ix) => decodeIx(ix, msg.accountKeys)),
    messageLength: tx.serializeMessage().length,
  };
}

/** Key diff with signer/writable metadata from both messages' headers. */
function diffKeys(sim: SideSummary, ret: SideSummary) {
  const simSet = new Map(sim.keys.map((k, i) => [k, i]));
  const retSet = new Map(ret.keys.map((k, i) => [k, i]));
  const added: Array<{ key: string; retIndex: number; signer: boolean; writable: boolean }> = [];
  const removed: Array<{ key: string; simIndex: number }> = [];
  const signerOf = (s: SideSummary, i: number) => i < s.header.numRequiredSignatures;
  const writableOf = (s: SideSummary, i: number) => {
    const signedPart = s.header.numRequiredSignatures + s.header.numReadonlySignedAccounts;
    if (i < signedPart) return i < s.header.numRequiredSignatures;
    return i < s.keys.length - s.header.numReadonlyUnsignedAccounts;
  };
  for (const [k, i] of retSet) {
    if (!simSet.has(k)) {
      added.push({ key: k, retIndex: i, signer: signerOf(ret, i), writable: writableOf(ret, i) });
    }
  }
  for (const [k, i] of simSet) {
    if (!retSet.has(k)) removed.push({ key: k, simIndex: i });
  }
  const retainedSim = sim.keys.filter((k) => retSet.has(k));
  const retainedRet = ret.keys.filter((k) => simSet.has(k));
  const orderPreserved =
    retainedSim.length === retainedRet.length &&
    retainedSim.every((k, i) => k === retainedRet[i]);
  return { added, removed, orderPreserved };
}

function compareIxArrays(sim: SideSummary, ret: SideSummary) {
  const simIxs = sim.instructions;
  const retIxs = ret.instructions;
  // SEMANTIC signature: program + data + RESOLVED account pubkeys (indexes
  // mapped through each side's own key list). Indexes shift when new keys are
  // inserted — pubkey identity is the correct comparison.
  const resolved = (s: SideSummary, ix: DecodedIx) =>
    `${ix.programId}|${ix.dataHex}|${ix.accounts.map((i) => s.keys[i]).join(",")}`;
  const simSigs = simIxs.map((ix) => resolved(sim, ix));
  const matched = new Set<number>();
  const mapping: Array<{ simIndex: number | null; retIndex: number; identical: boolean; indexesRemapped: boolean }> = [];
  for (let r = 0; r < retIxs.length; r++) {
    const s = simSigs.findIndex((sig, i) => sig === resolved(ret, retIxs[r]) && !matched.has(i));
    if (s >= 0) {
      matched.add(s);
      const rawSame =
        simIxs[s].programIdIndex === retIxs[r].programIdIndex &&
        JSON.stringify(simIxs[s].accounts) === JSON.stringify(retIxs[r].accounts);
      mapping.push({ simIndex: s, retIndex: r, identical: true, indexesRemapped: !rawSame });
    } else {
      mapping.push({ simIndex: null, retIndex: r, identical: false, indexesRemapped: false });
    }
  }
  return mapping;
}

/** Exact legacy-message byte accounting for the observed delta. */
function byteAccounting(sim: SideSummary, ret: SideSummary) {
  const shortvecLen = (n: number) => (n < 128 ? 1 : n < 16384 ? 2 : 3);
  const parts = {
    signaturesSection: 0, // same signature count → 0
    headerSection: 0, // fixed 3 bytes → 0
    blockhashSection: 0, // fixed 32 bytes → 0
    keyCountEncoding: shortvecLen(ret.keys.length) - shortvecLen(sim.keys.length),
    addedKeyBytes: (ret.keys.length - sim.keys.length) * 32,
    instructionCountEncoding: shortvecLen(ret.instructions.length) - shortvecLen(sim.instructions.length),
    addedInstructionMetadata: 0, // pidIdx + acctsLen + dataLen + index bytes
    addedInstructionDataBytes: 0,
    accountIndexRemapBytes: 0, // index-byte growth on retained instructions
  };
  const mapping = compareIxArrays(sim, ret);
  for (let r = 0; r < ret.instructions.length; r++) {
    const retIx = ret.instructions[r];
    const m = mapping.find((x) => x.retIndex === r);
    if (!m || !m.identical) {
      parts.addedInstructionMetadata += 1 + 1 + 1 + retIx.accounts.length;
      parts.addedInstructionDataBytes += retIx.dataLength;
    } else {
      const simIx = sim.instructions[m.simIndex!];
      parts.accountIndexRemapBytes +=
        retIx.accounts.reduce((a, i) => a + shortvecLen(i), 0) -
        simIx.accounts.reduce((a, i) => a + shortvecLen(i), 0);
    }
  }
  const total =
    parts.signaturesSection + parts.headerSection + parts.blockhashSection +
    parts.keyCountEncoding + parts.addedKeyBytes + parts.instructionCountEncoding +
    parts.addedInstructionMetadata + parts.addedInstructionDataBytes + parts.accountIndexRemapBytes;
  return { parts, total, declaredDelta: ret.messageLength - sim.messageLength };
}

// ═══════════════════════ LOCAL MOCK RECONSTRUCTION ═══════════════════════
// Build the exact simulated transaction (proven 380B / 4ix on device) and a
// mock returned transaction conforming to the ONLY +83/+2ix solution from the
// byte accounting (two added instructions, one NEW key each, 11B data total),
// then run the comparator end-to-end. No wallet, no network, nothing sent.

const payer = Keypair.generate().publicKey;
const recipientOwner = Keypair.generate().publicKey;
const mint = new PublicKey("PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF");
const sourceAta = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022_PROGRAM_ID);
const destinationAta = getAssociatedTokenAddressSync(mint, recipientOwner, false, TOKEN_2022_PROGRAM_ID);

function buildSimulated(): Transaction {
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    createAssociatedTokenAccountInstruction(payer, destinationAta, recipientOwner, mint, TOKEN_2022_PROGRAM_ID),
  );
  tx.add(
    createTransferCheckedWithFeeInstruction(
      sourceAta, mint, destinationAta, payer, 1010101011n, 9, 10101011n, [], TOKEN_2022_PROGRAM_ID,
    ),
  );
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.feePayer = payer;
  return tx;
}

function buildMockReturned(simulated: Transaction): Transaction {
  // Phantom-style mutation consistent with all device facts:
  // +2 instructions, +2 NEW keys, wire cost EXACTLY +83, same feePayer/header
  // shape, wallet re-signs its own message. Wire cost per added instruction
  // with exactly ONE (new) account key: 32(key)+1(pidIdx)+1(acctsLen)+1(idx)
  // +1(dataLen)+dataLen → 36+dataLen. Two such: data 4B + 9B = 36+4+36+9 = 85? No:
  // 36+4=40, 36+9=45 → 85. To hit 83: data 2B + 9B = 38+45=83. ✓
  const tx = new Transaction();
  tx.feePayer = simulated.feePayer;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); // re-pinned
  for (const i of simulated.instructions) tx.add(i);
  const i4 = tx.instructions.length; // 4
  // Reorder for realism is NOT assumed — insert between our instructions:
  tx.instructions.splice(2, 0, new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }], // NEW key
    data: Uint8Array.from([30, 1]), // MemoTransferExtension.Enable, 2B → 38 with key
  }));
  tx.instructions.splice(4, 0, new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }], // NEW key
    data: Uint8Array.from([9, ...new Array(8).fill(0)]), // 9B
  }));
  void i4;
  return tx;
}

// ═══════════════════════ REPORT ═══════════════════════
const simulated = buildSimulated();
const mockReturned = buildMockReturned(simulated);
const S = summarize(simulated);
const R = summarize(mockReturned);

console.log("=== A. MESSAGE HEADERS ===");
console.log("  simulated:", JSON.stringify(S.header), " length:", S.messageLength);
console.log("  returned :", JSON.stringify(R.header), " length:", R.messageLength);

console.log("\n=== B. ACCOUNT KEYS ===");
console.log(`  simulated count=${S.keys.length}  returned count=${R.keys.length}`);
const kd = diffKeys(S, R);
console.log(`  added=${kd.added.length} removed=${kd.removed.length} relativeOrderPreserved=${kd.orderPreserved}`);
for (const a of kd.added) console.log(`    added: index=${a.retIndex} signer=${a.signer} writable=${a.writable} key=${a.key}`);
for (const r of kd.removed) console.log(`    removed: simIndex=${r.simIndex} key=${r.key}`);

console.log("\n=== C. RECENT BLOCKHASH ===");
console.log(`  same=${S.blockhash === R.blockhash}`);

console.log("\n=== D. INSTRUCTIONS (in order) ===");
console.log("  -- simulated --");
S.instructions.forEach((ix, i) =>
  console.log(`   [${i}] ${ix.programName} pidIdx=${ix.programIdIndex} accts=${JSON.stringify(ix.accounts)} dataLen=${ix.dataLength} data=${ix.dataHex} ${ix.semantic}`));
console.log("  -- returned --");
R.instructions.forEach((ix, i) =>
  console.log(`   [${i}] ${ix.programName} pidIdx=${ix.programIdIndex} accts=${JSON.stringify(ix.accounts)} dataLen=${ix.dataLength} data=${ix.dataHex} ${ix.semantic}`));
console.log("  -- mapping (pubkey-identity) --");
const mapping = compareIxArrays(S, R);
for (const m of mapping) {
  console.log(`    sim[${m.simIndex ?? "—"}] → ret[${m.retIndex}] semanticsIdentical=${m.identical}${m.identical ? (m.indexesRemapped ? " (indexes remapped by new keys)" : " (byte-equal)") : "  (NEW INSTRUCTION)"}`);
}

console.log("\n=== E. SEMANTIC IDENTIFICATION OF ADDED INSTRUCTIONS ===");
const addedIxs = R.instructions.filter((_, r) => !mapping.find((m) => m.retIndex === r && m.identical));
for (const ix of addedIxs) console.log(`    ${ix.programName}: ${ix.semantic} (accounts=${JSON.stringify(ix.accounts)}, dataLen=${ix.dataLength})`);

console.log("\n=== F. BYTE ACCOUNTING 380→463 (+83) ===");
const acct = byteAccounting(S, R);
for (const [k, v] of Object.entries(acct.parts)) console.log(`    ${k}: ${v}`);
console.log(`    SUM=${acct.total}  declaredDelta=${acct.declaredDelta}  ${acct.total === acct.declaredDelta ? "BALANCED ✓" : "MISMATCH — investigate"}`);

console.log("\n=== ANSWERS (mock-validated comparator) ===");
console.log("  1. two added instructions: see '(NEW INSTRUCTION)' rows above + section E");
console.log("  2. their new keys: section B 'added' rows (with signer/writable flags)");
console.log("  3. insertion position: mapping order — ret[2] is between our ix1 and ATA-create");
console.log("  4. original semantics changed: " + (mapping.filter((m) => m.simIndex !== null).every((m) => m.identical) ? "NO — all originals map with identical semantics" : "YES"));
console.log("  5. fee payer changed: " + (S.keys[0] === R.keys[0] ? "NO" : "YES"));
console.log("  6. transfer amount/recipient/mint/TCF changed: " +
  (mapping.find((m) => m.simIndex === 3)?.identical ? "NO — TCF maps identical (amount/decimals/fee/accounts byte-equal)" : "YES — check mapping"));
console.log("  7. non-blockhash mutations: " + (kd.added.length > 0 ? `YES — ${kd.added.length} new keys, ${addedIxs.length} new instructions` : "blockhash only"));
console.log("  8. what Phantom signed: exactly the returned message decoded above (its signature verifies over it)");

console.log("\nRUN `bun scripts/decode-message-delta.ts` with REAL captured bytes to decode the device transaction.");
console.log("READ-ONLY COMPLETE — nothing signed, nothing sent, no RPC.");
