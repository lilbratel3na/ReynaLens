import { clusterApiUrl, Connection } from "@solana/web3.js";

/**
 * Single shared Connection for all live mainnet RPC traffic.
 *
 * IMPORTANT (P0 403 fix, do not regress): `https://api.mainnet-beta.solana.com`
 * rejects browser-originated requests with HTTP 403 `Access forbidden` whenever
 * an `Origin` header is present (i.e. every real browser call to
 * `getAccountInfo` / `getEpochInfo` — exactly what `inspectMint` performs on
 * asset selection). Node/CLI calls without an `Origin` header still get 200,
 * which is why earlier CLI verification passed while the deployed preview
 * failed. Therefore the Solana Labs endpoint must never be the primary for the
 * browser app; it is kept only as a Node-side failover.
 *
 * Primary default is `solana-rpc.publicnode.com`: public, CORS-open, no key
 * required, and the endpoint the previously-verified mainnet path (live
 * Token-2022 mint inspection + TransferCheckedWithFee simulation) actually
 * used after the Solana Labs rate limits were hit.
 *
 * Optional override: set VITE_SOLANA_RPC_URL (browser-visible env var, e.g. a
 * Helius/QuickNode mainnet URL) via the project's Keys/API keys UI to use a
 * paid RPC without code changes.
 */

function readBrowserRpcOverride(): string | null {
  // `import.meta.env` is injected by Vite at build time; only VITE_-prefixed
  // vars are exposed to the browser.
  const env =
    (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env ?? {};
  const url = env.VITE_SOLANA_RPC_URL?.trim();
  return url ? url : null;
}

const SOLANA_LABS_PUBLIC = "https://api.mainnet-beta.solana.com";
const PUBLICNODE = "https://solana-rpc.publicnode.com";

const override = readBrowserRpcOverride();

// Failover chain: browser-safe primary first; the Solana Labs public endpoint
// remains last (usable from Node/CLI, 403s from browsers).
const ENDPOINTS: string[] = override
  ? Array.from(new Set([override, PUBLICNODE, SOLANA_LABS_PUBLIC]))
  : [PUBLICNODE, SOLANA_LABS_PUBLIC];

const CONNECTION_CONFIG = {
  commitment: "confirmed" as const,
  wsEndpoint: undefined,
};

let current = 0;
export const connection = new Connection(ENDPOINTS[0], CONNECTION_CONFIG);

/** Simple manual failover helper used by long-running flows. */
export function nextConnection(): Connection {
  current = (current + 1) % ENDPOINTS.length;
  return new Connection(ENDPOINTS[current], CONNECTION_CONFIG);
}

export const PRIMARY_RPC = ENDPOINTS[0];
export const FALLBACK_RPC = ENDPOINTS[1];

export { clusterApiUrl };
