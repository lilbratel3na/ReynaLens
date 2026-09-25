import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TEMPORARY diagnostics tests: the recorder must be passive (never throw,
 * never alter flow) and must persist enough to survive a page reload — the
 * suspected Android handoff failure mode. Persistence semantics are the
 * critical property, so they are tested against a Storage-compatible mock.
 */

import {
  attachSubmitAdapterDiagnostics,
  clearSubmitDiag,
  currentNavigationType,
  readSubmitDiag,
  submitDiag,
  summarizeSubmitDiag,
} from "./submitDiagnostics";

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

describe("submitDiagnostics recorder", () => {
  it("records ordered events with timestamps and payloads", () => {
    submitDiag("submit:start");
    submitDiag("sendTransaction:called", { instructionCount: 4 });
    const events = readSubmitDiag();
    expect(events.map((e) => e.event)).toEqual(["submit:start", "sendTransaction:called"]);
    expect(events[1].instructionCount).toBe(4);
    expect(typeof events[0].t).toBe("number");
  });

  it("persists across independent reads (survives a reload into a fresh context)", () => {
    submitDiag("sendTransaction:resolved", { signature: "SIG" });
    // A fresh read (simulating the post-reload context reading the same store)
    // must still see the event written before the "reload".
    const events = readSubmitDiag();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("sendTransaction:resolved");
    expect(events[0].signature).toBe("SIG");
  });

  it("clearSubmitDiag empties the trace", () => {
    submitDiag("mount");
    clearSubmitDiag();
    expect(readSubmitDiag()).toEqual([]);
  });

  it("never throws when localStorage/window is unavailable", () => {
    vi.stubGlobal("window", undefined);
    expect(() => submitDiag("x")).not.toThrow();
    expect(readSubmitDiag()).toEqual([]);
    expect(() => clearSubmitDiag()).not.toThrow();
  });

  it("trims to the ring-buffer cap, dropping the oldest events", () => {
    for (let i = 0; i < 130; i++) submitDiag(`e${i}`);
    const events = readSubmitDiag();
    expect(events).toHaveLength(120);
    expect(events[0].event).toBe("e10");
    expect(events[119].event).toBe("e129");
  });
});

describe("summarizeSubmitDiag (smoking-gun detector)", () => {
  it("flags a send that was called but never resolved/caught/finished", () => {
    submitDiag("submit:start");
    submitDiag("sendTransaction:called");
    const s = summarizeSubmitDiag();
    expect(s.unresolvedSend).toBe(true);
    expect(s.lastEvent).toBe("sendTransaction:called");
    expect(s.calledAt).not.toBeNull();
  });

  it("does NOT flag a send that resolved", () => {
    submitDiag("sendTransaction:called");
    submitDiag("sendTransaction:resolved", { signature: "SIG" });
    expect(summarizeSubmitDiag().unresolvedSend).toBe(false);
  });

  it("does NOT flag a send closed by the submit finally handler", () => {
    submitDiag("sendTransaction:called");
    submitDiag("submit:finally");
    expect(summarizeSubmitDiag().unresolvedSend).toBe(false);
  });

  it("does NOT flag when no send was attempted", () => {
    submitDiag("mount");
    const s = summarizeSubmitDiag();
    expect(s.unresolvedSend).toBe(false);
    expect(s.calledAt).toBeNull();
  });

  it("does NOT flag an earlier completed send followed by an unrelated event", () => {
    submitDiag("sendTransaction:called");
    submitDiag("submit:caught", { kind: "cancelled" });
    submitDiag("submit:finally");
    submitDiag("adapter:event:disconnect");
    expect(summarizeSubmitDiag().unresolvedSend).toBe(false);
    expect(summarizeSubmitDiag().lastEvent).toBe("adapter:event:disconnect");
  });
});

describe("adapter event capture", () => {
  it("records disconnect and error emissions with names/messages only", () => {
    const registered: Record<string, (e?: unknown) => void> = {};
    const adapter = {
      on: (event: string, cb: (e?: unknown) => void) => {
        registered[event] = cb;
      },
      off: (event: string) => void delete registered[event],
    };
    const detach = attachSubmitAdapterDiagnostics(adapter);
    registered["disconnect"]?.();
    registered["error"]?.(new Error("WalletSendTransactionError: boom"));
    const events = readSubmitDiag();
    expect(events.map((e) => e.event)).toContain("adapter:event:disconnect");
    const err = events.find((e) => e.event === "adapter:event:error");
    expect(err?.name).toBe("Error");
    expect(err?.message).toBe("WalletSendTransactionError: boom");

    detach();
    expect(registered["disconnect"]).toBeUndefined();
    expect(registered["error"]).toBeUndefined();
  });

  it("is a no-op for a null adapter", () => {
    const detach = attachSubmitAdapterDiagnostics(null);
    expect(() => detach()).not.toThrow();
    expect(readSubmitDiag()).toEqual([]);
  });
});

describe("currentNavigationType", () => {
  it("returns a string without throwing in any environment", () => {
    expect(typeof currentNavigationType()).toBe("string");
  });
});
