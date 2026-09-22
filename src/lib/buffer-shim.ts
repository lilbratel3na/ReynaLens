/**
 * Browser Buffer polyfill — must be imported FIRST in the entrypoint, before
 * any @solana/* module evaluates.
 *
 * Root cause: the Solana SDK chain (@solana/web3.js CJS internals,
 * @solana/spl-token extensions, wallet adapters) references the Node global
 * `Buffer`. Vite does not polyfill Node globals in the browser, so module
 * evaluation on /app threw `ReferenceError: Buffer is not defined`.
 *
 * Implementation: assign the official `buffer` package (the same
 * implementation Node itself uses, and what @solana/web3.js documents as its
 * browser polyfill) onto globalThis. Assigning only missing properties keeps
 * any existing, valid global intact.
 */
import { Buffer as BufferPolyfill } from "buffer";

const g = globalThis as unknown as { Buffer?: unknown };

if (typeof g.Buffer === "undefined") {
  g.Buffer = BufferPolyfill;
} else {
  // Partial global (defensive): backfill any missing members from the
  // canonical implementation without overwriting existing ones.
  for (const key of Object.getOwnPropertyNames(BufferPolyfill)) {
    if (!(key in (g.Buffer as object))) {
      (g.Buffer as Record<string, unknown>)[key] =
        (BufferPolyfill as unknown as Record<string, unknown>)[key];
    }
  }
}

export {};
