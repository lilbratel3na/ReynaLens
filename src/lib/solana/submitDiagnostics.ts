/**
 * TEMPORARY DIAGNOSTIC — wallet-handoff trace (P0: Android sendTransaction
 * investigation). Read-only with respect to product behavior: every function
 * here is passive recording. Remove after the handoff failure is diagnosed.
 *
 * Why localStorage (not sessionStorage): the suspected failure mode is the
 * Android deep-link handoff RELOADING the page. A trace written before the
 * navigation must survive into the fresh context so it can be read on return.
 * Recorded data: event names, timestamps, booleans/numbers, error names and
 * messages, and the PUBLIC transaction signature. Never private keys, seeds,
 * or wallet secrets (this app never holds any).
 */

const KEY = "reynalens.submitDiag.v1";
const MAX_EVENTS = 120;

type SubmitDiagEvent = Record<string, unknown> & { t: number; event: string };

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Record one diagnostic event. Never throws. */
export function submitDiag(event: string, data: Record<string, unknown> = {}): void {
  try {
    const entry: SubmitDiagEvent = { t: Date.now(), event, ...data };
    // Mirror to console first: if persistence fails we still have the trace.
    console.info("[submitDiag]", event, data);
    const s = safeStorage();
    if (!s) return;
    const raw = s.getItem(KEY);
    const list: SubmitDiagEvent[] = raw ? JSON.parse(raw) : [];
    list.push(entry);
    while (list.length > MAX_EVENTS) list.shift();
    s.setItem(KEY, JSON.stringify(list));
  } catch {
    /* diagnostics must never break the flow */
  }
}

/** Read the full ordered trace (oldest first). Empty on any error. */
export function readSubmitDiag(): SubmitDiagEvent[] {
  try {
    const s = safeStorage();
    const raw = s?.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SubmitDiagEvent[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function clearSubmitDiag(): void {
  try {
    safeStorage()?.removeItem(KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * The smoking-gun detector: was there a sendTransaction:called with NO
 * following resolved/caught/finally? True means the page context died while
 * the wallet promise was pending (reload/navigation orphaned it).
 */
export function summarizeSubmitDiag(): {
  events: number;
  lastEvent: string | null;
  unresolvedSend: boolean;
  calledAt: number | null;
} {
  const list = readSubmitDiag();
  const calledIdx = list.map((e) => e.event).lastIndexOf("sendTransaction:called");
  const after = calledIdx >= 0 ? list.slice(calledIdx + 1) : [];
  const closed = after.some((e) =>
    ["sendTransaction:resolved", "submit:caught", "submit:finally"].includes(e.event),
  );
  return {
    events: list.length,
    lastEvent: list.length ? list[list.length - 1].event : null,
    unresolvedSend: calledIdx >= 0 && !closed,
    calledAt: calledIdx >= 0 ? list[calledIdx].t : null,
  };
}

/**
 * Passive adapter listeners: record 'disconnect' and 'error' emissions with
 * names/messages only. Returns a detach function.
 */
export function attachSubmitAdapterDiagnostics(adapter: {
  on: (event: string, cb: (e?: unknown) => void) => void;
  off: (event: string, cb: (e?: unknown) => void) => void;
} | null): () => void {
  if (!adapter) return () => undefined;
  const nameOf = (e: unknown): string | null =>
    e instanceof Error ? e.name : e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : null;
  const msgOf = (e: unknown): string | null =>
    e instanceof Error ? e.message : typeof e === "string" ? e : null;
  const onDisconnect = () => submitDiag("adapter:event:disconnect");
  const onError = (e?: unknown) =>
    submitDiag("adapter:event:error", { name: nameOf(e), message: msgOf(e) });
  try {
    adapter.on("disconnect", onDisconnect);
    adapter.on("error", onError);
    return () => {
      try {
        adapter.off("disconnect", onDisconnect);
        adapter.off("error", onError);
      } catch {
        /* best-effort */
      }
    };
  } catch {
    return () => undefined;
  }
}

/**
 * Passive page-lifecycle recording. Distinguishes a reload/navigation during
 * the handoff: 'pagehide' persists BEFORE the context dies, and the next
 * mount reads `performance.navigation` type. Returns a detach function.
 */
export function attachSubmitLifecycleDiagnostics(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onPageHide = () => submitDiag("lifecycle:pagehide", { visibility: document.visibilityState });
  const onVisible = () =>
    submitDiag("lifecycle:visibility", {
      visibility: document.visibilityState,
    });
  try {
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisible);
    };
  } catch {
    return () => undefined;
  }
}

/** Navigation type of the CURRENT context (reload vs navigate vs back_forward). */
export function currentNavigationType(): string {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav?.type ?? "unknown";
  } catch {
    return "unknown";
  }
}
