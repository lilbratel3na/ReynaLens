/**
 * TEMPORARY diagnostic panel helpers (P0 Android handoff investigation).
 * Pure functions only — the React panel is a thin renderer over these, which
 * keeps the formatting testable in the node test environment.
 *
 * SAFETY INVARIANT (defensive, not merely conventional): both display rows and
 * the copy/export payload pass through a strict key WHITELIST. Even if a
 * future submitDiag() call site ever recorded something unsafe, it could not
 * reach the screen or the clipboard. Public transaction signatures are
 * expected and allowed; everything else unknown is dropped.
 */

import { readSubmitDiag, summarizeSubmitDiag } from "./submitDiagnostics";

/** Structural shape of one recorded event (mirrors the recorder's storage). */
export type DiagEvent = { t: number; event: string } & Record<string, unknown>;

export interface DiagRow {
  /** Position in the recorded order (0-based). */
  order: number;
  event: string;
  /** Local wall-clock time HH:MM:SS.mmm, or null when the timestamp is absent. */
  time: string | null;
  /** Error class name when the event carries one. */
  name: string | null;
  /** Exact error message when the event carries one. */
  message: string | null;
  /** Public transaction signature when the event carries one. */
  signature: string | null;
}

/**
 * Keys that may ever be shown or exported. Every submitDiag() payload in the
 * codebase is limited to these fields by design; the whitelist enforces it.
 */
const EXPORTABLE_KEYS: ReadonlySet<string> = new Set([
  "t",
  "event",
  "signature", // public transaction signature — explicitly allowed
  "name", // error name
  "message", // error message
  "navigationType", // mount: reload/navigate/back_forward
  "visibility", // pagehide/visibility state
  "txIsLegacy", // sendTransaction:called shape booleans
  "feePayerSet",
  "recentBlockhashSet",
  "instructionCount",
  "guardConsumed", // submit:start guard state
  "kind", // typed SubmitFailure kind
  "actuallyReceived", // receipt:mismatch (stringified bigint)
  "error", // confirm:failed message
]);

/** Drop any non-whitelisted field from recorded events. Order is preserved. */
export function sanitizeEvents(events: DiagEvent[]): Array<Record<string, unknown>> {
  return events.map((e) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(e)) {
      if (EXPORTABLE_KEYS.has(key)) out[key] = e[key];
    }
    return out;
  });
}

/** Local wall-clock "HH:MM:SS.mmm" for a unix-ms timestamp. */
export function formatDiagTime(t: number): string {
  const d = new Date(t);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const p3 = (n: number) => String(n).padStart(3, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

function readString(e: DiagEvent, key: string): string | null {
  const v = e[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Normalize recorded events into display rows (same order, one row each). */
export function formatDiagRows(events: DiagEvent[]): DiagRow[] {
  return events.map((e, order) => ({
    order,
    event: e.event,
    time: typeof e.t === "number" ? formatDiagTime(e.t) : null,
    name: readString(e, "name"),
    message: readString(e, "message"),
    signature: readString(e, "signature"),
  }));
}

/** First line shown in the panel: counts + the smoking-gun detector result. */
export function formatDiagSummaryLine(summary: {
  events: number;
  lastEvent: string | null;
  unresolvedSend: boolean;
  calledAt: number | null;
}): string {
  const last = summary.lastEvent ?? "—";
  const unresolved = summary.unresolvedSend
    ? "UNRESOLVED SEND — the page died while the wallet promise was pending"
    : "no unresolved send";
  return `events=${summary.events} last=${last} | ${unresolved}`;
}

/**
 * Clipboard/export payload: safe JSON (whitelisted fields only) with the
 * summary embedded. This is what "Copy diagnostics" writes.
 */
export function buildDiagExport(now: number = Date.now()): string {
  const events = readSubmitDiag() as DiagEvent[];
  return JSON.stringify(
    {
      generatedAt: new Date(now).toISOString(),
      summary: summarizeSubmitDiag(),
      events: sanitizeEvents(events),
    },
    null,
    2,
  );
}
