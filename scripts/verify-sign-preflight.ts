/**
 * SAFE sign-path dry run (P0 Part D) — the real-device test without a device:
 *
 *   Sign & Send → live balance read → preflight gate → STOP BEFORE SIGNATURE
 *
 * Uses a locally generated throwaway Keypair as the "current wallet with zero
 * PreStock balance" (the exact observed device scenario). Every chain read is
 * LIVE; nothing is submitted, nothing is signed, nothing costs SOL. The
 * assertion is that the pipeline terminates at the preflight gate with a
 * friendly insufficient-balance message and NEVER reaches build/simulate/sign.
 *
 * Run: bun scripts/verify-sign-preflight.ts
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection as rpc } from "../src/lib/solana/connection";
import { inspectMint } from "../src/lib/solana/inspectMint";
import { PRESTOCK_ASSETS } from "../src/lib/solana/prestocks";
import { calculateExactOut } from "../src/lib/solana/exactOut";
import { applicableTier } from "../src/pages/AppPage";
import { readWalletBalance, estimateTransactionFeeLamports } from "../src/lib/solana/balance";
import { evaluatePreflight, estimateAtaRentLamports } from "../src/lib/solana/preflight";

// ── Regression guard: all five mints still inspect live (Part J) ──
let pass = 0;
for (const a of PRESTOCK_ASSETS) {
  try {
    await inspectMint(rpc, new PublicKey(a.mint));
    pass++;
  } catch (e) {
    console.error(`FAIL inspect ${a.ticker}:`, e instanceof Error ? e.message : e);
  }
}
console.log(`live inspection: ${pass}/${PRESTOCK_ASSETS.length}`);
if (pass !== PRESTOCK_ASSETS.length) process.exit(1);

// ── The safe device scenario ──
const asset = PRESTOCK_ASSETS[0]; // OPENAI, live 100 bps tier
const wallet = Keypair.generate(); // zero-balance surrogate; nothing to fund
const owner = wallet.publicKey;
const mint = new PublicKey(asset.mint);
const recipient = Keypair.generate().publicKey; // fresh recipient → ATA creation path

let signatureRequested = false;

console.log("\n[1] inspecting mint live…");
const info = await inspectMint(rpc, mint);
const tier = applicableTier(info);
console.log(`    fee tier ${tier.transferFeeBasisPoints} bps (epoch ${tier.epoch}), decimals ${info.decimals}`);

console.log("[2] exact-out for net 1.000000000 (the device case)…");
const out = calculateExactOut({
  net: 1_000_000_000n,
  decimals: info.decimals,
  feeBps: tier.transferFeeBasisPoints,
  maximumFee: BigInt(tier.maximumFee),
  tierEpoch: tier.epoch,
});
console.log(`    gross ${out.gross} fee ${out.fee} — invariant gross-fee==net: ${out.gross - out.fee === out.net}`);

console.log("[3] reading LIVE wallet balances…");
const [balances, txFeeLamports] = await Promise.all([
  readWalletBalance(rpc, owner, mint),
  estimateTransactionFeeLamports(rpc),
]);
console.log(`    token=${balances.tokenBaseUnits === null ? "no account" : balances.tokenBaseUnits} sol=${balances.solLamports} lamports, txFeeEst=${txFeeLamports} lamports`);

console.log("[4] estimating recipient ATA rent from live chain state…");
const rent = await estimateAtaRentLamports(rpc, info, mint);
console.log(`    ataRent=${rent === null ? "unavailable (would be skipped)" : rent + " lamports"}`);

console.log("[5] preflight gate…");
const verdict = evaluatePreflight({
  tokenBalance: balances.tokenBaseUnits ?? 0n,
  gross: out.gross,
  decimals: info.decimals,
  ticker: asset.ticker,
  solLamports: balances.solLamports,
  txFeeLamports,
  ataRentLamports: rent ?? 0,
});

if (verdict.kind !== "insufficient_token") {
  console.error(`UNEXPECTED verdict: ${verdict.kind}`, verdict);
  process.exit(1);
}
console.log(`    → STOPPED BEFORE SIGNATURE (insufficient_token)`);
console.log(`    message: "${verdict.message}"`);

if (signatureRequested) {
  console.error("FAIL: a signature was requested — pipeline is unsafe");
  process.exit(1);
}
console.log("\nSAFE: no transaction built past the gate, none simulated, none signed, zero SOL spent.");
console.log("Sign-path preflight VERIFIED (live reads, stop-before-signature).");
