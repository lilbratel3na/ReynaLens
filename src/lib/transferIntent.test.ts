import { describe, expect, it } from "vitest";
import {
  clearSubmittedSignature,
  clearTransferIntent,
  loadSubmittedSignature,
  loadTransferIntent,
  saveSubmittedSignature,
  saveTransferIntent,
} from "./transferIntent";

/** Minimal in-memory Storage double (sessionStorage-shaped). */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => map.delete(k) as unknown as void,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const INTENT = {
  mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
  recipient: "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt",
  amount: "1",
  phase: "preview" as const,
};

describe("transferIntent persistence", () => {
  it("round-trips a valid intent", () => {
    const s = memoryStorage();
    saveTransferIntent(INTENT, s);
    expect(loadTransferIntent(s)).toEqual(INTENT);
  });

  it("returns null when nothing is stored", () => {
    expect(loadTransferIntent(memoryStorage())).toBeNull();
  });

  it("discards malformed JSON instead of throwing", () => {
    const s = memoryStorage();
    s.setItem("reynalens.intent.v1", "{not json");
    expect(loadTransferIntent(s)).toBeNull();
  });

  it("discards entries missing required fields", () => {
    const s = memoryStorage();
    s.setItem(
      "reynalens.intent.v1",
      JSON.stringify({ v: 1, mint: "x", recipient: "", amount: "1", phase: "preview" }),
    );
    expect(loadTransferIntent(s)).toBeNull();
  });

  it("discards entries with unknown phase values", () => {
    const s = memoryStorage();
    s.setItem(
      "reynalens.intent.v1",
      JSON.stringify({ v: 1, mint: "m", recipient: "r", amount: "1", phase: "receipt" }),
    );
    expect(loadTransferIntent(s)).toBeNull();
  });

  it("clear removes the stored intent", () => {
    const s = memoryStorage();
    saveTransferIntent(INTENT, s);
    clearTransferIntent(s);
    expect(loadTransferIntent(s)).toBeNull();
  });

  it("tolerates a throwing storage (private-mode browsers)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => saveTransferIntent(INTENT, throwing)).not.toThrow();
    expect(loadTransferIntent(throwing)).toBeNull();
    expect(() => clearTransferIntent(throwing)).not.toThrow();
  });
});

describe("submitted signature persistence (remount recovery)", () => {
  const SIG = "5UVdKaQ9y5smqvivotNQfQLiWkG7TvzczuoxQnCBmuLZJxUGS5jzGTU3UBTVhBcMbZoLmHsMbcV7sDTPZHnpiFj4";

  it("round-trips a submitted signature", () => {
    const s = memoryStorage();
    saveSubmittedSignature(SIG, s);
    expect(loadSubmittedSignature(s)).toBe(SIG);
  });

  it("returns null when nothing stored, and tolerates malformed JSON", () => {
    const s = memoryStorage();
    expect(loadSubmittedSignature(s)).toBeNull();
    s.setItem("reynalens.submittedSignature.v1", "{oops");
    expect(loadSubmittedSignature(s)).toBeNull();
  });

  it("discards empty or non-string signatures", () => {
    const s = memoryStorage();
    s.setItem("reynalens.submittedSignature.v1", JSON.stringify({ v: 1, signature: "" }));
    expect(loadSubmittedSignature(s)).toBeNull();
    s.setItem("reynalens.submittedSignature.v1", JSON.stringify({ v: 1, signature: 42 }));
    expect(loadSubmittedSignature(s)).toBeNull();
  });

  it("clear removes the submitted signature (remount → no stale recovery)", () => {
    const s = memoryStorage();
    saveSubmittedSignature(SIG, s);
    clearSubmittedSignature(s);
    expect(loadSubmittedSignature(s)).toBeNull();
  });

  it("tolerates a throwing storage", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => saveSubmittedSignature(SIG, throwing)).not.toThrow();
    expect(loadSubmittedSignature(throwing)).toBeNull();
    expect(() => clearSubmittedSignature(throwing)).not.toThrow();
  });
});
