import { clusterApiUrl, Connection } from "@solana/web3.js";

/**
 * Single shared Connection. Public mainnet endpoints are used so the demo
 * works without any API key; swap the first entry for a paid RPC (e.g.
 * Helius/QuickNode) in production.
 */
const ENDPOINTS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];

let current = 0;
export const connection = new Connection(ENDPOINTS[0], {
  commitment: "confirmed",
  wsEndpoint: undefined,
});

/** Simple manual failover helper used by long-running flows. */
export function nextConnection(): Connection {
  current = (current + 1) % ENDPOINTS.length;
  return new Connection(ENDPOINTS[current], { commitment: "confirmed" });
}

export const PRIMARY_RPC = ENDPOINTS[0];
export const FALLBACK_RPC = ENDPOINTS[1];

export { clusterApiUrl };
