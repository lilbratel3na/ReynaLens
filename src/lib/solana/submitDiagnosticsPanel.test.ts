import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the TEMPORARY diagnostics-panel helpers: row normalization, the
 * whitelist sanitizer (nothing unlisted may ever reach the screen or the
 * clipboard), the summary line, and the export payload.
 */

import {
  buildDiagExport,
  formatDiagRows,
  formatDiagSummaryLine,
  formatDiagTime,
  sanitizeEvents,
  type DiagEvent,
} from "./submitDiagnosticsPanel";
import { submitDiag } from "./submitDiagnostics";

const store = new Map<string, string>();

const localStorageMock: Storage = {
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
  getItem: (k: string) => store.get(k) ?? null,
  key: (i: number) => [...store.keys()][i] ?? null,
  removeItem: (k: string) => void store.delete(k),
  setItem: (k: string, v: string) => void store.set(k, v),
};

beforeEach(() => {
  store.clear();
  vi.stubGlobal("window", { localStorage: localStorageMock });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("formatDiagTime", () => {
  it("formats a unix-ms timestamp as local HH:MM:SS.mmm", () => {
    // 2024-01-01T00:00:00.123 UTC (local rendering depends on the test TZ).
    const t = Date.UTC(2024, 0, 1, 0, 0, 0, 123);
    const s = formatDiagTime(t);
    expect(s).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(s.endsWith(".123")).toBe(true);
  });
});

describe("formatDiagRows", () => {
  it("normalizes events into ordered rows preserving order and index", () => {
    const events: DiagEvent[] = [
      { t: Date.UTC(2024, 0, 1, 1, 2, 3, 4), event: "submit:start" },
      {
        t: Date.UTC(2024, 0, 1, 1, 2, 3, 5),
        event: "sendTransaction:rejected",
        name: "WalletSendTransactionError",
        message: "Provider rejected",
      },
      {
        t: Date.UTC(2024, 0, 1, 1, 2, 3, 6),
        event: "sendTransaction:resolved",
        signature: "5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      },
    ];
    const rows = formatDiagRows(events);
    expect(rows.map((r) => r.order)).toEqual([0, 1, 2]);
    expect(rows[0].event).toBe("submit:start");
    expect(rows[1].name).toBe("WalletSendTransactionError");
    expect(rows[1].message).toBe("Provider rejected");
    expect(rows[1].signature).toBeNull();
    expect(rows[2].signature).toMatch(/^5x+/);
    expect(rows[2].name).toBeNull();
    expect(rows.every((r) => /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(r.time ?? ""))).toBe(true);
  });

  it("tolerates malformed events (missing/non-string fields)", () => {
    const rows = formatDiagRows([
      { t: 1, event: "x" },
      { t: 2, event: "y", name: 42, message: null, signature: undefined },
      { t: "bad", event: "z" },
    ] as unknown as DiagEvent[]);
    expect(rows).toHaveLength(3);
    expect(rows[1].name).toBeNull();
    expect(rows[1].message).toBeNull();
    expect(rows[2].time).toBeNull();
  });
});

describe("sanitizeEvents (whitelist — safety boundary)", () => {
  it("keeps allowed keys and drops everything unlisted", () => {
    const out = sanitizeEvents([
      {
        t: 5,
        event: "submit:start",
        guardConsumed: true,
        // Potentially unsafe fields that must never be displayed or copied:
        privateKey: "never",
        seedPhrase: "never",
        serializedTxBytes: "never",
        somethingFuture: "dropped",
      } as unknown as DiagEvent,
    ]);
    expect(out[0]).toEqual({ t: 5, event: "submit:start", guardConsumed: true });
    expect(JSON.stringify(out)).not.toContain("never");
  });

  it("keeps public signatures and error name/message", () => {
    const out = sanitizeEvents([
      { t: 1, event: "e", signature: "SIG", name: "N", message: "M" } as DiagEvent,
    ]);
    expect(out[0]).toEqual({ t: 1, event: "e", signature: "SIG", name: "N", message: "M" });
  });
});

describe("formatDiagSummaryLine", () => {
  it("renders the UNRESOLVED verdict when a send was left pending", () => {
    const line = formatDiagSummaryLine({
      events: 2,
      lastEvent: "sendTransaction:called",
      unresolvedSend: true,
      calledAt: 1,
    });
    expect(line).toContain("UNRESOLVED SEND");
    expect(line).toContain("last=sendTransaction:called");
    expect(line).toContain("events=2");
  });

  it("renders the clean verdict otherwise", () => {
    const line = formatDiagSummaryLine({
      events: 3,
      lastEvent: "receipt:verified",
      unresolvedSend: false,
      calledAt: 1,
    });
    expect(line).toContain("no unresolved send");
    expect(line).not.toContain("UNRESOLVED");
  });

  it("handles an empty trace", () => {
    const line = formatDiagSummaryLine({
      events: 0,
      lastEvent: null,
      unresolvedSend: false,
      calledAt: null,
    });
    expect(line).toContain("last=—");
    expect(line).toContain("no unresolved send");
  });
});

describe("buildDiagExport", () => {
  it("builds a JSON payload with summary and sanitized events", () => {
    submitDiag("submit:start", { guardConsumed: false });
    submitDiag("sendTransaction:called", { instructionCount: 4, txIsLegacy: true });
    submitDiag("sendTransaction:rejected", {
      name: "WalletSendTransactionError",
      message: "boom",
    });
    const json = buildDiagExport(1700000000000);
    const parsed = JSON.parse(json) as {
      generatedAt: string;
      summary: { unresolvedSend: boolean; events: number };
      events: Array<Record<string, unknown>>;
    };
    expect(parsed.summary.events).toBe(3);
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events[2]).toEqual({
      t: expect.any(Number),
      event: "sendTransaction:rejected",
      name: "WalletSendTransactionError",
      message: "boom",
    });
    expect(parsed.generatedAt).toBe(new Date(1700000000000).toISOString());
  });

  it("never includes unwhitelisted fields in the export", () => {
    // Simulate a hypothetical bad recording site via a direct storage write.
    localStorageMock.setItem(
      "reynalens.submitDiag.v1",
      JSON.stringify([
        { t: 1, event: "hacked", seedPhrase: "twelve words", privateKey: "0xdead" },
      ]),
    );
    const json = buildDiagExport();
    expect(json).not.toContain("twelve words");
    expect(json).not.toContain("0xdead");
    expect(json).toContain("hacked"); // event name itself is safe to show
  });
});
