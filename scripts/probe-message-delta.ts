/**
 * TEMPORARY LOCAL ANALYSIS (attempt #6b) — exact per-addition byte costs.
 * Measures the message-length delta of EACH candidate wallet-side addition
 * against the pinned 380-byte simulated transaction. No bytes/keys printed.
 */
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedWithFeeInstruction,
} from "@solana/spl-token";

const payer = Keypair.generate().publicKey;
const recipientOwner = Keypair.generate().publicKey;
const mint = new PublicKey("PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF");
const sourceAta = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022_PROGRAM_ID);
const destinationAta = getAssociatedTokenAddressSync(mint, recipientOwner, false, TOKEN_2022_PROGRAM_ID);

function simulated(): Transaction {
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    createAssociatedTokenAccountInstruction(
      payer, destinationAta, recipientOwner, mint, TOKEN_2022_PROGRAM_ID,
    ),
  );
  const transfer = createTransferCheckedWithFeeInstruction(
    sourceAta, mint, destinationAta, payer, 1010101011n, 9, 10101011n, [], TOKEN_2022_PROGRAM_ID,
  );
  tx.add(transfer);
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.feePayer = payer;
  return tx;
}

const BASE_LEN = simulated().serializeMessage().length;
const BASE_IX = simulated().instructions.length;
console.log(`BASE: instructions=${BASE_IX} messageLength=${BASE_LEN} (device simulated=380 → ${BASE_LEN === 380 ? "EXACT MATCH" : "MISMATCH"})`);

function delta(label: string, mutate: (tx: Transaction) => void): number {
  const tx = simulated();
  mutate(tx);
  const len = tx.serializeMessage().length;
  const ix = tx.instructions.length;
  console.log(`  ${label.padEnd(44)} Δbytes=${String(len - BASE_LEN).padStart(4)} ix=${ix}`);
  return len - BASE_LEN;
}

const newKey = () => Keypair.generate().publicKey;

console.log("\n== single-addition costs ==");
delta("wallet compute pair (limit+price, prepend)", (tx) => {
  tx.instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    ...tx.instructions,
  ];
});
delta("1 reallocate (existing keys only)", (tx) => {
  tx.add(new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
    ],
    data: Uint8Array.from([18, 0]),
  }));
});
delta("1 ix, 1 NEW key, 2B data", (tx) => {
  tx.add(new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: newKey(), isSigner: false, isWritable: false }],
    data: Uint8Array.from([18, 0]),
  }));
});
delta("1 ix, 0 new keys, 9B data (compute-like)", (tx) => {
  tx.add(new TransactionInstruction({
    programId: ComputeBudgetProgram.programId,
    keys: [],
    data: Uint8Array.from([3, ...new Array(8).fill(1)]),
  }));
});
delta("append 1 hook-style key to transfer ix", (tx) => {
  tx.instructions[tx.instructions.length - 1].keys.push({
    pubkey: newKey(), isSigner: false, isWritable: false,
  });
});

console.log("\n== additional candidate primitives (uniqueness check) ==");
const dReallocNewPda = delta("1× reallocate + hook-PDA (1 NEW key, 3B data)", (tx) => {
  tx.add(new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: newKey(), isSigner: false, isWritable: false }, // ExtraAccountMetaList PDA
    ],
    data: Uint8Array.from([18, 0, 0]),
  }));
});
const dMemo47 = delta("1× memo program (NEW key) + 47B text", (tx) => {
  tx.add(new TransactionInstruction({
    programId: newKey(), // MemoSq4g… style NEW program key
    keys: [],
    data: new Uint8Array(47),
  }));
});
const dTwoNew11 = delta("1× ix with 2 NEW keys, 11B data", (tx) => {
  tx.add(new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [
      { pubkey: newKey(), isSigner: false, isWritable: false },
      { pubkey: newKey(), isSigner: false, isWritable: false },
    ],
    data: new Uint8Array(11),
  }));
});
const dPriceOnly = delta("1× setComputeUnitPrice only (existing program)", (tx) => {
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
});
const dLimitOnly = delta("1× setComputeUnitLimit only (existing program)", (tx) => {
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
});
console.log(`  combos: reallocPDA+memo47=${dReallocNewPda + dMemo47}, twoNew11+price=${dTwoNew11 + dPriceOnly}, twoNew11+limit=${dTwoNew11 + dLimitOnly}`);

console.log("\n== two-addition combinations summing to +83 ==");
const dPair = delta("A: wallet compute pair alone", (tx) => {
  tx.instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    ...tx.instructions,
  ];
});
const dRealloc = delta("B: 2× reallocate pair alone", (tx) => {
  for (const ext of [0, 1]) {
    tx.add(new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        { pubkey: destinationAta, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: false },
      ],
      data: Uint8Array.from([18, ext]),
    }));
  }
});
console.log(`  A+B = ${dPair + dRealloc} (need 83)`);
const dOneNewKey2B = delta("C: 1 ix with 1 NEW key, 2B data (reallocate-PDA shape)", (tx) => {
  tx.add(new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: newKey(), isSigner: false, isWritable: false }],
    data: Uint8Array.from([18, 0]),
  }));
});
const dOneNewKey9B = delta("D: 1 ix with 1 NEW key, 9B data", (tx) => {
  tx.add(new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: newKey(), isSigner: false, isWritable: false }],
    data: Uint8Array.from([9, ...new Array(8).fill(2)]),
  }));
});
console.log(`  C+D = ${dOneNewKey2B + dOneNewKey9B} (need 83)`);

console.log("\n== header/keys composition of base (facts only) ==");
const baseTx = simulated();
baseTx.sign(Keypair.generate()); // local throwaway, to compile identical signed form
const compiled = baseTx.compileMessage();
console.log("  header:", JSON.stringify(compiled.header));
console.log("  accountKeys.length:", compiled.accountKeys.length);
console.log("  compiledInstructions:", compiled.instructions.length);

console.log("\nLOCAL DECOMPOSITION COMPLETE — nothing signed by a wallet, nothing sent, no RPC.");
