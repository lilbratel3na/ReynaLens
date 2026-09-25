import { useCallback, useEffect, useState } from "react";
import { Bug } from "lucide-react";
import {
  buildDiagExport,
  formatDiagRows,
  formatDiagSummaryLine,
  type DiagEvent,
} from "@/lib/solana/submitDiagnosticsPanel";
import { readSubmitDiag, summarizeSubmitDiag } from "@/lib/solana/submitDiagnostics";

/**
 * TEMPORARY developer-only diagnostics panel (P0 Android handoff
 * investigation). Debug-only by design — deliberately plain.
 *
 * Reads the recorder's existing localStorage["reynalens.submitDiag.v1"] and
 * renders the ordered events plus the unresolvedSend verdict, with refresh and
 * copy controls. Refresh is the primary control: after returning from the
 * Phantom deep-link round trip (a full reload), tapping Refresh re-reads the
 * persisted trace written BEFORE the reload. Nothing here reads, displays, or
 * copies anything beyond the panel module's strict whitelist.
 *
 * This panel is not part of the transfer flow; it renders nothing until
 * opened, and must be removed once the handoff is diagnosed.
 */

export function SubmitDiagnosticsPanel() {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<DiagEvent[]>([]);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [showExport, setShowExport] = useState(false);

  // Re-read from localStorage. Called on open and by the Refresh control —
  // which is how the panel picks up events recorded before a handoff reload.
  const refresh = useCallback(() => {
    try {
      const list = readSubmitDiag() as DiagEvent[];
      setEvents(Array.isArray(list) ? list : []);
      setCopyState("idle");
    } catch {
      setEvents([]);
    }
  }, []);

  const handleOpen = useCallback(() => {
    refresh(); // read at open time, so the latest trace is shown immediately
    setShowExport(false);
    setOpen((v) => !v);
  }, [refresh]);

  const handleCopy = useCallback(async () => {
    try {
      const json = buildDiagExport();
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
      } else {
        // Clipboard API unavailable (older webviews): textarea fallback.
        const ta = document.createElement("textarea");
        ta.value = json;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, []);

  // While open, keep the rows current with anything the live session records.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(refresh, 1500);
    return () => window.clearInterval(id);
  }, [open, refresh]);

  // Computed at render from the recorder so Refresh (or the polling interval)
  // always reflects the latest persisted trace, including unresolvedSend.
  const summary = summarizeSubmitDiag();
  const summaryLine = formatDiagSummaryLine(summary);
  const unresolved = summary.unresolvedSend;
  const rows = formatDiagRows(events);

  return (
    <div className="fixed inset-x-0 bottom-0 z-[10000] font-mono">
      {!open ? (
        <button
          type="button"
          onClick={handleOpen}
          aria-label="Open submit diagnostics"
          className="fixed bottom-2 right-2 flex items-center gap-1 rounded border border-dashed border-muted-foreground/50 bg-muted/90 px-2 py-1 text-[10px] text-muted-foreground"
        >
          <Bug className="size-3" />
          diag
        </button>
      ) : (
        <div className="max-h-[70dvh] overflow-y-auto border-t-2 border-dashed border-destructive/60 bg-background p-2 text-[11px] leading-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-semibold text-destructive">
              ⚠ TEMP submit diagnostics (debug-only, remove before ship)
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded border px-1.5 py-0.5"
            >
              close
            </button>
          </div>

          <div className="mb-1 flex flex-wrap gap-1">
            <button type="button" onClick={refresh} className="rounded border px-2 py-0.5">
              Refresh diagnostics
            </button>
            <button type="button" onClick={handleCopy} className="rounded border px-2 py-0.5">
              Copy diagnostics
            </button>
            <button
              type="button"
              onClick={() => setShowExport((v) => !v)}
              className="rounded border px-2 py-0.5"
            >
              {showExport ? "hide JSON" : "show JSON"}
            </button>
            {copyState === "copied" && <span className="text-green-600">copied ✓</span>}
            {copyState === "failed" && <span className="text-destructive">copy failed</span>}
          </div>

          {showExport ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1 text-[10px]">
              {buildDiagExport()}
            </pre>
          ) : (
            <>
              <div className={unresolved ? "text-destructive" : "text-muted-foreground"}>
                {summaryLine || "tap Refresh diagnostics"}
              </div>
              <ol className="mt-1 space-y-0.5">
                {rows.map((r) => (
                  <li key={r.order} className="break-all border-b border-border/40 pb-0.5">
                    <span className="text-muted-foreground">
                      #{r.order} {r.time ?? "?"}
                    </span>{" "}
                    <span className="font-semibold">{r.event}</span>
                    {r.name && <span className="text-destructive"> {r.name}</span>}
                    {r.message && <span className="text-destructive"> — {r.message}</span>}
                    {r.signature && (
                      <span className="text-blue-600"> sig={r.signature.slice(0, 16)}…</span>
                    )}
                  </li>
                ))}
                {rows.length === 0 && <li className="text-muted-foreground">(no events)</li>}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  );
}
