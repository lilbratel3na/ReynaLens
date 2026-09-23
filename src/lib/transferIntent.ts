/**
 * Session-scoped persistence of the user's IN-PROGRESS transfer intent.
 *
 * Purpose (P0): mobile wallet deep links and normal Android/iOS/desktop page
 * lifecycles can unmount or reload AppPage (Phantom handoff, tab switch,
 * memory pressure). Without persistence the user lost their selected asset,
 * recipient and amount and was thrown back to an empty Compose screen.
 *
 * What is stored — ONLY the user's own input intent:
 *   selected mint, recipient address, requested exact amount, phase.
 *
 * What is NEVER stored:
 *   private keys / seeds (there are none in this app), wallet authorization
 *   secrets, simulated or fabricated results, and NO chain-derived values
 *   (gross, fee, fee tier, balances). Everything chain-derived is recomputed
 *   LIVE from Solana on restore — the stored intent is a pointer to intent,
 *   never an authoritative source of chain state.
 *
 * Scope: sessionStorage — survives reloads and deep-link round trips within
 * the tab session, and is naturally cleared when the session ends. Works
 * identically on Android, iOS, tablet and desktop browsers.
 */

export interface TransferIntent {
  mint: string;
  recipient: string;
  amount: string;
  phase: "compose" | "preview";
}

const KEY = "reynalens.intent.v1";

function defaultStorage(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : undefined;
  } catch {
    return undefined; // storage can throw in some private-mode browsers
  }
}

export function saveTransferIntent(intent: TransferIntent, storage?: Storage): void {
  const s = storage ?? defaultStorage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify({ v: 1, ...intent }));
  } catch {
    /* persistence is best-effort; never block the flow */
  }
}

/** Read + validate the stored intent; anything malformed is discarded. */
export function loadTransferIntent(storage?: Storage): TransferIntent | null {
  const s = storage ?? defaultStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    const mint = typeof o.mint === "string" ? o.mint : "";
    const recipient = typeof o.recipient === "string" ? o.recipient : "";
    const amount = typeof o.amount === "string" ? o.amount : "";
    const phase = o.phase === "preview" ? "preview" : o.phase === "compose" ? "compose" : null;
    if (!mint || !recipient || !amount || phase === null) return null;
    return { mint, recipient, amount, phase };
  } catch {
    return null;
  }
}

export function clearTransferIntent(storage?: Storage): void {
  const s = storage ?? defaultStorage();
  if (!s) return;
  try {
    s.removeItem(KEY);
  } catch {
    /* best-effort */
  }
}
