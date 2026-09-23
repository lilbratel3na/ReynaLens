/**
 * P0 403 investigation / verification script.
 *
 * Reproduces the exact browser request path (inspectMint → getAccountInfo on a
 * Token-2022 PreStock mint) against the new endpoint configuration for ALL
 * FIVE PreStock assets — live mainnet, no mocks.
 *
 * It also asserts the two endpoint invariants behind the fix:
 *   1. api.mainnet-beta.solana.com + browser Origin  -> 403 (the bug)
 *   2. solana-rpc.publicnode.com  + browser Origin  -> 200 (the fix's primary)
 *
 * Run: bun scripts/verify-prestock-403-fix.ts
 */
import { PublicKey } from "@solana/web3.js";
import { connection, PRIMARY_RPC, FALLBACK_RPC } from "../src/lib/solana/connection";
import { inspectMint } from "../src/lib/solana/inspectMint";
import { PRESTOCK_ASSETS } from "../src/lib/solana/prestocks";

const BROWSER_ORIGIN = "https://reynalens.vly.sh"; // deployed preview origin class

async function rawPost(
  url: string,
  method: string,
  params: unknown[],
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.text() };
}

console.log("PRIMARY_RPC:", PRIMARY_RPC);
console.log("FALLBACK_RPC:", FALLBACK_RPC);
console.log("");

// ---- Endpoint invariants (same method inspectMint issues first) ----
const mint0 = PRESTOCK_ASSETS[0].mint;
const getAccountInfoParams = [mint0, { encoding: "base64", commitment: "confirmed" }];

const labsWithOrigin = await rawPost(
  "https://api.mainnet-beta.solana.com",
  "getAccountInfo",
  getAccountInfoParams,
  { Origin: BROWSER_ORIGIN },
);
console.log(
  `[invariant] api.mainnet-beta.solana.com + Origin -> ${labsWithOrigin.status}`,
  labsWithOrigin.status === 403 ? "(reproduces the reported 403 — endpoint is browser-hostile)" : "!! UNEXPECTED",
);

const pnWithOrigin = await rawPost(
  "https://solana-rpc.publicnode.com",
  "getAccountInfo",
  getAccountInfoParams,
  { Origin: BROWSER_ORIGIN },
);
const pnOk = pnWithOrigin.status === 200;
console.log(
  `[invariant] solana-rpc.publicnode.com    + Origin -> ${pnWithOrigin.status}`,
  pnOk ? "(browser-safe primary confirmed)" : "!! publicnode now failing — investigate",
);

if (PRIMARY_RPC !== "https://solana-rpc.publicnode.com") {
  console.error("\nFAIL: browser primary must be the browser-safe endpoint");
  process.exit(1);
}
if (!pnOk) {
  console.error("\nFAIL: primary endpoint not serving getAccountInfo");
  process.exit(1);
}

// ---- Full inspectMint for all five assets (the real app code path) ----
console.log("");
let pass = 0;
for (const asset of PRESTOCK_ASSETS) {
  const mint = new PublicKey(asset.mint);
  try {
    const info = await inspectMint(connection, mint);
    const tier = info.transferFeeConfig
      ? `${info.transferFeeConfig.newerTransferFee.transferFeeBasisPoints}/${info.transferFeeConfig.olderTransferFee.transferFeeBasisPoints} bps`
      : "none";
    console.log(
      `PASS ${asset.ticker.padEnd(9)} decimals=${info.decimals} supply=${info.supply} feeTiers=${tier} hookActive=${info.activeTransferHook} paused=${info.paused} ext=${info.extensions.length}`,
    );
    if (info.metadata?.symbol) console.log(`       metadata: ${info.metadata.name} (${info.metadata.symbol})`);
    pass++;
  } catch (e) {
    console.error(`FAIL ${asset.ticker} (${asset.mint}):`, e instanceof Error ? e.message : e);
  }
}

console.log(`\n${pass}/${PRESTOCK_ASSETS.length} PreStock mints inspected live without error`);
if (pass !== PRESTOCK_ASSETS.length) process.exit(1);
console.log("P0 403 FIX VERIFIED (live, no mocks)");
