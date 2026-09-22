import { useWallet } from "@solana/wallet-adapter-react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { motion, AnimatePresence } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { WalletName } from "@solana/wallet-adapter-base";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  ScanLine,
  RefreshCw,
  ChevronLeft,
  Check,
  Wallet,
  Copy,
  ExternalLink,
  FileCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KV, TermPanel, StatusBar } from "@/components/terminal/Term";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { connection as rpc } from "@/lib/solana/connection";
import { PRESTOCK_ASSETS, type PreStockAsset } from "@/lib/solana/prestocks";
import { inspectMint, type MintInspection } from "@/lib/solana/inspectMint";
import {
  calculateExactOut,
  calculateFeeForward,
  formatBaseUnits,
  parseUiAmountToBaseUnits,
  shortenAddress,
  type ExactOutResult,
} from "@/lib/solana/exactOut";
import {
  evaluateRecipientShield,
  type ShieldVerdict,
  type ShieldKnownRecipient,
} from "@/lib/solana/shield";
import {
  buildTransferTransaction,
  simulateTransfer,
  type BuiltTransfer,
} from "@/lib/solana/transfer";
import {
  deriveRecipientAta,
  explorerTxUrl,
  explorerAccountUrl,
  readBalanceOrZero,
  verifyDelivery,
  confirmSignature,
  type DeliveryVerification,
} from "@/lib/solana/verify";
import {
  readWalletBalance,
  lamportsToSol,
  ESTIMATED_SOL_FEE_LAMPORTS,
  type WalletBalance,
} from "@/lib/solana/balance";
import { DEMO_LOOKALIKE_TARGET, DEMO_KNOWN_RECIPIENTS } from "@/lib/demo";

/* ------------------------------------------------------------------ */
/* Screen state machine                                                */
/* ------------------------------------------------------------------ */

const SCREENS = [
  "asset",
  "recipient",
  "shield",
  "amount",
  "preview",
  "preflight",
  "signing",
  "receipt",
] as const;
type ScreenId = (typeof SCREENS)[number];

const SCREEN_LABELS: Record<ScreenId, string> = {
  asset: "ASSET",
  recipient: "RECIPIENT",
  shield: "SHIELD",
  amount: "AMOUNT",
  preview: "PREVIEW",
  preflight: "PREFLIGHT",
  signing: "SIGN",
  receipt: "RECEIPT",
};

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                        */
/* ------------------------------------------------------------------ */

function DiffAddresses({
  expected,
  actual,
  diffs,
}: {
  expected: string;
  actual: string;
  diffs: { index: number }[];
}) {
  const flagged = new Set(diffs.map((d) => d.index));
  return (
    <div className="space-y-1.5 text-[11px] leading-4 font-terminal break-all">
      <div>
        <span className="text-muted-foreground">PREVIOUS </span>
        {expected.split("").map((c, i) => (
          <span
            key={i}
            className={
              flagged.has(i) ? "font-bold text-status-warn" : "text-muted-foreground"
            }
          >
            {c}
          </span>
        ))}
      </div>
      <div>
        <span className="text-muted-foreground">ENTERED  </span>
        {actual.split("").map((c, i) => (
          <span
            key={i}
            className={flagged.has(i) ? "font-bold text-status-bad" : undefined}
          >
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

function FullAddressBox({ address }: { address: string }) {
  return (
    <div className="border border-border bg-secondary px-3 py-2">
      <div className="text-[10px] uppercase tracking-terminal text-muted-foreground">
        Full recipient address — verify every character
      </div>
      <div className="mt-1 break-all font-terminal text-xs text-foreground select-all">
        {address}
      </div>
    </div>
  );
}

function VerdictIcon({ kind }: { kind: ShieldVerdict["kind"] }) {
  if (kind === "known") return <ShieldCheck className="size-5 text-status-ok" />;
  if (kind === "new") return <ShieldCheck className="size-5 text-status-ok" />;
  if (kind === "lookalike" || kind === "self")
    return <ShieldAlert className="size-5 text-status-warn" />;
  return <ShieldX className="size-5 text-status-bad" />;
}

/* ------------------------------------------------------------------ */
/* App page                                                            */
/* ------------------------------------------------------------------ */

export default function AppPage() {
  const {
    publicKey,
    connected,
    connecting,
    wallet,
    wallets,
    select,
    connect,
    disconnect,
    sendTransaction,
  } = useWallet();

  // Recipient book (Convex). AppPage is behind RequireAuth.
  const recipientRows = useQuery(api.recipients.listRecipients);
  const recordRecipient = useMutation(api.recipients.recordVerifiedRecipient);
  const saveReceiptMut = useMutation(api.recipients.saveReceipt);

  const [screen, setScreen] = useState<ScreenId>("asset");
  const [status, setStatus] = useState("Select a PreStock to inspect.");

  // Asset + live inspection
  const [asset, setAsset] = useState<PreStockAsset | null>(null);
  const [mintInspection, setMintInspection] = useState<MintInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  // Recipient
  const [recipientInput, setRecipientInput] = useState("");
  const [shieldVerdict, setShieldVerdict] = useState<ShieldVerdict | null>(null);
  const [shieldLoading, setShieldLoading] = useState(false);
  const [shieldOverride, setShieldOverride] = useState(false);

  // Amount
  const [amountInput, setAmountInput] = useState("");
  const [balances, setBalances] = useState<WalletBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  // Preflight / signing
  const [built, setBuilt] = useState<BuiltTransfer | null>(null); // eslint-disable-line -- kept for instruction count display
  const [sim, setSim] = useState<{ ok: boolean; error?: string; logs?: string[] } | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [addressConfirmed, setAddressConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLine, setBusyLine] = useState<string | null>(null);

  // Receipt
  const [verification, setVerification] = useState<DeliveryVerification | null>(null);
  const [finalExactOut, setFinalExactOut] = useState<ExactOutResult | null>(null);

  const preflightRun = useRef(0);

  const owner = publicKey ?? null;
  const mintPubkey = useMemo(
    () => (asset ? new PublicKey(asset.mint) : null),
    [asset],
  );
  const sourceAta = useMemo(
    () =>
      owner && mintPubkey
        ? getAssociatedTokenAddressSync(mintPubkey, owner, false, TOKEN_2022_PROGRAM_ID)
        : null,
    [owner, mintPubkey],
  );

  // Known recipients: real history (Convex) + demo seeds for the lookalike demo.
  const knownRecipients: ShieldKnownRecipient[] = useMemo(() => {
    const real = (recipientRows ?? []).map((r) => ({
      address: r.address,
      label: r.label,
      assetSymbol: r.assetSymbol,
      lastUsedAt: r.lastUsedAt ?? 0,
    }));
    const demo = DEMO_KNOWN_RECIPIENTS.map((r) => ({
      address: r.address,
      label: `Demo · ${r.label}`,
      assetSymbol: r.assetSymbol,
      lastUsedAt: 0,
    }));
    const seen = new Set<string>();
    const out: ShieldKnownRecipient[] = [];
    for (const r of [...real, ...demo]) {
      if (seen.has(r.address)) continue;
      seen.add(r.address);
      out.push(r);
    }
    return out;
  }, [recipientRows]);

  const refreshBalances = useCallback(async () => {
    if (!owner || !mintPubkey) return;
    setBalanceLoading(true);
    try {
      const b = await readWalletBalance(rpc, owner, mintPubkey);
      setBalances(b);
    } finally {
      setBalanceLoading(false);
    }
  }, [owner, mintPubkey]);

  // Load balances whenever the asset/wallet is ready.
  useEffect(() => {
    if (owner && mintPubkey && screen === "amount") {
      void refreshBalances();
    }
  }, [owner, mintPubkey, screen, refreshBalances]);

  const pickAsset = useCallback(
    async (a: PreStockAsset) => {
      setAsset(a);
      setMintInspection(null);
      setInspectError(null);
      setInspecting(true);
      setStatus(`Inspecting ${a.ticker} mint on mainnet…`);
      try {
        const info = await inspectMint(rpc, new PublicKey(a.mint));
        setMintInspection(info);
        setStatus(
          `${a.ticker} inspected · ${info.decimals} decimals · ${info.transferFeeConfig
            ? `${applicableTier(info).transferFeeBasisPoints} bps tier active`
            : "no transfer-fee extension"
          }`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInspectError(msg);
        setStatus("Live inspection failed.");
      } finally {
        setInspecting(false);
      }
    },
    [],
  );

  const runShield = useCallback(async () => {
    if (!owner || !asset || !mintInspection || !mintPubkey) return;
    const trimmed = recipientInput.trim();
    setShieldLoading(true);
    setShieldOverride(false);
    setShieldVerdict(null);
    setStatus("Evaluating recipient…");
    try {
      const verdict = await evaluateRecipientShield({
        address: trimmed,
        selfAddress: owner.toBase58(),
        knownRecipients,
        mint: mintInspection,
        connection: rpc,
        mintPubkey,
      });
      setShieldVerdict(verdict);
      setStatus(`Shield verdict: ${verdict.title}`);
      setScreen("shield");
    } catch (e) {
      toast.error("Shield evaluation failed", {
        description: e instanceof Error ? e.message : String(e),
      });
      setStatus("Shield evaluation failed.");
    } finally {
      setShieldLoading(false);
    }
  }, [owner, asset, mintInspection, mintPubkey, recipientInput, knownRecipients]);

  /* ---------------- exact-out derivation for the amount screen -------------- */

  const amountState = useMemo(() => {
    if (!asset || !mintInspection) return null;
    const decimals = mintInspection.decimals;
    if (!amountInput.trim()) return { state: "empty" as const };

    const parsed = parseUiAmountToBaseUnits(amountInput, decimals);
    if (typeof parsed === "object" && "error" in parsed) {
      return { state: "error" as const, error: parsed.error };
    }
    const net = parsed;
    if (net === 0n) {
      return { state: "error" as const, error: "Enter an amount greater than zero." };
    }

    if (!mintInspection.transferFeeConfig) {
      return {
        state: "error" as const,
        error:
          "KILL SWITCH A: this mint has no TransferFeeConfig. The exact-out problem is not defined — stopping.",
      };
    }
    const tier = applicableTier(mintInspection);
    let out: ExactOutResult;
    try {
      out = calculateExactOut({
        net,
        decimals,
        feeBps: tier.transferFeeBasisPoints,
        maximumFee: BigInt(tier.maximumFee),
        tierEpoch: tier.epoch,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        state: "error" as const,
        error: msg.includes("invariant")
          ? "This amount cannot be delivered exactly under the live maximum-fee rounding rules. Try a slightly different amount."
          : msg,
      };
    }

    // Balance feasibility (token).
    const tokenBal = balances?.tokenBaseUnits ?? null;
    if (tokenBal !== null && out.gross > tokenBal) {
      const deliverable = calculateFeeForward(tokenBal, tier.transferFeeBasisPoints, BigInt(tier.maximumFee));
      return {
        state: "error" as const,
        error: `You do not have enough ${asset.ticker} to deliver the requested amount after the current transfer fee. Balance ${formatBaseUnits(tokenBal, decimals)} ${asset.ticker} delivers at most ${formatBaseUnits(tokenBal - deliverable, decimals)} ${asset.ticker} to the recipient.`,
      };
    }

    return { state: "ok" as const, net, out };
  }, [asset, mintInspection, amountInput, balances]);

  const exactOut = amountState?.state === "ok" ? amountState.out : null;

  /* ---------------- transaction build + simulation gate --------------- */

  const buildAndSimulate = useCallback(async (): Promise<{
    ok: boolean;
    error?: string;
  }> => {
    if (!owner || !asset || !mintInspection || !mintPubkey || !exactOut || !sourceAta || !shieldVerdict) {
      return { ok: false, error: "Flow state incomplete." };
    }
    const recipientPk = new PublicKey(recipientInput.trim());
    const destinationAta = deriveRecipientAta(recipientPk, mintPubkey);
    const needsAtaCreation = shieldVerdict.destinationAccount?.needsCreation ?? true;
    try {
      const builtTx = await buildTransferTransaction({
        connection: rpc,
        owner,
        sourceAta,
        mintInspection,
        recipient: recipientPk,
        destinationAta,
        needsAtaCreation,
        exactOut,
        decimals: mintInspection.decimals,
      });
      setBuilt(builtTx);
      setSimulating(true);
      setStatus("Simulating transaction against mainnet…");
      const result = await simulateTransfer(rpc, builtTx.transaction, owner);
      setSim(result);
      setStatus(result.ok ? "Simulation passed. READY TO SIGN." : "SIGNING BLOCKED.");
      return { ok: result.ok, error: result.error };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuilt(null);
      setSim({ ok: false, error: msg });
      setStatus("SIGNING BLOCKED.");
      return { ok: false, error: msg };
    } finally {
      setSimulating(false);
    }
  }, [owner, asset, mintInspection, mintPubkey, exactOut, sourceAta, shieldVerdict, recipientInput]);

  // Auto-run the simulation gate when entering the preflight screen.
  useEffect(() => {
    if (screen !== "preflight") return;
    const run = ++preflightRun.current;
    setSim(null);
    void (async () => {
      const res = await buildAndSimulate();
      if (preflightRun.current !== run) return;
      if (!res.ok && res.error) {
        // error already stored in state by buildAndSimulate
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  /* ---------------- signing + verification ----------------------------- */

  const executeTransfer = useCallback(async () => {
    if (!owner || !asset || !mintInspection || !mintPubkey || !exactOut || !built || !sim?.ok || !shieldVerdict) {
      return;
    }
    setBusy(true);
    try {
      // 1. Fee-configuration re-check (§27): the live chain wins.
      setBusyLine("Re-checking live transfer-fee configuration…");
      const fresh = await inspectMint(rpc, mintPubkey);
      let effective = exactOut;
      if (mintInspection.transferFeeConfig && fresh.transferFeeConfig) {
        const before = applicableTier(mintInspection);
        const after = applicableTier(fresh);
        if (
          before.transferFeeBasisPoints !== after.transferFeeBasisPoints ||
          before.maximumFee !== after.maximumFee ||
          before.epoch !== after.epoch
        ) {
          setBusyLine("Fee configuration changed — recalculating…");
          const recalculated = calculateExactOut({
            net: exactOut.net,
            decimals: fresh.decimals,
            feeBps: after.transferFeeBasisPoints,
            maximumFee: BigInt(after.maximumFee),
            tierEpoch: after.epoch,
          });
          setMintInspection(fresh);
          effective = recalculated;
          toast.info("FEE CONFIGURATION CHANGED", {
            description:
              "The live transfer configuration changed before signing. ReynaLens recalculated the transaction.",
          });
        }
      }

      // 2. Rebuild from the freshest state and re-simulate. Never sign a tx
      //    whose preflight did not pass.
      setBusyLine("Rebuilding and re-simulating transaction…");
      const recipientPk = new PublicKey(recipientInput.trim());
      const destinationAta = deriveRecipientAta(recipientPk, mintPubkey);
      const needsAtaCreation = shieldVerdict.destinationAccount?.needsCreation ?? true;
      const rebuilt = await buildTransferTransaction({
        connection: rpc,
        owner,
        sourceAta: sourceAta!,
        mintInspection: fresh,
        recipient: recipientPk,
        destinationAta,
        needsAtaCreation,
        exactOut: effective,
        decimals: fresh.decimals,
      });
      const reSim = await simulateTransfer(rpc, rebuilt.transaction, owner);
      if (!reSim.ok) {
        setBuilt(rebuilt);
        setSim(reSim);
        setScreen("preflight");
        toast.error("TRANSACTION BLOCKED", {
          description: reSim.error ?? "Preflight simulation failed.",
        });
        return;
      }

      // 3. Pre-balance for delta proof.
      setBusyLine("Reading destination balance before transfer…");
      const pre = needsAtaCreation ? 0n : await readBalanceOrZero(rpc, destinationAta);

      // 4. Fresh blockhash + wallet signature.
      setBusyLine("Requesting wallet signature…");
      const latest = await rpc.getLatestBlockhash("confirmed");
      const tx = rebuilt.transaction;
      tx.recentBlockhash = latest.blockhash;
      tx.feePayer = owner;
      const sig = await sendTransaction(tx, rpc);

      setBusyLine("Confirming transaction on Solana…");
      // Signature-status polling: robust even if the wallet adapter replaced
      // the recent blockhash before signing.
      const confirmation = await confirmSignature(rpc, sig);
      if (!confirmation.ok) {
        toast.error("CONFIRMATION NOT VERIFIED", {
          description:
            confirmation.error ??
            "The transaction did not confirm in time. Check the explorer before retrying — do not double-send.",
        });
        setStatus("Confirmation not verified — check the explorer before retrying.");
        return;
      }

      // 5. Post-transfer verification: read what actually arrived.
      setBusyLine("Verifying actual delivery from live chain state…");
      const proof = await verifyDelivery({
        connection: rpc,
        destinationAta,
        preBalanceBaseUnits: pre,
        requestedNet: effective.net,
        signature: sig,
      });
      setVerification(proof);
      setFinalExactOut(effective);

      // 6. Persist recipient + receipt (user-scoped history only).
      try {
        await recordRecipient({
          address: recipientPk.toBase58(),
          assetSymbol: asset.ticker,
          assetMint: asset.mint,
          now: Date.now(),
        });
        await saveReceiptMut({
          assetSymbol: asset.ticker,
          assetMint: asset.mint,
          mintDecimals: fresh.decimals,
          recipient: recipientPk.toBase58(),
          netBaseUnits: effective.net.toString(),
          grossBaseUnits: effective.gross.toString(),
          feeBaseUnits: effective.fee.toString(),
          signature: sig,
          verified: proof.matchesRequested,
          now: Date.now(),
        });
      } catch {
        // History persistence must never block the proof itself.
      }

      setStatus(proof.matchesRequested ? "Delivery verified." : "Delivery mismatch — review receipt.");
      setScreen("receipt");
      toast.success(
        proof.matchesRequested
          ? `Verified: recipient received exactly ${formatBaseUnits(effective.net, fresh.decimals)} ${asset.ticker}.`
          : "Transfer confirmed, but the verified amount differs from the request.",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const friendly = /rejected|denied|declined/i.test(msg)
        ? "You rejected the transaction in your wallet. Nothing was sent."
        : msg;
      toast.error("TRANSFER FAILED", { description: friendly });
      setStatus("Transfer did not complete.");
      setBusyLine(null);
    } finally {
      setBusy(false);
      setBusyLine(null);
    }
  }, [
    owner, asset, mintInspection, mintPubkey, exactOut, built, sim, shieldVerdict,
    sourceAta, recipientInput, sendTransaction, recordRecipient, saveReceiptMut,
  ]);

  /* ---------------- navigation guards ---------------------------------- */

  const stepCompleted: Record<ScreenId, boolean> = {
    asset: !!mintInspection && !inspectError,
    recipient: recipientInput.trim().length > 0 && !!mintInspection,
    shield: !!shieldVerdict && shieldAllowed(shieldVerdict, shieldOverride),
    amount: amountState?.state === "ok",
    preview: amountState?.state === "ok",
    preflight: !!sim?.ok,
    signing: !!verification,
    receipt: !!verification,
  };

  const goTo = (s: ScreenId) => {
    // Only allow jumping to a screen whose prerequisites are met.
    const order = SCREENS.indexOf(s);
    for (let i = 0; i < order; i++) {
      if (!stepCompleted[SCREENS[i]]) return;
    }
    setScreen(s);
  };

  /* ---------------- wallet connect UI ---------------------------------- */

  const [connectOpen, setConnectOpen] = useState(false);
  const detectedWallets = wallets.filter(
    (w) => w.readyState === "Installed" || w.readyState === "Loadable",
  );
  // `select()` only updates provider state; the adapter for the newly selected
  // wallet does not exist until the next render, so connect() must run from an
  // effect against the fresh adapter (avoids the stale-closure race).
  const pendingConnect = useRef(false);
  const connectWallet = (name: string) => {
    setConnectOpen(false);
    pendingConnect.current = true;
    select(name as WalletName);
  };
  useEffect(() => {
    if (!pendingConnect.current || !wallet || connecting || connected) return;
    pendingConnect.current = false;
    connect().catch((e: unknown) => {
      toast.error("Wallet connection failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    });
  }, [wallet, connecting, connected, connect]);

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  const ticker = asset?.ticker ?? "—";

  return (
    <main className="min-h-screen bg-background">
      <div className="terminal-grid-faint min-h-screen">
        <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-16">
          {/* Header */}
          <header className="flex items-center justify-between py-4">
            <div className="flex items-center gap-2">
              <ScanLine className="size-5 text-primary" />
              <span className="font-terminal text-sm font-bold tracking-terminal">REYNALENS</span>
            </div>
            {connected && owner ? (
              <div className="flex items-center gap-2">
                <span className="font-terminal text-xs text-muted-foreground">
                  {shortenAddress(owner.toBase58())}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={async () => {
                    await disconnect();
                    toast("Wallet disconnected.");
                  }}
                >
                  Disconnect
                </Button>
              </div>
            ) : (
              <div className="relative">
                <Button
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => setConnectOpen((v) => !v)}
                >
                  <Wallet className="size-3.5" />
                  Connect wallet
                </Button>
                {connectOpen && (
                  <div className="absolute right-0 top-9 z-20 w-48 border border-border bg-card p-1 shadow-[2px_2px_0_0_rgba(25,27,24,0.06)]">
                    {detectedWallets.length === 0 && (
                      <div className="px-3 py-2 text-[11px] text-muted-foreground">
                        No wallet extension detected. Install Phantom or Solflare.
                      </div>
                    )}
                    {detectedWallets.map((w) => (
                      <button
                        key={w.adapter.name}
                        className="w-full px-3 py-2 text-left text-xs hover:bg-secondary"
                        onClick={() => void connectWallet(w.adapter.name)}
                      >
                        {w.adapter.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </header>

          {/* Step rail */}
          <nav className="mb-4 border border-border bg-card px-3 py-2">
            <div className="grid grid-cols-4 gap-x-3 gap-y-1">
              {SCREENS.map((s, i) => {
                const idx = SCREENS.indexOf(screen);
                const done = stepCompleted[s];
                const active = s === screen;
                return (
                  <button
                    key={s}
                    onClick={() => goTo(s)}
                    className={`flex items-center gap-1.5 text-left text-[10px] font-terminal tracking-terminal ${
                      active ? "text-primary" : done ? "text-foreground" : "text-muted-foreground/60"
                    }`}
                  >
                    <span
                      className={`inline-flex size-3.5 shrink-0 items-center justify-center border text-[8px] ${
                        done
                          ? "border-status-ok bg-status-ok-soft text-status-ok"
                          : active
                            ? "border-primary"
                            : "border-border"
                      }`}
                    >
                      {done ? <Check className="size-2.5" /> : i + 1}
                    </span>
                    {SCREEN_LABELS[s]}
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Screen body */}
          <AnimatePresence mode="wait">
            <motion.div
              key={screen}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
              className="flex-1"
            >
              {screen === "asset" && (
                <AssetScreen
                  asset={asset}
                  inspecting={inspecting}
                  inspectError={inspectError}
                  mintInspection={mintInspection}
                  onPick={pickAsset}
                  onContinue={() => setScreen("recipient")}
                />
              )}

              {screen === "recipient" && (
                <RecipientScreen
                  asset={asset}
                  owner={owner}
                  value={recipientInput}
                  onChange={(v) => {
                    setRecipientInput(v);
                    setShieldVerdict(null);
                    setShieldOverride(false);
                  }}
                  known={knownRecipients}
                  onPickKnown={(addr) => {
                    setRecipientInput(addr);
                    setShieldVerdict(null);
                    setShieldOverride(false);
                  }}
                  onDemoLookalike={() => {
                    setRecipientInput(DEMO_LOOKALIKE_TARGET);
                    setShieldVerdict(null);
                    setShieldOverride(false);
                  }}
                  onEvaluate={runShield}
                  loading={shieldLoading}
                />
              )}

              {screen === "shield" && shieldVerdict && (
                <ShieldScreen
                  verdict={shieldVerdict}
                  override={shieldOverride}
                  onOverride={() => setShieldOverride(true)}
                  onUsePrevious={() => {
                    if (shieldVerdict.matchedAgainst) {
                      setRecipientInput(shieldVerdict.matchedAgainst);
                      setShieldVerdict(null);
                      setShieldOverride(false);
                      setScreen("recipient");
                    }
                  }}
                  onEdit={() => setScreen("recipient")}
                  onContinue={() => {
                    setShieldOverride(false);
                    setScreen("amount");
                  }}
                />
              )}

              {screen === "amount" && (
                <AmountScreen
                  asset={asset}
                  mintInspection={mintInspection}
                  amountInput={amountInput}
                  onAmountChange={setAmountInput}
                  amountState={amountState}
                  balances={balances}
                  balanceLoading={balanceLoading}
                  onRefreshBalance={refreshBalances}
                  onContinue={() => setScreen("preview")}
                  onBack={() => setScreen("shield")}
                />
              )}

              {screen === "preview" && (
                <PreviewScreen
                  asset={asset}
                  mintInspection={mintInspection}
                  exactOut={exactOut}
                  recipient={recipientInput.trim()}
                  owner={owner}
                  sourceAta={sourceAta}
                  balances={balances}
                  shieldVerdict={shieldVerdict}
                  onBack={() => setScreen("amount")}
                  onContinue={() => setScreen("preflight")}
                />
              )}

              {screen === "preflight" && (
                <PreflightScreen
                  asset={asset}
                  sim={sim}
                  simulating={simulating}
                  built={built}
                  onRetry={buildAndSimulate}
                  onBack={() => setScreen("preview")}
                  onContinue={() => {
                    setAddressConfirmed(false);
                    setScreen("signing");
                  }}
                />
              )}

              {screen === "signing" && (
                <SigningScreen
                  asset={asset}
                  mintInspection={mintInspection}
                  exactOut={exactOut}
                  recipient={recipientInput.trim()}
                  owner={owner}
                  connected={connected}
                  addressConfirmed={addressConfirmed}
                  onAddressConfirmed={setAddressConfirmed}
                  busy={busy}
                  busyLine={busyLine}
                  onExecute={executeTransfer}
                  onBack={() => setScreen("preflight")}
                  detectedWallets={detectedWallets.map((w) => w.adapter.name)}
                  onConnect={(name) => void connectWallet(name)}
                />
              )}

              {screen === "receipt" && (
                <ReceiptScreen
                  asset={asset}
                  mintInspection={mintInspection}
                  exactOut={finalExactOut}
                  verification={verification}
                  recipient={recipientInput.trim()}
                  onNewTransfer={() => {
                    setAsset(null);
                    setMintInspection(null);
                    setInspectError(null);
                    setRecipientInput("");
                    setShieldVerdict(null);
                    setShieldOverride(false);
                    setAmountInput("");
                    setBalances(null);
                    setBuilt(null);
                    setSim(null);
                    setVerification(null);
                    setFinalExactOut(null);
                    setScreen("asset");
                  }}
                />
              )}
            </motion.div>
          </AnimatePresence>

          <div className="mt-6">
            <StatusBar
              status={busyLine ?? status}
              tone={busyLine ? "warn" : status.includes("BLOCKED") || status.includes("failed") ? "bad" : "ok"}
            />
          </div>
        </div>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

export function applicableTier(m: MintInspection) {
  // Defensive: callers normally guard on transferFeeConfig presence; fall back
  // to a 0-fee tier rather than dereferencing null at runtime.
  const cfg = m.transferFeeConfig ?? {
    currentEpoch: 0,
    newerTransferFee: { epoch: 0, maximumFee: "0", transferFeeBasisPoints: 0 },
    olderTransferFee: { epoch: 0, maximumFee: "0", transferFeeBasisPoints: 0 },
  };
  return cfg.currentEpoch >= cfg.newerTransferFee.epoch
    ? cfg.newerTransferFee
    : cfg.olderTransferFee;
}

function shieldAllowed(v: ShieldVerdict, override: boolean): boolean {
  if (v.actions === "block") return false;
  if (v.actions === "confirm_only") return override;
  return true;
}

/* ------------------------------------------------------------------ */
/* SCREEN 1 — Asset                                                    */
/* ------------------------------------------------------------------ */

function AssetScreen({
  asset,
  inspecting,
  inspectError,
  mintInspection,
  onPick,
  onContinue,
}: {
  asset: PreStockAsset | null;
  inspecting: boolean;
  inspectError: string | null;
  mintInspection: MintInspection | null;
  onPick: (a: PreStockAsset) => void;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-terminal text-lg font-bold tracking-tight">Choose PreStock</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          ReynaLens inspects the live Token-2022 mint before anything else. No cached
          assumptions — the chain decides.
        </p>
      </div>

      <div className="space-y-2">
        {PRESTOCK_ASSETS.map((a) => {
          const selected = asset?.mint === a.mint;
          return (
            <button
              key={a.mint}
              onClick={() => void onPick(a)}
              className={`flex w-full items-center justify-between border px-3 py-3 text-left transition-colors ${
                selected
                  ? "border-primary bg-accent"
                  : "border-border bg-card hover:border-primary/50 hover:bg-secondary"
              }`}
            >
              <div>
                <div className="font-terminal text-sm font-bold">${a.ticker}</div>
                <div className="text-[11px] text-muted-foreground">{a.name}</div>
                <div className="font-terminal text-[10px] text-muted-foreground/70">
                  {shortenAddress(a.mint, 6)}
                </div>
              </div>
              {selected && mintInspection && !inspecting && (
                <Check className="size-4 text-status-ok" />
              )}
              {selected && inspecting && <RefreshCw className="size-4 animate-spin text-primary" />}
            </button>
          );
        })}
      </div>

      {inspecting && (
        <TermPanel title="LIVE MINT INSPECTION">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw className="size-3.5 animate-spin" />
            Reading mint account from mainnet…
          </div>
        </TermPanel>
      )}

      {inspectError && (
        <TermPanel title="INSPECTION FAILED" className="border-status-bad">
          <p className="text-xs text-status-bad">{inspectError}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">
            ReynaLens refuses to continue with an unverified asset (Kill Switch A/F).
          </p>
        </TermPanel>
      )}

      {mintInspection && !inspecting && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <TermPanel title="LIVE MINT INSPECTION">
            <div className="space-y-1">
              <KV k="Program" v="Token-2022" tone="ok" />
              <KV k="Decimals" v={String(mintInspection.decimals)} />
              {mintInspection.transferFeeConfig ? (
                <>
                  <KV k="Current epoch" v={String(mintInspection.transferFeeConfig.currentEpoch)} />
                  <KV
                    k="Active fee tier"
                    v={`${applicableTier(mintInspection).transferFeeBasisPoints} bps (epoch ${applicableTier(mintInspection).epoch})`}
                  />
                  <KV
                    k="Maximum fee"
                    v={formatBaseUnits(BigInt(applicableTier(mintInspection).maximumFee), mintInspection.decimals)}
                  />
                  <KV
                    k="Older tier"
                    v={`${mintInspection.transferFeeConfig.olderTransferFee.transferFeeBasisPoints} bps @ epoch ${mintInspection.transferFeeConfig.olderTransferFee.epoch}`}
                  />
                </>
              ) : (
                <KV k="TransferFeeConfig" v="NOT PRESENT — exact-out undefined" tone="bad" />
              )}
              <KV
                k="Transfer hook"
                v={
                  mintInspection.activeTransferHook
                    ? `ACTIVE ${shortenAddress(mintInspection.transferHookProgramId!, 6)}`
                    : "inactive / none"
                }
                tone={mintInspection.activeTransferHook ? "warn" : "ok"}
              />
              <KV
                k="Extensions"
                v={mintInspection.extensions.length > 0 ? String(mintInspection.extensions.length) : "none"}
              />
            </div>
            <div className="mt-2 space-y-0.5 border-t border-border pt-2">
              {mintInspection.notes.map((n, i) => (
                <p key={i} className="text-[10px] leading-4 text-muted-foreground">
                  › {n}
                </p>
              ))}
            </div>
          </TermPanel>

          <Button className="mt-4 w-full" onClick={onContinue} disabled={!mintInspection.transferFeeConfig}>
            Continue to recipient
          </Button>
          {!mintInspection.transferFeeConfig && (
            <p className="mt-2 text-center text-[11px] text-status-bad">
              KILL SWITCH A — no TransferFeeConfig, the exact-out problem is not defined for this asset.
            </p>
          )}
        </motion.div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SCREEN 2 — Recipient                                                */
/* ------------------------------------------------------------------ */

function RecipientScreen({
  asset,
  owner,
  value,
  onChange,
  known,
  onPickKnown,
  onDemoLookalike,
  onEvaluate,
  loading,
}: {
  asset: PreStockAsset | null;
  owner: PublicKey | null;
  value: string;
  onChange: (v: string) => void;
  known: ShieldKnownRecipient[];
  onPickKnown: (address: string) => void;
  onDemoLookalike: () => void;
  onEvaluate: () => void;
  loading: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const valid = (() => {
    try {
      new PublicKey(value.trim());
      return value.trim().length > 0;
    } catch {
      return false;
    }
  })();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-terminal text-lg font-bold tracking-tight">Recipient</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Paste the complete {asset?.ticker ?? "asset"} destination address. ReynaLens
          will verify it before you can continue.
        </p>
      </div>

      <div className="relative">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Full Solana address (32–44 characters)"
          className="h-auto min-h-12 break-all py-3 pr-10 font-terminal text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          onClick={async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text) onChange(text.trim());
            } catch {
              toast.error("Clipboard unavailable — paste manually.");
            }
          }}
          aria-label="Paste"
        >
          <Copy className="size-4" />
        </button>
      </div>
      {value.trim().length > 0 && !valid && (
        <p className="text-[11px] text-status-bad">
          Not a valid base58 Solana address yet.
        </p>
      )}
      {owner && value.trim() === owner.toBase58() && (
        <p className="text-[11px] text-status-warn">This is your own wallet address.</p>
      )}

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Paste the full address — shortened forms are refused.</span>
        <button className="underline hover:text-foreground" onClick={onDemoLookalike}>
          Demo: load lookalike
        </button>
      </div>

      {known.length > 0 && (
        <TermPanel title={`RECIPIENT BOOK (${known.length})`}>
          <div className="space-y-1">
            {known.map((r) => (
              <button
                key={r.address}
                onClick={() => onPickKnown(r.address)}
                className="flex w-full items-center justify-between border border-border bg-card px-2.5 py-2 text-left hover:border-primary/50"
              >
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold">{r.label ?? "Recipient"}</div>
                  <div className="font-terminal text-[10px] text-muted-foreground">
                    {shortenAddress(r.address, 6)}
                  </div>
                </div>
                {r.assetSymbol && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{r.assetSymbol}</span>
                )}
              </button>
            ))}
          </div>
        </TermPanel>
      )}

      <Button
        className="w-full"
        disabled={!valid || loading || !asset}
        onClick={onEvaluate}
      >
        {loading ? (
          <>
            <RefreshCw className="size-4 animate-spin" /> Evaluating…
          </>
        ) : (
          <>
            <ShieldCheck className="size-4" /> Evaluate with Recipient Shield
          </>
        )}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SCREEN 3 — Shield                                                   */
/* ------------------------------------------------------------------ */

function ShieldScreen({
  verdict,
  override,
  onOverride,
  onUsePrevious,
  onEdit,
  onContinue,
}: {
  verdict: ShieldVerdict;
  override: boolean;
  onOverride: () => void;
  onUsePrevious: () => void;
  onEdit: () => void;
  onContinue: () => void;
}) {
  const blocked = verdict.actions === "block";
  const needsAck = verdict.actions === "confirm_only" && !override;
  const toneClass =
    verdict.actions === "block"
      ? "border-status-bad bg-status-bad-soft"
      : verdict.actions === "confirm_only"
        ? "border-status-warn bg-status-warn-soft"
        : "border-status-ok bg-status-ok-soft";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-terminal text-lg font-bold tracking-tight">Recipient Shield</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Observable-signal checks: address validity, your recipient history, and
          similarity to addresses you have used before.
        </p>
      </div>

      <div className={`border px-3 py-3 ${toneClass}`}>
        <div className="flex items-center gap-2">
          <VerdictIcon kind={verdict.kind} />
          <span className="font-terminal text-sm font-bold tracking-terminal">{verdict.title}</span>
        </div>
        <p className="mt-2 text-xs leading-5 text-foreground/90">{verdict.detail}</p>

        {verdict.diffs.length > 0 && verdict.matchedAgainst && (
          <div className="mt-3 border border-border bg-card p-2.5">
            <div className="mb-1.5 text-[10px] uppercase tracking-terminal text-muted-foreground">
              Differing characters highlighted
            </div>
            <DiffAddresses
              expected={verdict.matchedAgainst}
              actual={verdict.enteredAddress ?? ""}
              diffs={verdict.diffs}
            />
          </div>
        )}
      </div>

      {verdict.destinationAccount && (
        <TermPanel title="DESTINATION TOKEN ACCOUNT (TOKEN-2022)">
          <KV
            k="ATA exists"
            v={verdict.destinationAccount.exists ? "yes" : "no — will be created in this transaction"}
            tone={verdict.destinationAccount.exists ? "ok" : "warn"}
          />
          {verdict.destinationAccount.frozen !== null && (
            <KV k="Frozen" v={verdict.destinationAccount.frozen ? "YES" : "no"} tone={verdict.destinationAccount.frozen ? "bad" : "ok"} />
          )}
          {verdict.destinationAccount.balance !== null && (
            <KV k="Current balance" v={`${verdict.destinationAccount.balance} base units`} />
          )}
        </TermPanel>
      )}

      <div className="space-y-2">
        {verdict.kind === "lookalike" && (
          <Button variant="outline" className="w-full" onClick={onUsePrevious}>
            USE PREVIOUS ADDRESS
          </Button>
        )}
        {needsAck && (
          <Button className="w-full" onClick={onOverride}>
            I VERIFIED THIS ADDRESS
          </Button>
        )}
        {!blocked && !needsAck && (
          <Button className="w-full" onClick={onContinue}>
            Continue to amount
          </Button>
        )}
        {needsAck && (
          <Button variant="ghost" className="w-full" onClick={onEdit}>
            Edit address
          </Button>
        )}
        {blocked && (
          <Button variant="outline" className="w-full" onClick={onEdit}>
            Choose a different recipient
          </Button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SCREEN 4 — Amount (exact-out)                                       */
/* ------------------------------------------------------------------ */

function AmountScreen({
  asset,
  mintInspection,
  amountInput,
  onAmountChange,
  amountState,
  balances,
  balanceLoading,
  onRefreshBalance,
  onContinue,
  onBack,
}: {
  asset: PreStockAsset | null;
  mintInspection: MintInspection | null;
  amountInput: string;
  onAmountChange: (v: string) => void;
  amountState:
    | { state: "empty" }
    | { state: "error"; error: string }
    | { state: "ok"; net: bigint; out: ExactOutResult }
    | null;
  balances: WalletBalance | null;
  balanceLoading: boolean;
  onRefreshBalance: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const decimals = mintInspection?.decimals ?? 0;
  const tier = mintInspection?.transferFeeConfig ? applicableTier(mintInspection) : null;
  const tokenBal = balances?.tokenBaseUnits ?? null;
  const maxDeliverable =
    tokenBal !== null && tier
      ? tokenBal - calculateFeeForward(tokenBal, tier.transferFeeBasisPoints, BigInt(tier.maximumFee))
      : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-terminal text-lg font-bold tracking-tight">
          How much should they receive?
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter the exact amount the recipient should get. ReynaLens derives the gross
          transfer from live Token-2022 fee state — never a fixed rule of thumb.
        </p>
      </div>

      <div className="border border-border bg-card px-4 py-5">
        <div className="flex items-baseline gap-2">
          <Input
            value={amountInput}
            onChange={(e) => onAmountChange(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0"
            inputMode="decimal"
            className="h-auto border-0 bg-transparent px-0 text-3xl font-bold tabular-nums focus-visible:ring-0 focus-visible:ring-offset-0"
            aria-label={`Recipient receives ${asset?.ticker ?? ""}`}
          />
          <span className="shrink-0 font-terminal text-sm font-bold text-muted-foreground">
            {asset?.ticker}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            Smallest deliverable: {mintInspection ? formatBaseUnits(1n, decimals) : "—"} {asset?.ticker} (1 base unit — derived from the live fee rules, not a product minimum)
          </span>
          {maxDeliverable !== null && (
            <span>
              Max with balance: {formatBaseUnits(maxDeliverable, decimals)} {asset?.ticker}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          Your balance:{" "}
          {balanceLoading ? (
            <RefreshCw className="inline size-3 animate-spin" />
          ) : tokenBal !== null ? (
            `${formatBaseUnits(tokenBal, decimals)} ${asset?.ticker}`
          ) : (
            `no ${asset?.ticker} account`
          )}
        </span>
        <button className="underline hover:text-foreground" onClick={onRefreshBalance}>
          Refresh
        </button>
      </div>

      {amountState?.state === "error" && (
        <TermPanel title="CANNOT CALCULATE" className="border-status-bad">
          <p className="text-xs leading-5 text-status-bad">{amountState.error}</p>
        </TermPanel>
      )}

      {amountState?.state === "ok" && (
        <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
          <TermPanel title="REYNALENS EXACT — LIVE CALCULATION">
            <KV
              k="Recipient receives"
              v={`${formatBaseUnits(amountState.net, decimals)} ${asset?.ticker}`}
              tone="ok"
            />
            <KV
              k="You send"
              v={`${formatBaseUnits(amountState.out.gross, decimals)} ${asset?.ticker}`}
            />
            <KV
              k="Transfer fee"
              v={`${formatBaseUnits(amountState.out.fee, decimals)} ${asset?.ticker} (${amountState.out.feeBps} bps)`}
              tone="warn"
            />
            {amountState.out.cappedByMaximumFee && (
              <KV k="Fee cap" v="maximumFee applied" tone="warn" />
            )}
            <KV k="Fee tier epoch" v={String(amountState.out.tierEpoch)} />
            {amountState.out.feeBps === 0 && (
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                › The live tier at the current epoch is 0 bps, so gross equals net. This
                comes from the chain, not an assumption.
              </p>
            )}
          </TermPanel>

          <details className="mt-2 border border-border bg-card px-3 py-2">
            <summary className="cursor-pointer text-[10px] uppercase tracking-terminal text-muted-foreground">
              Calculation audit trail
            </summary>
            <div className="mt-2 space-y-0.5">
              {amountState.out.steps.map((s, i) => (
                <p key={i} className="font-terminal text-[10px] leading-4 text-muted-foreground">
                  {i + 1}. {s}
                </p>
              ))}
            </div>
          </details>
        </motion.div>
      )}

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onBack}>
          <ChevronLeft className="size-4" /> Back
        </Button>
        <Button className="flex-[2]" disabled={amountState?.state !== "ok"} onClick={onContinue}>
          Preview transfer
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SCREEN 5 — Preview                                                  */
/* ------------------------------------------------------------------ */

function PreviewScreen({
  asset,
  mintInspection,
  exactOut,
  recipient,
  owner,
  sourceAta,
  balances,
  shieldVerdict,
  onBack,
  onContinue,
}: {
  asset: PreStockAsset | null;
  mintInspection: MintInspection | null;
  exactOut: ExactOutResult | null;
  recipient: string;
  owner: PublicKey | null;
  sourceAta: PublicKey | null;
  balances: WalletBalance | null;
  shieldVerdict: ShieldVerdict | null;
  onBack: () => void;
  onContinue: () => void;
}) {
  const decimals = mintInspection?.decimals ?? 0;
  // Hard-stop only when the chain has answered and the source account is
  // missing. An unset balance (no wallet connected / still loading) must NOT
  // block here.
  const sourceDefinitelyMissing = balances?.sourceAtaExists === false;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-terminal text-lg font-bold tracking-tight">Transfer preview</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Everything below is derived from live chain state. Confirm before the
          simulation gate.
        </p>
      </div>

      <TermPanel title="SUMMARY">
        <KV k="Asset" v={`${asset?.ticker} · Token-2022`} />
        <KV k="Mint" v={<span className="font-terminal text-[10px]">{asset?.mint}</span>} />
        <KV
          k="Recipient receives"
          v={exactOut ? `${formatBaseUnits(exactOut.net, decimals)} ${asset?.ticker}` : "—"}
          tone="ok"
        />
        <KV
          k="You send"
          v={exactOut ? `${formatBaseUnits(exactOut.gross, decimals)} ${asset?.ticker}` : "—"}
        />
        <KV
          k="Transfer fee"
          v={exactOut ? `${formatBaseUnits(exactOut.fee, decimals)} ${asset?.ticker}` : "—"}
          tone="warn"
        />
        <KV k="Network fee (est.)" v={`${lamportsToSol(ESTIMATED_SOL_FEE_LAMPORTS)} SOL`} />
        <KV
          k="Source account"
          v={
            balances?.sourceAtaExists
              ? "exists"
              : "missing — you need a source balance first"
          }
          tone={balances?.sourceAtaExists ? "ok" : "bad"}
        />
        <KV
          k="Destination ATA"
          v={shieldVerdict?.destinationAccount?.needsCreation ? "will be created" : "exists"}
          tone={shieldVerdict?.destinationAccount?.needsCreation ? "warn" : "ok"}
        />
      </TermPanel>

      {sourceDefinitelyMissing && (
        <p className="text-[11px] leading-5 text-status-bad">
          Your wallet has no {asset?.ticker} token account, so this transfer cannot
          execute. Acquire {asset?.ticker} first — the simulation gate would fail
          here anyway.
        </p>
      )}

      {sourceAta && <FullAddressBox address={recipient} />}
      {owner && (
        <p className="text-[10px] text-muted-foreground">
          From your wallet {shortenAddress(owner.toBase58(), 6)}
        </p>
      )}

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onBack}>
          <ChevronLeft className="size-4" /> Back
        </Button>
        <Button
          className="flex-[2]"
          onClick={onContinue}
          disabled={!exactOut || sourceDefinitelyMissing}
        >
          Run simulation gate
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SCREEN 6 — Preflight / simulation                                   */
/* ------------------------------------------------------------------ */

function PreflightScreen({
  asset,
  sim,
  simulating,
  built,
  onRetry,
  onBack,
  onContinue,
}: {
  asset: PreStockAsset | null;
  sim: { ok: boolean; error?: string; logs?: string[] } | null;
  simulating: boolean;
  built: BuiltTransfer | null;
  onRetry: () => Promise<{ ok: boolean; error?: string }>;
  onBack: () => void;
  onContinue: () => void;
}) {
  const logs = sim?.logs ?? [];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-terminal text-lg font-bold tracking-tight">Simulation gate</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          The transaction runs against mainnet state before your wallet is ever asked
          to sign. Failures block signing — always.
        </p>
      </div>

      <TermPanel
        title={simulating ? "SIMULATING…" : sim?.ok ? "SIMULATION PASSED" : sim ? "SIMULATION FAILED" : "PENDING"}
        className={sim?.ok ? "border-status-ok" : sim && !sim.ok ? "border-status-bad" : undefined}
      >
        {simulating && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw className="size-3.5 animate-spin" /> Simulating {asset?.ticker} transfer…
          </div>
        )}
        {!simulating && sim?.ok && (
          <div className="space-y-1">
            <KV k="Result" v="READY TO SIGN" tone="ok" />
            <KV k="Instructions" v={String(built?.transaction.instructions.length ?? 0)} />
            {built && built.hookAccounts.length > 0 && (
              <KV k="Hook accounts" v={String(built.hookAccounts.length)} tone="warn" />
            )}
          </div>
        )}
        {!simulating && sim && !sim.ok && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-status-bad">TRANSACTION BLOCKED</p>
            <p className="text-xs leading-5 text-foreground/90">{sim.error}</p>
          </div>
        )}
        {logs.length > 0 && (
          <details className="mt-2 border-t border-border pt-2" open={!sim?.ok}>
            <summary className="cursor-pointer text-[10px] uppercase tracking-terminal text-muted-foreground">
              Program logs ({logs.length})
            </summary>
            <div className="mt-1.5 max-h-44 space-y-0.5 overflow-auto">
              {logs.slice(-24).map((l, i) => (
                <p key={i} className="font-terminal text-[10px] leading-4 text-muted-foreground">
                  {l}
                </p>
              ))}
            </div>
          </details>
        )}
      </TermPanel>

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onBack}>
          <ChevronLeft className="size-4" /> Back
        </Button>
        {sim && !sim.ok && !simulating && (
          <Button variant="outline" className="flex-1" onClick={() => void onRetry()}>
            <RefreshCw className="size-4" /> Retry
          </Button>
        )}
        <Button className="flex-[2]" disabled={!sim?.ok || simulating} onClick={onContinue}>
          Continue to signing
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SCREEN 7 — Signing                                                  */
/* ------------------------------------------------------------------ */

function SigningScreen({
  asset,
  mintInspection,
  exactOut,
  recipient,
  owner,
  connected,
  addressConfirmed,
  onAddressConfirmed,
  busy,
  busyLine,
  onExecute,
  onBack,
  detectedWallets,
  onConnect,
}: {
  asset: PreStockAsset | null;
  mintInspection: MintInspection | null;
  exactOut: ExactOutResult | null;
  recipient: string;
  owner: PublicKey | null;
  connected: boolean;
  addressConfirmed: boolean;
  onAddressConfirmed: (v: boolean) => void;
  busy: boolean;
  busyLine: string | null;
  onExecute: () => void;
  onBack: () => void;
  detectedWallets: string[];
  onConnect: (name: string) => void;
}) {
  const decimals = mintInspection?.decimals ?? 0;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-terminal text-lg font-bold tracking-tight">Sign transaction</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          ReynaLens never sees your keys. You approve the exact transaction in your own
          wallet.
        </p>
      </div>

      <FullAddressBox address={recipient} />

      <TermPanel title="FINAL TERMS (SIMULATED ✓)">
        <KV
          k="Recipient receives"
          v={exactOut ? `${formatBaseUnits(exactOut.net, decimals)} ${asset?.ticker}` : "—"}
          tone="ok"
        />
        <KV
          k="You send"
          v={exactOut ? `${formatBaseUnits(exactOut.gross, decimals)} ${asset?.ticker}` : "—"}
        />
        <KV
          k="Transfer fee"
          v={exactOut ? `${formatBaseUnits(exactOut.fee, decimals)} ${asset?.ticker}` : "—"}
          tone="warn"
        />
      </TermPanel>

      <label className="flex cursor-pointer items-start gap-2.5 border border-border bg-card px-3 py-3">
        <input
          type="checkbox"
          checked={addressConfirmed}
          onChange={(e) => onAddressConfirmed(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[#17683a]"
        />
        <span className="text-xs leading-5">
          I am about to send this asset to <span className="font-semibold">THIS exact address</span>. I
          have read every character above.
        </span>
      </label>

      {busy && busyLine && (
        <div className="flex items-center gap-2 border border-border bg-secondary px-3 py-2 text-xs">
          <RefreshCw className="size-3.5 animate-spin text-primary" />
          {busyLine}
        </div>
      )}

      {!connected ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Connect a wallet to sign:</p>
          <div className="flex flex-wrap gap-2">
            {detectedWallets.length === 0 && (
              <p className="text-xs text-status-bad">No wallet detected in this browser.</p>
            )}
            {detectedWallets.map((name) => (
              <Button key={name} variant="outline" size="sm" onClick={() => onConnect(name)}>
                <Wallet className="size-3.5" /> {name}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onBack} disabled={busy}>
            <ChevronLeft className="size-4" /> Back
          </Button>
          <Button
            className="flex-[2]"
            disabled={!addressConfirmed || busy || !exactOut || !owner}
            onClick={onExecute}
          >
            {busy ? "Signing…" : "APPROVE IN WALLET"}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SCREEN 8 — Receipt                                                  */
/* ------------------------------------------------------------------ */

function ReceiptScreen({
  asset,
  mintInspection,
  exactOut,
  verification,
  recipient,
  onNewTransfer,
}: {
  asset: PreStockAsset | null;
  mintInspection: MintInspection | null;
  exactOut: ExactOutResult | null;
  verification: DeliveryVerification | null;
  recipient: string;
  onNewTransfer: () => void;
}) {
  const decimals = mintInspection?.decimals ?? 0;
  if (!verification || !exactOut || !asset) {
    return (
      <TermPanel title="REYNALENS RECEIPT">
        <p className="text-xs text-muted-foreground">No completed transfer in this session.</p>
      </TermPanel>
    );
  }
  const verified = verification.matchesRequested;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <FileCheck className={`size-5 ${verified ? "text-status-ok" : "text-status-bad"}`} />
        <h1 className="font-terminal text-lg font-bold tracking-tight">ReynaLens Receipt</h1>
      </div>

      <TermPanel
        title={verified ? "✓ VERIFIED ON SOLANA" : "MISMATCH — REVIEW"}
        className={verified ? "border-status-ok" : "border-status-bad"}
      >
        <KV k="Asset" v={`${asset.ticker} (PreStocks)`} />
        <KV
          k="Recipient should receive"
          v={`${formatBaseUnits(exactOut.net, decimals)} ${asset.ticker}`}
        />
        <KV k="Sent from your wallet" v={`${formatBaseUnits(exactOut.gross, decimals)} ${asset.ticker}`} />
        <KV k="Transfer fee" v={`${formatBaseUnits(exactOut.fee, decimals)} ${asset.ticker}`} tone="warn" />
        <KV
          k="Actually received"
          v={`${formatBaseUnits(verification.actuallyReceived, decimals)} ${asset.ticker}`}
          tone={verified ? "ok" : "bad"}
        />
        <KV
          k="Verification"
          v={
            verified
              ? "destination delta == requested amount"
              : `delta ${formatBaseUnits(verification.actuallyReceived, decimals)} != requested ${formatBaseUnits(exactOut.net, decimals)}`
          }
          tone={verified ? "ok" : "bad"}
        />
      </TermPanel>

      <TermPanel title="PROOF">
        <div className="space-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-terminal text-muted-foreground">Recipient</div>
            <button
              className="mt-0.5 flex items-start gap-1.5 break-all text-left font-terminal text-[11px] text-foreground"
              onClick={() => {
                void navigator.clipboard.writeText(recipient);
                toast("Recipient address copied.");
              }}
            >
              {recipient}
              <Copy className="mt-0.5 size-3 shrink-0" />
            </button>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-terminal text-muted-foreground">Transaction</div>
            <a
              href={explorerTxUrl(verification.signature)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 flex items-start gap-1.5 break-all font-terminal text-[11px] text-primary underline"
            >
              {verification.signature}
              <ExternalLink className="mt-0.5 size-3 shrink-0" />
            </a>
          </div>
          <a
            href={explorerAccountUrl(recipient)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline hover:text-foreground"
          >
            <ExternalLink className="size-3" /> View recipient token account on Solscan
          </a>
          <KV k="Slot" v={verification.slot ? String(verification.slot) : "—"} />
          <KV k="Status" v={verification.confirmationStatus ?? "—"} tone={verified ? "ok" : "bad"} />
        </div>
      </TermPanel>

      <Button className="w-full" onClick={onNewTransfer}>
        Start a new transfer
      </Button>
    </div>
  );
}

