/**
 * READ-ONLY diagnostic (P0 economics): measures the LIVE on-chain facts needed
 * to price one real OPENAI PreStock transfer. No transaction is built, signed,
 * or sent. No account is created. Only RPC reads. Production code untouched.
 *
 * Run: bun scripts/diagnose-transfer-economics.ts [ownerAddress] [recipientAddress]
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { connection as rpc } from "../src/lib/solana/connection";
import { inspectMint } from "../src/lib/solana/inspectMint";
import { calculateExactOut } from "../src/lib/solana/exactOut";
import * as spl from "@solana/spl-token";

const MINT = new PublicKey("PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF"); // OPENAI
const OWNER_ARG = process.argv[2] ?? "";
const RECIPIENT_ARG = process.argv[3] ?? "";

const lam = (n: number | bigint) => `${n} lamports = ${(Number(n) / 1e9).toFixed(9)} SOL`;

function isPlausiblePubkey(s: string): boolean {
  try {
    return new PublicKey(s.trim()).toBase58() === s.trim();
  } catch {
    return false;
  }
}

// ── B. Mint requirements (live) ────────────────────────────────────────────
console.log("== B. OPENAI mint (live) ==");
const info = await rpc.getAccountInfo(MINT);
if (!info) throw new Error("mint not found");
console.log("  program       :", info.owner.toBase58());
console.log("  is Token-2022 :", info.owner.equals(TOKEN_2022_PROGRAM_ID));
console.log("  mint data len :", info.data.length, "bytes");
const rentMint = await rpc.getMinimumBalanceForRentExemption(info.data.length);
console.log("  mint rent     :", lam(rentMint), "(context only — issuer paid)");

const mint = await inspectMint(rpc, MINT);
console.log("  decimals      :", mint.decimals);
console.log("  extensions    :", mint.extensions.join(", "));
console.log("  hook active   :", mint.activeTransferHook, mint.transferHookProgramId ?? "");
console.log("  paused        :", mint.paused, "| default account state:", mint.defaultAccountState);
const cfg = mint.transferFeeConfig;
if (!cfg) throw new Error("no TransferFeeConfig — exact-out undefined");
const tier =
  cfg.currentEpoch >= cfg.newerTransferFee.epoch
    ? cfg.newerTransferFee
    : cfg.olderTransferFee;
console.log(
  `  live tier     : ${tier.transferFeeBasisPoints} bps (tier epoch ${tier.epoch}, current ${cfg.currentEpoch}) maxFee ${tier.maximumFee}`,
);
if (tier.maximumFee === "18446744073709551615") {
  console.log("  maxFee note   : u64::MAX → fee effectively UNCAPPED (always proportional)");
}

// ── C/D pre-req: exact ATA space + rent ───────────────────────────────────
// Method 1 — SDK TLV parse (unpackMint works; only getAccountLenForMint's
// account-side mapping lacks a case for one unknown extension id).
console.log("\n== ATA space & rent (independent measurements) ==");
const mintAcc = spl.unpackMint(MINT, info, info.owner);
const extTypes = spl.getExtensionTypes(mintAcc.tlvData);
console.log("  mint TLV bytes:", mintAcc.tlvData.length, "| extension types:", extTypes.join(", "));
let computedLen = 165 + 1; // base account + account-type byte
const known: string[] = [];
const unknown: number[] = [];
for (const t of extTypes) {
  let acct: number | undefined;
  try {
    acct = spl.getAccountTypeOfMintType(t);
  } catch {
    acct = undefined;
  }
  // Uninitialized = mint-only extension, NO account-side counterpart: skip.
  if (acct === undefined) {
    unknown.push(t);
    continue;
  }
  if (acct === spl.ExtensionType.Uninitialized) continue;
  try {
    computedLen += 4 + spl.getTypeLen(acct); // TYPE_SIZE(2)+LENGTH_SIZE(2) + payload
    known.push(`${spl.ExtensionType[acct]}(+${4 + spl.getTypeLen(acct)}B)`);
  } catch {
    unknown.push(t);
  }
}
console.log("  account-side (known)  :", known.join(", ") || "none");
if (unknown.length) console.log("  account-side (unknown): ids", unknown.join(", "), "— excluded from computed length");
console.log("  computed ATA data length :", computedLen, "bytes");
const rentComputed = await rpc.getMinimumBalanceForRentExemption(computedLen);
console.log("  ATA rent (computed)      :", lam(rentComputed));

// Method 2 — GROUND TRUTH: measure a REAL OPENAI token account without any
// indexed API. The mint's TransferFeeConfig authority (issuer treasury) must
// hold OPENAI; its ATA is derived deterministically and getAccountInfo (non-
// indexed, browser-safe RPC) returns its true on-chain data length.
let measuredLen: number | null = null;
const authorityStr = cfg.transferFeeConfigAuthority || cfg.withdrawWithheldAuthority;
if (authorityStr) {
  const authority = new PublicKey(authorityStr);
  const probeAta = getAssociatedTokenAddressSync(MINT, authority, true, TOKEN_2022_PROGRAM_ID);
  const probe = await rpc.getAccountInfo(probeAta);
  if (probe && probe.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    measuredLen = probe.data.length;
    console.log("\n  real OPENAI ATA found (fee authority):", probeAta.toBase58());
    console.log("  measured ATA data length :", measuredLen, "bytes");
    const rentMeasured = await rpc.getMinimumBalanceForRentExemption(measuredLen);
    console.log("  ATA rent (measured)      :", lam(rentMeasured));
  } else {
    console.log("\n  fee-authority ATA probe not present (probe:", probeAta.toBase58() + ")");
  }
}
if (measuredLen !== null && measuredLen !== computedLen) {
  console.log("  ⚠ measured ≠ computed — the unknown extension contributes space; measured is ground truth");
}
const ataLen = measuredLen ?? computedLen;
const rentAta = await rpc.getMinimumBalanceForRentExemption(ataLen);

// ── C. Sender ATA status ───────────────────────────────────────────────────
console.log("\n== C. Sender (connected Phantom wallet) ==");
if (!isPlausiblePubkey(OWNER_ARG)) {
  console.log("  (no canonical owner address supplied — pass as argv[2])");
} else {
  const owner = new PublicKey(OWNER_ARG);
  const ata = getAssociatedTokenAddressSync(MINT, owner, false, TOKEN_2022_PROGRAM_ID);
  console.log("  owner      :", owner.toBase58());
  console.log("  OPENAI ATA :", ata.toBase58());
  const acc = await rpc.getAccountInfo(ata);
  console.log("  exists     :", acc ? "YES" : "NO → any swap/transfer must initialize it (rent + create ix)");
  if (acc) {
    console.log("    lamports :", acc.lamports, "dataLen:", acc.data.length, "owner:", acc.owner.toBase58());
  } else {
    console.log("  creation rent:", lam(rentAta));
  }
  const sol = await rpc.getBalance(owner, "confirmed");
  console.log("  owner SOL  :", lam(sol));
}

// ── D. Recipient ATA status ────────────────────────────────────────────────
console.log("\n== D. Recipient (current test recipient) ==");
if (!isPlausiblePubkey(RECIPIENT_ARG)) {
  console.log("  (no canonical recipient address supplied — pass as argv[3])");
} else {
  const rec = new PublicKey(RECIPIENT_ARG);
  const ata = getAssociatedTokenAddressSync(MINT, rec, false, TOKEN_2022_PROGRAM_ID);
  console.log("  recipient  :", rec.toBase58());
  console.log("  OPENAI ATA :", ata.toBase58());
  const acc = await rpc.getAccountInfo(ata);
  if (acc) {
    const d = acc.data;
    const amount = d.length >= 72 ? d.subarray(64, 72) : null;
    console.log(
      "  exists     : YES | program ok:",
      acc.owner.equals(TOKEN_2022_PROGRAM_ID),
      "| mint ok:",
      d.subarray(0, 32).equals(MINT.toBytes()),
      "| balance:",
      amount ? BigInt("0x" + Buffer.from(amount).toString("hex")).toString() : "?",
      `(${acc.lamports} lamports, len ${d.length})`,
    );
  } else {
    console.log("  exists     : NO → ReynaLens creates it inside the transfer (rent + create ix)");
    console.log("  creation rent:", lam(rentAta));
  }
}

// ── E. Transaction fee (live, builder's exact shape) ──────────────────────
console.log("\n== E. Transaction fee (live, builder's exact shape) ==");
const { blockhash } = await rpc.getLatestBlockhash("confirmed");
const shapePayer = PublicKey.unique();
const msg = new TransactionMessage({
  payerKey: shapePayer,
  recentBlockhash: blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    SystemProgram.transfer({ fromPubkey: shapePayer, toPubkey: PublicKey.unique(), lamports: 1 }),
  ],
}).compileToV0Message();
const feeResp = await rpc.getFeeForMessage(msg, "confirmed");
console.log("  getFeeForMessage:", feeResp.value, "lamports (base + priority @ pinned budget)");
const est = await (await import("../src/lib/solana/balance")).estimateTransactionFeeLamports(rpc);
console.log("  app estimator   :", est, "lamports (estimator output incl. 2x margin)");

// ── F. Minimum viable exact-out cases (pure integer math) ─────────────────
console.log("\n== F. Minimum OPENAI economics (9 decimals, live 100 bps) ==");
for (const net of [1n, 2n, 10n, 100n, 1_000n]) {
  try {
    const out = calculateExactOut({
      net,
      decimals: mint.decimals,
      feeBps: tier.transferFeeBasisPoints,
      maximumFee: BigInt(tier.maximumFee),
      tierEpoch: tier.epoch,
    });
    console.log(
      `  net ${String(net).padStart(5)} → gross ${String(out.gross).padStart(5)} (fee ${out.fee}) — ${out.gross - out.fee === out.net ? "invariant OK" : "INVARIANT FAIL"}`,
    );
  } catch (e) {
    console.log(`  net ${net} → ERROR: ${e instanceof Error ? e.message : e}`);
  }
}
console.log("\nREAD-ONLY COMPLETE — nothing created, nothing signed, nothing sent.");
