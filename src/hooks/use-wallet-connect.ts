import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";

/**
 * Single stable wallet-connection flow.
 *
 * Root causes this fixes (see P0 pass):
 * 1. The old header picker called select(name) and trusted a later effect to
 *    call connect(). That one-shot flag was lost across renders, so taps
 *    appeared dead and retry storms raced the adapter.
 * 2. On Android, returning from a wallet app / background was treated as a
 *    fresh connect: repeated select+connect cycles caused silent failures.
 * 3. No visible connecting state and no surfaced error left the button
 *    looking unresponsive.
 *
 * Design: the browser wallet-standard adapters expose connect() directly, so
 * we call select(name) then connect() on the freshly selected adapter inside
 * one handler. Taps during connect are ignored (no duplicate attempts).
 * Wallet-standard reconnect is automatic on adapter events; visibilitychange
 * is used ONLY to reconcile state (read publicKey, no select/connect loops).
 */

export interface WalletUiState {
  /** Adapter name, e.g. "Phantom" — null when none selected. */
  walletName: string | null;
  /** Detected browser wallet adapter names (installed extensions). */
  available: string[];
  connected: boolean;
  connecting: boolean;
  address: string | null;
}

export function useWalletConnect(): WalletUiState & {
  /** Open the OS/browser wallet picker for the chosen adapter name. */
  connectWallet: (name: string) => void;
  /** Explicit disconnect (user-initiated). */
  disconnectWallet: () => void;
} {
  const {
    wallets,
    wallet,
    select,
    connect,
    disconnect,
    publicKey,
    connected,
    connecting,
  } = useWallet();

  const [connectingName, setConnectingName] = useState<string | null>(null);

  // Adapter instances are stable per wallet; derive the available list from
  // the provider's memoized `wallets` (never rebuild adapters per render).
  const available = useMemo(
    () =>
      wallets
        .filter(
          (w) =>
            w.readyState === "Installed" ||
            w.readyState === "Loadable" ||
            // Some standard wallets report unsupported before install-check.
            w.readyState === "NotDetected",
        )
        .map((w) => w.adapter.name),
    [wallets],
  );

  const connectWallet = useCallback(
    (name: string) => {
      if (connecting) return; // dedupe taps — one attempt at a time
      setConnectingName(name);
      // select() only switches the active adapter in provider state; the
      // wallet-standard adapter's own connect() is invoked immediately after.
      select(name as never);
      // Defer one tick so the provider registers the selected adapter before
      // we drive connect() on it (same as Solflare/Phantom flows in the
      // official templates, minus the fragile "flag + effect" pattern).
      setTimeout(() => {
        connect().catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          const friendly = /rejected|denied|dismissed|close/i.test(msg)
            ? "Connection request dismissed in the wallet. Tap Connect again to retry."
            : /no wallet|not installed|not found/i.test(msg)
              ? `${name} is not available in this browser. Install the extension or use a wallet-enabled browser.`
              : msg;
          toast.error("Wallet connection failed", { description: friendly });
        })
          .finally(() => setConnectingName(null));
      }, 0);
    },
    [connecting, connect, select],
  );

  const disconnectWallet = useCallback(() => {
    disconnect().catch(() => undefined);
  }, [disconnect]);

  // Reconcile on visibility ONLY: when returning from Phantom/background,
  // read the adapter's current authority; do NOT re-run connect/select loops.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (connecting) return;
      const current = wallet?.adapter;
      if (!current) return;
      // No-ops when already connected; surfaces stale-state so `connected`
      // reflects reality without a page reload or adapter churn.
      if (!connected && current.publicKey) {
        // Adapter holds a live authorization the provider missed (common
        // right after returning from the wallet app): re-assert it once.
        select(current.name as never);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [wallet, connected, connecting, select]);

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
