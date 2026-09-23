import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Adapter } from "@solana/wallet-adapter-base";
import { WalletNotConnectedError } from "@solana/wallet-adapter-base";
import { toast } from "sonner";

/**
 * Single stable wallet-connection flow.
 *
 * P0 root cause this version fixes (verified in WalletProviderBase.js):
 * the provider's `connect` is a `useCallback` keyed on the SELECTED wallet.
 * Calling the context `connect` captured BEFORE `select()` invoked the
 * PREVIOUS closure — whose `wallet` was still the old one. On the first tap
 * it threw `WalletNotSelectedError` (nothing selected yet); the provider
 * caught it via onConnectError and reset selection to null. Retry #1 only
 * managed `select()`, retry #2 finally reached a real adapter — matching the
 * observed "connect works on the ~3rd tap".
 *
 * Fix: resolve the selected ADAPTER from the provider's stable `wallets`
 * list and drive THAT adapter's connect() directly, with our own
 * ready-state check and friendly error mapping. No dependence on the
 * provider closure timing. select() runs BEFORE adapter.connect() so the
 * provider's 'connect' listener is attached when the adapter authorizes;
 * provider state (publicKey/connected) then updates and the UI follows.
 * Provider state syncs via the adapter's 'connect' event.
 *
 * Android deep-link behavior (verified in the Phantom/Solflare adapters):
 * when the extension is not detected, readyState is `Loadable` and
 * adapter.connect() NAVIGATES the page to the wallet's universal link
 * (e.g. phantom.app/ul/browse/…), which opens the current URL in the
 * wallet's in-app browser. That is the adapter's designed flow, not a bug:
 * the "refresh" a user sees is this sanctioned handoff. This hook treats it
 * as such: no retry storm, no extra listeners, no page reload of our own.
 *
 * Additional guarantees:
 * - Tap dedupe: one attempt at a time (provider-level and hook-level).
 * - Visible connecting state.
 * - Actionable errors (dismissed / not installed / raw).
 * - visibilitychange is used ONLY to reconcile state; never select/connect.
 */

export interface WalletUiState {
  /** Adapter name, e.g. "Phantom" — null when none selected. */
  walletName: string | null;
  /** Detected browser wallet adapter names. */
  available: string[];
  connected: boolean;
  connecting: boolean;
  address: string | null;
}

/** True when the adapter can connect right now without a redirect. */
function isUsable(w: { readyState: string }): boolean {
  return (
    w.readyState === "Installed" ||
    // Wallet-standard loadable wallets (e.g. injected providers detected
    // lazily). Excluded from the no-redirect check below.
    w.readyState === "Loadable"
  );
}

export function useWalletConnect(): WalletUiState & {
  /** Connect with the named wallet adapter. */
  connectWallet: (name: string) => void;
  /** Explicit disconnect (user-initiated). */
  disconnectWallet: () => void;
} {
  const { wallets, wallet, select, disconnect, publicKey, connected, connecting } =
    useWallet();

  const [connectingName, setConnectingName] = useState<string | null>(null);

  // Adapter instances are stable per wallet; derive the list from the
  // provider's wrapped `wallets` (never rebuild adapters per render).
  const available = useMemo(
    () => wallets.map((w) => w.adapter.name),
    [wallets],
  );

  const connectWallet = useCallback(
    (name: string) => {
      if (connecting || connectingName) return; // dedupe taps — one attempt at a time

      // Resolve the CURRENT wallet object from the provider's list. The
      // `wallet` from context can lag one render behind a fresh select(),
      // so we do not rely on it for the connect step.
      const target =
        wallets.find((w) => w.adapter.name === name) ??
        wallet; /* fall back to the provider's current selection, if any */
      if (!target) {
        toast.error("Wallet unavailable", {
          description: `${name} is not available in this browser. Install the extension or use a wallet-enabled browser.`,
        });
        return;
      }

      const adapter: Adapter = target.adapter;

      if (!isUsable(target) && !adapter.connected) {
        toast.error(`${name} is not ready`, {
          description: `Install ${name} (or open this page in a wallet-enabled browser) and reload.`,
        });
        return;
      }

      // P0 reconciliation fix — select BEFORE connecting.
      //
      // Verified in WalletProviderBase.js (0.15.40): publicKey/connected are
      // only ever updated inside the provider's 'connect' EVENT listener,
      // which is attached in an effect keyed on the `adapter` prop — i.e.
      // only after select(). There is no re-sync of an adapter's existing
      // authorization on attach (state initializers run once at mount, when
      // the prop is still null). The previous connect-then-select order
      // therefore lost the 'connect' event every time: the adapter authorized
      // while no listener existed, and the late select() could not
      // retroactively sync state — the UI stayed "not connected" even though
      // the wallet itself was connected.
      //
      // select() is a synchronous local state write (no wallet prompt, no
      // error), so ordering it first cannot regress the first-tap fix below:
      // we still never call the provider's closure-bound connect(); we drive
      // the stable adapter instance directly.
      select(name as never);

      if (adapter.connected) {
        // Already authorized — selection alone wires provider state (and
        // sendTransaction) to this adapter. Nothing to request.
        return;
      }

      setConnectingName(name);
      adapter
        .connect()
        .then(() => {
          // The adapter emitted 'connect' and the provider listener (now
          // attached) synced publicKey/connected. Re-select is a no-op when
          // the name already matches (changeWallet early-returns) and only
          // repairs selection if an intervening disconnect cleared it.
          select(name as never);
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          const friendly = /rejected|denied|dismissed|close/i.test(msg)
            ? "Connection request dismissed in the wallet. Tap Connect again to retry."
            : /not connected|not selected/i.test(msg)
              ? `${name} could not start a connection session. Tap Connect again.`
              : msg;
          // Suppress the provider's generic "WalletNotConnectedError" toast
          // if it ever surfaces through onError — our message is actionable.
          if (!(e instanceof WalletNotConnectedError)) {
            toast.error("Wallet connection failed", { description: friendly });
          }
        })
        .finally(() => setConnectingName(null));
    },
    [connecting, connectingName, wallets, wallet, select],
  );

  const disconnectWallet = useCallback(() => {
    disconnect().catch(() => undefined);
  }, [disconnect]);

  // Reconcile on visibility ONLY: when returning from the wallet app after a
  // deep-link handoff, if the adapter already holds an authorization but the
  // provider never got the 'connect' event (cold page context), run ONE silent
  // adapter.connect() — for an already-authorized adapter this resolves
  // instantly without any prompt and emits 'connect', which syncs provider
  // state. A bare select() is useless here: changeWallet() early-returns when
  // the name is unchanged, so it cannot repair stale state.
  //
  // The Mobile Wallet Adapter is excluded: connect() on it re-opens the wallet
  // app (deep link), which would loop the user away. No timers, no reloads,
  // no connect storms — single guarded attempt per visibility transition.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (connecting || connectingName) return;
      if (connected) return;
      const current = wallet?.adapter;
      if (!current || current.connected || !current.publicKey) return;
      if (current.name === "Mobile Wallet Adapter") return;
      current.connect().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [wallet, connected, connecting, connectingName]);

  return {
    walletName: wallet?.adapter.name ?? null,
    available,
    connected,
    connecting: connecting || connectingName !== null,
    address: publicKey?.toBase58() ?? null,
    connectWallet,
    disconnectWallet,
  };
}
