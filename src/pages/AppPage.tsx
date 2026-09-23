import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { motion, AnimatePresence } from "framer-motion";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  FileCheck,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  readBalanceOrZero,
  verifyDelivery,
  confirmSignature,
  type DeliveryVerification,
} from "@/lib/solana/verify";
import {
  readWalletBalance,
  estimateTransactionFeeLamports,
  ESTIMATED_SOL_FEE_LAMPORTS,
  lamportsToSol,
  type WalletBalance,
} from "@/lib/solana/balance";
import {
  evaluatePreflight,
  estimateAtaRentLamports,
} from "@/lib/solana/preflight";
import {
  saveTransferIntent,
  loadTransferIntent,
  clearTransferIntent,
} from "@/lib/transferIntent";
import { useWalletConnect } from "@/hooks/use-wallet-connect";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
type Phase = "compose" | "preview" | "receipt";

/** Deterministic Sign & Send states (P0 Part G). */
type SignPhase =
  | "idle" // connected, no attempt yet → Sign & Send
  | "preflight" // reading live balances / requirements
  | "simulating" // real transaction simulation
  | "insufficient_token" // stop before signature, friendly balance error
  | "insufficient_sol" // stop before signature, friendly SOL error
  | "failed" // simulation/other failure, no signature prompt
  | "ready" // simulated OK, waiting for explicit user consent
  | "signing" // wallet signature prompt open
  | "submitted" // on-chain confirmation in progress
  | "confirmed"; // verified receipt phase

export default function AppPage() {
  const {
    connected,
    connecting,
    address: walletAddress,
    available: availableWallets,
    connectWallet,
    disconnectWallet,
  } = useWalletConnect();

  const { sendTransaction } = useWallet();

  const recipientRows = useQuery(api.recipients.listRecipients);
  const recordRecipient = useMutation(api.recipients.recordVerifiedRecipient);
  const saveReceiptMut = useMutation(api.recipients.saveReceipt);

  const [phase, setPhase] = useState<Phase>("compose");
  const [asset, setAsset] = useState<PreStockAsset | null>(null);
  const [mintInspection, setMintInspection] = useState<MintInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [recipientInput, setRecipientInput] = useState("");
  const [shieldVerdict, setShieldVerdict] = useState<ShieldVerdict | null>(null);
  const [shieldLoading, setShieldLoading] = useState(false);
  const [amountInput, setAmountInput] = useState("");
  const [balances, setBalances] = useState<WalletBalance | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [verification, setVerification] = useState<DeliveryVerification | null>(null);
  const [finalExactOut, setFinalExactOut] = useState<ExactOutResult | null>(null);
  const [signPhase, setSignPhase] = useState<SignPhase>("idle");
  /** Explicit user consent between a successful simulation and the signature. */
  const confirmedReadyRef = useRef(false);

  const owner = walletAddress ? new PublicKey(walletAddress) : null;
  const mintPubkey = useMemo(() => (asset ? new PublicKey(asset.mint) : null), [asset]);
  const sourceAta = useMemo(
    () =>
      owner && mintPubkey
        ? getAssociatedTokenAddressSync(mintPubkey, owner, false, TOKEN_2022_PROGRAM_ID)
        : null,
    [owner, mintPubkey],
  );

  // Recipient history is genuine, per-user data only (no demo seeds). A judge
  // without a session simply gets an empty history — Shield still runs its real
  // structural + on-chain destination checks.
  const knownRecipients: ShieldKnownRecipient[] = useMemo(
    () =>
      (recipientRows ?? []).map((r) => ({
        address: r.address,
        label: r.label,
        assetSymbol: r.assetSymbol,
        lastUsedAt: r.lastUsedAt ?? 0,
      })),
    [recipientRows],
  );

  const refreshBalances = useCallback(async () => {
    if (!owner || !mintPubkey) return;
    try {
      const b = await readWalletBalance(rpc, owner, mintPubkey);
      setBalances(b);
    } catch {
      /* balance read is advisory only */
    }
  }, [owner, mintPubkey]);

  useEffect(() => {
    if (owner && mintPubkey) void refreshBalances();
  }, [owner, mintPubkey, refreshBalances]);

  const pickAsset = useCallback(async (a: PreStockAsset) => {
    setAsset(a);
    setMintInspection(null);
    setInspectError(null);
    setInspecting(true);
    try {
      const info = await inspectMint(rpc, new PublicKey(a.mint));
      setMintInspection(info);
    } catch (e) {
      setInspectError(friendlyRpcError(e instanceof Error ? e.message : String(e)));
    } finally {
      setInspecting(false);
    }
  }, []);

  // ── Restore in-progress transfer intent after lifecycle remounts ────────
  // Mobile deep links and ordinary reloads unmount this component. Session
  // persistence keeps the user's INTENT (mint, recipient, amount, phase);
  // every chain-derived value is recomputed live below — the stored intent is
  // never treated as authoritative chain state. Never auto-signs.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const intent = loadTransferIntent();
    if (!intent) return;
    const mintAsset = PRESTOCK_ASSETS.find((a) => a.mint === intent.mint);
    if (!mintAsset) return;
    setAsset(mintAsset);
    setRecipientInput(intent.recipient);
    setAmountInput(intent.amount);
    setPhase(intent.phase === "preview" ? "preview" : "compose");
    if (intent.phase !== "preview") return;
    void (async () => {
      setInspecting(true);
      try {
        const info = await inspectMint(rpc, new PublicKey(mintAsset.mint));
        setMintInspection(info);
        // Re-run the recipient checks against live state (history is rebuilt
        // by the reactive query; restore uses what is currently available).
        const verdict = await evaluateRecipientShield({
          address: intent.recipient,
          selfAddress: walletAddress ?? "",
          knownRecipients: (recipientRows ?? []).map((r) => ({
            address: r.address,
            label: r.label,
            assetSymbol: r.assetSymbol,
            lastUsedAt: r.lastUsedAt ?? 0,
          })),
          mint: info,
          connection: rpc,
          mintPubkey: new PublicKey(mintAsset.mint),
        });
        if (verdict.actions === "block") {
          toast.error(verdict.title, { description: verdict.detail });
          setPhase("compose");
          return;
        }
        setShieldVerdict(verdict);
      } catch {
        setInspectError(friendlyRpcError("Could not restore live mint state."));
        setPhase("compose");
      } finally {
        setInspecting(false);
      }
    })();
    // Restore runs exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the user's intent on every change. Phase "receipt" is deliberately
  // stored as "preview": after a completed transfer a restored session returns
  // to Preview with the live values recomputed, never to a fabricated receipt.
  useEffect(() => {
    if (!asset || !recipientInput.trim() || !amountInput.trim()) return;
    saveTransferIntent({
      mint: asset.mint,
      recipient: recipientInput.trim(),
      amount: amountInput,
      phase: phase === "receipt" ? "preview" : phase,
    });
  }, [asset, recipientInput, amountInput, phase]);

  // P0 fix: Preview must NOT require a wallet. The previous `!owner` guard made
  // the Preview button a silent no-op for disconnected users. selfAddress is
  // only used for self-transfer / lookalike-of-self similarity checks; an empty
  // string disables those gracefully when no wallet is connected. The wallet is
  // requested for the first time at Sign.
  const runShieldThenPreview = useCallback(async () => {
    if (!asset || !mintInspection || !mintPubkey) return;
    const trimmed = recipientInput.trim();
    setShieldLoading(true);
    setShieldVerdict(null);
    try {
      const verdict = await evaluateRecipientShield({
        address: trimmed,
        selfAddress: owner?.toBase58() ?? "",
        knownRecipients,
        mint: mintInspection,
        connection: rpc,
        mintPubkey,
      });
      setShieldVerdict(verdict);
      if (verdict.actions === "block") {
        toast.error(verdict.title, { description: verdict.detail });
        return;
      }
      setPhase("preview");
    } catch (e) {
      toast.error("Recipient check failed", {
        description: friendlyRpcError(e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setShieldLoading(false);
    }
  }, [owner, asset, mintInspection, mintPubkey, recipientInput, knownRecipients]);

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
          "This mint has no TransferFeeConfig. The exact-out problem is not defined — stopping.",
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
          ? "This amount cannot be delivered exactly under the live fee rules. Try a slightly different amount."
          : msg,
      };
    }

    const tokenBal = balances?.tokenBaseUnits ?? null;
    if (tokenBal !== null && out.gross > tokenBal) {
      const deliverable = calculateFeeForward(
        tokenBal,
        tier.transferFeeBasisPoints,
        BigInt(tier.maximumFee),
      );
      return {
        state: "error" as const,
        error: `You do not have enough ${asset.ticker} to deliver this amount after the current fee. Your balance delivers at most ${formatBaseUnits(tokenBal - deliverable, decimals)} ${asset.ticker}.`,
      };
    }

    return { state: "ok" as const, net, out };
  }, [asset, mintInspection, amountInput, balances]);

  const exactOut = amountState?.state === "ok" ? amountState.out : null;

  const executeTransfer = useCallback(async () => {
    if (!owner || !asset || !mintInspection || !mintPubkey || !exactOut) {
      return;
    }
    setBusy(true);
    setSimError(null);
    setSignPhase("preflight");
    try {
      // ── Pre-sign preflight (P0 Part C) — before ANY wallet prompt ──
      setBusyLine("Checking balances for this transfer…");
      const [freshBalances, txFeeLamports] = await Promise.all([
        readWalletBalance(rpc, owner, mintPubkey),
        estimateTransactionFeeLamports(rpc),
      ]);
      setBalances(freshBalances);
      const needsAtaNow =
        !shieldVerdict || (shieldVerdict.destinationAccount?.needsCreation ?? true);
      const ataRentLamports = needsAtaNow
        ? ((await estimateAtaRentLamports(rpc, mintInspection, mintPubkey)) ?? 0)
        : 0;
      const pre = evaluatePreflight({
        tokenBalance: freshBalances.tokenBaseUnits ?? 0n,
        gross: exactOut.gross,
        decimals: mintInspection.decimals,
        ticker: asset.ticker,
        solLamports: freshBalances.solLamports,
        txFeeLamports,
        ataRentLamports,
      });
      if (pre.kind !== "ok") {
        // Stop here: the wallet is never asked to sign without sufficient
        // PreStock balance and SOL for fees + any required account rent.
        setSignPhase(pre.kind);
        setSimError(pre.message);
        return;
      }

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
          toast.info("Fee configuration changed", {
            description: "The live fee changed before signing. The transfer was recalculated.",
          });
        }
      }

      setSignPhase("simulating");
      setBusyLine("Building and simulating transaction…");
      const recipientPk = new PublicKey(recipientInput.trim());
      const destinationAta = deriveRecipientAta(recipientPk, mintPubkey);
      const needsAtaCreation = shieldVerdict.destinationAccount?.needsCreation ?? true;
      const built: BuiltTransfer = await buildTransferTransaction({
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
      const sim = await simulateTransfer(rpc, built.transaction, owner);
      if (!sim.ok) {
        const reason = sim.error ?? "Preflight simulation failed.";
        setSignPhase("failed");
        setSimError(reason);
        toast.error("Transfer blocked", { description: reason });
        return;
      }

      // Simulation succeeded. Signature is a separate explicit step (P0 Part
      // E): stop at the wallet-signing boundary until the user asks for it.
      if (!confirmedReadyRef.current) {
        setSignPhase("ready");
        return;
      }

      setBusyLine("Reading destination balance before transfer…");
      const pre = needsAtaCreation ? 0n : await readBalanceOrZero(rpc, destinationAta);

      setSignPhase("signing");
      setBusyLine("Waiting for wallet signature…");
      const latest = await rpc.getLatestBlockhash("confirmed");
      const tx = built.transaction;
      tx.recentBlockhash = latest.blockhash;
      tx.feePayer = owner;
      const sig = await sendTransaction(tx, rpc);

      setSignPhase("submitted");
      setBusyLine("Confirming on Solana…");
      const confirmation = await confirmSignature(rpc, sig);
      if (!confirmation.ok) {
        const reason =
          confirmation.error ??
          "The transaction did not confirm in time. Check the explorer before retrying — do not double-send.";
        toast.error("Confirmation not verified", { description: reason });
        setSimError(reason);
        setSignPhase("failed");
        return;
      }

      setBusyLine("Verifying actual delivery…");
      const proof = await verifyDelivery({
        connection: rpc,
        destinationAta,
        preBalanceBaseUnits: pre,
        requestedNet: effective.net,
        signature: sig,
      });
      setSignPhase("confirmed");
      setVerification(proof);
      setFinalExactOut(effective);

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
        /* history persistence must never block the proof */
      }

      setPhase("receipt");
      if (!proof.matchesRequested) {
        toast.error("Delivery mismatch", {
          description: "The verified amount differs from the request. Review the receipt.",
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const friendly = /rejected|denied|declined/i.test(msg)
        ? "You rejected the transaction in your wallet. Nothing was sent."
        : friendlyRpcError(msg);
      setSimError(friendly);
      setSignPhase("failed");
      toast.error("Transfer failed", { description: friendly });
    } finally {
      setBusy(false);
      setBusyLine(null);
    }
  }, [
    owner, asset, mintInspection, mintPubkey, exactOut, shieldVerdict,
    sourceAta, recipientInput, sendTransaction, recordRecipient, saveReceiptMut,
  ]);

  // The explicit consent step between a successful simulation and the wallet
  // prompt (P0 Part E). Re-running executeTransfer re-verifies balances and
  // re-simulates — nothing is signed automatically.
  const requestSignature = useCallback(() => {
    confirmedReadyRef.current = true;
    setSignPhase("preflight");
    void executeTransfer();
  }, [executeTransfer]);

  const canPreview =
    !!asset &&
    !!mintInspection &&
    !inspectError &&
    recipientValid(recipientInput) &&
    amountState?.state === "ok" &&
    !shieldLoading;

  const startNewTransfer = () => {
    setAsset(null);
    setMintInspection(null);
    setInspectError(null);
    setRecipientInput("");
    setShieldVerdict(null);
    setAmountInput("");
    setBalances(null);
    setVerification(null);
    setFinalExactOut(null);
    setSimError(null);
    setSignPhase("idle");
    setPhase("compose");
    clearTransferIntent();
  };

  return (
    <main className="min-h-dvh bg-gradient-to-b from-background to-secondary/40">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-10">
        <header className="flex items-center justify-between gap-3 py-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">ReynaLens</h1>
            <p className="truncate text-xs text-muted-foreground">
              Send exactly what you mean.
            </p>
          </div>
          <WalletControl
            connected={connected}
            connecting={connecting}
            address={walletAddress}
            available={availableWallets}
            onConnect={connectWallet}
            onDisconnect={disconnectWallet}
          />
        </header>

        <AnimatePresence mode="wait">
          <motion.div
            key={phase}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="flex-1"
          >
            {phase === "compose" && (
              <ComposePhase
                asset={asset}
                inspecting={inspecting}
                inspectError={inspectError}
                mintInspection={mintInspection}
                onPick={pickAsset}
                recipientInput={recipientInput}
                onRecipientChange={(v) => {
                  setRecipientInput(v);
                  setShieldVerdict(null);
                }}
                ownerAddress={walletAddress}
                knownRecipients={knownRecipients}
                onPickKnown={(addr) => {
                  setRecipientInput(addr);
                  setShieldVerdict(null);
                }}
                onRetry={(a) => void pickAsset(a)}
                amountInput={amountInput}
                onAmountChange={setAmountInput}
                amountState={amountState}
                exactOut={exactOut}
                balances={balances}
                shieldLoading={shieldLoading}
                canPreview={canPreview}
                onPreview={runShieldThenPreview}
              />
            )}

            {phase === "preview" && (
              <PreviewPhase
                asset={asset}
                mintInspection={mintInspection}
                exactOut={exactOut}
                recipient={recipientInput.trim()}
                shieldVerdict={shieldVerdict}
                owner={owner}
                busy={busy}
                busyLine={busyLine}
                simError={simError}
                signPhase={signPhase}
                connected={connected}
                connecting={connecting}
                availableWallets={availableWallets}
                onConnect={connectWallet}
                onSign={executeTransfer}
                onRequestSignature={requestSignature}
                onBack={() => {
                  setSignPhase("idle");
                  setPhase("compose");
                }}
              />
            )}

            {phase === "receipt" && (
              <ReceiptPhase
                asset={asset}
                mintInspection={mintInspection}
                exactOut={finalExactOut}
                verification={verification}
                recipient={recipientInput.trim()}
                onNewTransfer={startNewTransfer}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </main>
  );
}

function WalletControl({
  connected,
  connecting,
  address,
  available,
  onConnect,
  onDisconnect,
}: {
  connected: boolean;
  connecting: boolean;
  address: string | null;
  available: string[];
  onConnect: (name: string) => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (connected && address) {
    return (
      <div className="flex shrink-0 items-center gap-2 rounded-full border bg-card py-1 pl-3 pr-1 shadow-sm">
        <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
        <button
          type="button"
          className="text-xs font-medium tabular-nums"
          onClick={() => {
            void navigator.clipboard.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          title="Copy full address"
        >
          {copied ? "Copied" : shortenAddress(address, 4)}
        </button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 rounded-full px-2 text-xs text-muted-foreground"
          onClick={onDisconnect}
        >
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <div className="relative shrink-0">
      <Button
        className="rounded-full"
        size="sm"
        disabled={connecting}
        onClick={() => setOpen((v) => !v)}
      >
        {connecting ? (
          <>
            <Loader2 className="size-4 animate-spin" /> Connecting…
          </>
        ) : (
          <>
            <Wallet className="size-4" /> Connect
          </>
        )}
      </Button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close wallet picker"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-11 z-40 w-60 overflow-hidden rounded-2xl border bg-card shadow-lg">
            <div className="border-b px-4 py-2.5 text-xs font-medium text-muted-foreground">
              Choose a wallet
            </div>
            {available.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground">
                No Solana wallet detected. Install Phantom or Solflare, or open this
                page in a wallet-enabled browser.
              </p>
            ) : (
              available.map((name) => (
                <button
                  type="button"
                  key={name}
                  className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium transition-colors hover:bg-secondary"
                  onClick={() => {
                    setOpen(false);
                    onConnect(name);
                  }}
                >
                  {name}
                  <ArrowRight className="size-4 text-muted-foreground" />
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ComposePhase({
  asset,
  inspecting,
  inspectError,
  mintInspection,
  onPick,
  recipientInput,
  onRecipientChange,
  ownerAddress,
  knownRecipients,
  onPickKnown,
  onRetry,
  amountInput,
  onAmountChange,
  amountState,
  exactOut,
  balances,
  shieldLoading,
  canPreview,
  onPreview,
}: {
  asset: PreStockAsset | null;
  inspecting: boolean;
  inspectError: string | null;
  mintInspection: MintInspection | null;
  onPick: (a: PreStockAsset) => void;
  recipientInput: string;
  onRecipientChange: (v: string) => void;
  ownerAddress: string | null;
  knownRecipients: ShieldKnownRecipient[];
  onPickKnown: (address: string) => void;
  onRetry: (a: PreStockAsset) => void;
  amountInput: string;
  onAmountChange: (v: string) => void;
  amountState:
    | { state: "empty" }
    | { state: "error"; error: string }
    | { state: "ok"; net: bigint; out: ExactOutResult }
    | null;
  exactOut: ExactOutResult | null;
  balances: WalletBalance | null;
  shieldLoading: boolean;
  canPreview: boolean;
  onPreview: () => void;
}) {
  const decimals = mintInspection?.decimals ?? 9;
  const ticker = asset?.ticker ?? "";

  return (
    <div className="space-y-4">
      <Card>
        <SectionLabel>Asset</SectionLabel>
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESTOCK_ASSETS.map((a) => {
            const selected = asset?.mint === a.mint;
            return (
              <button
                type="button"
                key={a.mint}
                onClick={() => void onPick(a)}
                className={`min-w-[calc(50%-0.25rem)] flex-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? "border-primary bg-primary/10"
                    : "border-border bg-card hover:border-primary/40"
                }`}
              >
                <div className="text-sm font-semibold">{a.ticker}</div>
                <div className="text-[11px] leading-tight text-muted-foreground">
                  {a.name}
                </div>
              </button>
            );
          })}
        </div>
        {inspecting && (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Reading live mint from mainnet…
          </p>
        )}
        {inspectError && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-destructive">{inspectError}</p>
            {asset && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-full text-xs"
                onClick={() => onRetry(asset)}
              >
                Retry
              </Button>
            )}
          </div>
        )}
        {mintInspection && !inspecting && (
          <p className="mt-3 text-xs text-muted-foreground">
            Live fee{" "}
            <span className="font-medium text-foreground">
              {applicableTier(mintInspection).transferFeeBasisPoints} bps
            </span>{" "}
            · {mintInspection.decimals} decimals · Token-2022
          </p>
        )}
      </Card>

      <Card>
        <SectionLabel>Recipient</SectionLabel>
        <Input
          value={recipientInput}
          onChange={(e) => onRecipientChange(e.target.value)}
          placeholder="Solana address (32–44 characters)"
          className="mt-2 min-h-12 break-all font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        {recipientInput.trim().length > 0 && !recipientValid(recipientInput) && (
          <p className="mt-2 text-xs text-destructive">Not a valid Solana address yet.</p>
        )}
        {ownerAddress && recipientInput.trim() === ownerAddress && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            This is your own wallet address.
          </p>
        )}
        {knownRecipients.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <p className="text-[11px] text-muted-foreground">Previously used</p>
            <div className="flex flex-wrap gap-1.5">
              {knownRecipients.slice(0, 4).map((r) => (
                <button
                  type="button"
                  key={r.address}
                  onClick={() => onPickKnown(r.address)}
                  className="max-w-full truncate rounded-full border bg-secondary px-2.5 py-1 text-[11px] hover:border-primary/40"
                  title={r.address}
                >
                  {r.label ?? shortenAddress(r.address, 4)}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card>
        <SectionLabel>Recipient receives</SectionLabel>
        <div className="mt-1 flex items-baseline gap-2">
          <Input
            value={amountInput}
            onChange={(e) => onAmountChange(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
            className="min-h-12 border-0 bg-transparent px-0 text-3xl font-semibold shadow-none focus-visible:ring-0 dark:bg-transparent"
            inputMode="decimal"
            autoComplete="off"
          />
          <span className="shrink-0 text-sm font-semibold text-muted-foreground">
            {ticker || "—"}
          </span>
        </div>
        {amountState?.state === "error" && (
          <p className="mt-2 text-xs text-destructive">{amountState.error}</p>
        )}
        {exactOut && (
          <div className="mt-2 space-y-1.5 border-t pt-2.5 text-xs">
            <Row k="You send" v={`${formatBaseUnits(exactOut.gross, decimals)} ${ticker}`} />
            <Row k="Transfer fee" v={`${formatBaseUnits(exactOut.fee, decimals)} ${ticker}`} />
          </div>
        )}
        {balances && balances.tokenBaseUnits !== null && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Wallet balance: {formatBaseUnits(balances.tokenBaseUnits, decimals)} {ticker}
          </p>
        )}
      </Card>

      <div className="sticky bottom-3 -mx-4 px-4 pb-[env(safe-area-inset-bottom)]">
        <Button
          className="h-13 w-full rounded-2xl text-base font-semibold shadow-lg"
          disabled={!canPreview || shieldLoading || inspecting}
          onClick={onPreview}
        >
          {shieldLoading ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Checking recipient…
            </>
          ) : (
            <>
              Preview Transfer <ArrowRight className="size-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function PreviewPhase({
  asset,
  mintInspection,
  exactOut,
  recipient,
  shieldVerdict,
  owner,
  busy,
  busyLine,
  simError,
  signPhase,
  connected,
  connecting,
  availableWallets,
  onConnect,
  onSign,
  onBack,
}: {
  asset: PreStockAsset | null;
  mintInspection: MintInspection | null;
  exactOut: ExactOutResult | null;
  recipient: string;
  shieldVerdict: ShieldVerdict | null;
  owner: PublicKey | null;
  busy: boolean;
  busyLine: string | null;
  simError: string | null;
  signPhase: SignPhase;
  connected: boolean;
  connecting: boolean;
  availableWallets: string[];
  onConnect: (name: string) => void;
  onSign: () => void;
  onRequestSignature: () => void;
  onBack: () => void;
}) {
  const decimals = mintInspection?.decimals ?? 9;
  const ticker = asset?.ticker ?? "";
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="phase-y space-y-4">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-9 rounded-full"
          onClick={onBack}
          disabled={busy}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <h2 className="text-base font-semibold">Transfer preview</h2>
      </div>

      <Card>
        <div className="rounded-2xl bg-primary/5 p-4 text-center">
          <p className="text-xs text-muted-foreground">Recipient receives</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            {exactOut ? formatBaseUnits(exactOut.net, decimals) : "—"}{" "}
            <span className="text-base font-medium">{ticker}</span>
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Exactly this amount — no more, no less.
          </p>
        </div>
        <div className="mt-4 space-y-2 text-sm">
          <Row
            k="You send"
            v={exactOut ? `${formatBaseUnits(exactOut.gross, decimals)} ${ticker}` : "—"}
          />
          <Row
            k="Transfer fee"
            v={exactOut ? `${formatBaseUnits(exactOut.fee, decimals)} ${ticker}` : "—"}
          />
          <Row
            k="Live fee rate"
            v={
              mintInspection
                ? `${applicableTier(mintInspection).transferFeeBasisPoints} bps · epoch ${applicableTier(mintInspection).epoch}`
                : "—"
            }
          />
          <Row k="Network fee (est.)" v={`${lamportsToSol(ESTIMATED_SOL_FEE_LAMPORTS)} SOL`} />
        </div>
      </Card>

      <Card>
        <SectionLabel>Recipient</SectionLabel>
        <p className="mt-2 break-all font-mono text-xs">{recipient}</p>
        <div className="mt-4 space-y-1.5">
          <SectionLabel>Recipient checks</SectionLabel>
          <SafetyLine ok label="Valid Solana address" />
          {shieldVerdict?.kind === "known" && (
            <SafetyLine ok label="Previously used by you" />
          )}
          {shieldVerdict?.kind === "new" && (
            <SafetyLine ok label="New recipient — first transfer to this address" />
          )}
          {shieldVerdict?.kind === "lookalike" && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                <ShieldAlert className="size-4 shrink-0" /> Lookalike address detected
              </p>
              <p className="mt-1 text-xs leading-5 text-amber-700/90 dark:text-amber-400/90">
                This address resembles a previous recipient but is not the same. This
                can indicate an address-poisoning or copy/paste substitution attempt.
                Verify every character before continuing.
              </p>
            </div>
          )}
          {shieldVerdict?.kind === "self" && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              This is your own wallet.
            </p>
          )}
          {shieldVerdict?.destinationAccount && (
            <SafetyLine
              ok={!shieldVerdict.destinationAccount.frozen}
              label={
                shieldVerdict.destinationAccount.frozen
                  ? "Token account is frozen — transfer will fail"
                  : shieldVerdict.destinationAccount.needsCreation
                    ? "Token account will be created on first transfer"
                    : "Token account compatible"
              }
            />
          )}
        </div>
      </Card>

      <Card>
        {!connected ? (
          <>
            <SectionLabel>Wallet</SectionLabel>
            <div className="relative mt-2">
              <Button
                className="h-12 w-full rounded-2xl text-base font-semibold"
                disabled={connecting}
                onClick={() => setPickerOpen((v) => !v)}
              >
                {connecting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Connecting…
                  </>
                ) : (
                  <>
                    <Wallet className="size-4" /> Connect Wallet
                  </>
                )}
              </Button>
              {pickerOpen && (
                <div className="absolute inset-x-0 top-14 z-40 overflow-hidden rounded-2xl border bg-card shadow-lg">
                  {availableWallets.length === 0 ? (
                    <p className="px-4 py-4 text-xs text-muted-foreground">
                      No Solana wallet detected. Install Phantom or Solflare, or open
                      this page in a wallet-enabled browser.
                    </p>
                  ) : (
                    availableWallets.map((name) => (
                      <button
                        type="button"
                        key={name}
                        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium transition-colors hover:bg-secondary"
                        onClick={() => {
                          setPickerOpen(false);
                          onConnect(name);
                        }}
                      >
                        {name}
                        <ArrowRight className="size-4 text-muted-foreground" />
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </>
        ) : busy ? (
          <div className="flex items-center gap-2 rounded-xl border bg-secondary px-3 py-3.5 text-sm">
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
            {busyLine ?? "Working…"}
          </div>
        ) : signPhase === "ready" ? (
          <>
            <p className="text-xs leading-5 text-muted-foreground">
              From {owner ? shortenAddress(owner.toBase58(), 4) : "your wallet"} ·
              transaction built and simulated against live Solana state. Ready
              for your signature — nothing is sent until you approve.
            </p>
            <Button
              className="mt-3 h-12 w-full rounded-2xl text-base font-semibold"
              onClick={onRequestSignature}
              disabled={!exactOut}
            >
              Request wallet signature
            </Button>
          </>
        ) : signPhase === "insufficient_token" ||
          signPhase === "insufficient_sol" ||
          signPhase === "failed" ? (
          <>
            <p className="text-xs leading-5 text-muted-foreground">
              From {owner ? shortenAddress(owner.toBase58(), 4) : "your wallet"} ·
              the wallet was not asked to sign.
            </p>
            <Button
              variant="outline"
              className="mt-3 h-11 w-full rounded-2xl"
              onClick={onRequestSignature}
            >
              Try again
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs leading-5 text-muted-foreground">
              From {owner ? shortenAddress(owner.toBase58(), 4) : "your wallet"} ·
              simulation runs before your wallet is asked to sign.
            </p>
            <Button
              className="mt-3 h-12 w-full rounded-2xl text-base font-semibold"
              onClick={onSign}
              disabled={!exactOut}
            >
              Sign &amp; Send
            </Button>
          </>
        )}
        {simError &&
          ![
            "ready",
            "insufficient_token",
            "insufficient_sol",
            "failed",
          ].includes(signPhase) && (
            <p className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs leading-5 text-destructive">
              {simError}
            </p>
          )}
      </Card>

      <Button variant="ghost" className="w-full" onClick={onBack} disabled={busy}>
        <ArrowLeft className="size-4" /> Edit transfer
      </Button>
    </div>
  );
}

function ReceiptPhase({
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
  const decimals = mintInspection?.decimals ?? 9;
  const ticker = asset?.ticker ?? "";
  const [copied, setCopied] = useState(false);

  if (!verification || !exactOut || !asset) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">
          No completed transfer in this session.
        </p>
      </Card>
    );
  }

  const verified = verification.matchesRequested;

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border bg-card p-6 text-center shadow-sm">
        <div
          className={`mx-auto flex size-12 items-center justify-center rounded-full ${
            verified
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "bg-destructive/15 text-destructive"
          }`}
        >
          {verified ? <FileCheck className="size-6" /> : <ShieldX className="size-6" />}
        </div>
        <h2 className="mt-3 text-lg font-semibold">
          {verified ? "Transfer complete" : "Review this transfer"}
        </h2>
        <p className="mt-1 text-3xl font-semibold tabular-nums">
          {formatBaseUnits(verification.actuallyReceived, decimals)}{" "}
          <span className="text-base font-medium">{ticker}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {verified ? "received by recipient" : "verified delta differs from request"}
        </p>
      </div>

      <Card>
        <div className="space-y-2.5 text-sm">
          <Row k="Sent" v={`${formatBaseUnits(exactOut.gross, decimals)} ${ticker}`} />
          <Row k="Fee" v={`${formatBaseUnits(exactOut.fee, decimals)} ${ticker}`} />
          <Row k="Recipient" v={shortenAddress(recipient, 6)} mono />
        </div>
        <div
          className={`mt-4 rounded-xl border p-3 ${
            verified
              ? "border-emerald-500/30 bg-emerald-500/10"
              : "border-destructive/30 bg-destructive/10"
          }`}
        >
          <p className="flex items-start gap-2 text-xs font-medium leading-5">
            <ShieldCheck
              className={`mt-0.5 size-4 shrink-0 ${
                verified ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
              }`}
            />
            {verified
              ? "Verified delivery — recipient balance increased by exactly the requested amount."
              : "Verified on-chain: the balance change does not match the requested amount."}
          </p>
        </div>
      </Card>

      <Card>
        <SectionLabel>Transaction</SectionLabel>
        <button
          type="button"
          className="mt-2 flex w-full items-center justify-between gap-2 rounded-xl border bg-secondary px-3 py-2.5 text-left"
          onClick={() => {
            void navigator.clipboard.writeText(verification.signature);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          <span className="break-all font-mono text-xs">
            {shortenAddress(verification.signature, 10)}
          </span>
          {copied ? (
            <Check className="size-4 shrink-0 text-emerald-500" />
          ) : (
            <Copy className="size-4 shrink-0 text-muted-foreground" />
          )}
        </button>
        <a
          href={explorerTxUrl(verification.signature)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-2xl border text-sm font-medium hover:bg-secondary"
        >
          View on Solana Explorer <ExternalLink className="size-4" />
        </a>
      </Card>

      <Button
        className="h-12 w-full rounded-2xl text-base font-semibold"
        onClick={onNewTransfer}
      >
        Send another transfer
      </Button>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <section className="rounded-3xl border bg-card p-4 shadow-sm">{children}</section>;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{k}</span>
      <span
        className={`text-right font-medium tabular-nums ${mono ? "font-mono text-xs" : ""}`}
      >
        {v}
      </span>
    </div>
  );
}

function SafetyLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className="flex items-center gap-2 text-xs">
      {ok ? (
        <Check className="size-3.5 shrink-0 text-emerald-500" />
      ) : (
        <ShieldX className="size-3.5 shrink-0 text-destructive" />
      )}
      <span className={ok ? "text-foreground" : "text-destructive"}>{label}</span>
    </p>
  );
}

/**
 * Judges must never see raw RPC/JSON-RPC payloads. Map transport-level chain
 * read failures to one calm sentence; genuine domain errors (e.g. "not a
 * Token-2022 mint") pass through verbatim.
 */
function friendlyRpcError(msg: string): string {
  if (
    /403|access forbidden|jsonrpc|failed to get info|failed to fetch|fetch failed|networkerror|rate.?limit|429|timed? ?out|blockhash/i.test(
      msg,
    )
  ) {
    return "Can't read this asset from Solana right now.";
  }
  return msg;
}

function recipientValid(v: string): boolean {
  const t = v.trim();
  if (!t) return false;
  try {
    new PublicKey(t);
    return true;
  } catch {
    return false;
  }
}

export function applicableTier(m: MintInspection) {
  const cfg = m.transferFeeConfig ?? {
    currentEpoch: 0,
    newerTransferFee: { epoch: 0, maximumFee: "0", transferFeeBasisPoints: 0 },
    olderTransferFee: { epoch: 0, maximumFee: "0", transferFeeBasisPoints: 0 },
  };
  return cfg.currentEpoch >= cfg.newerTransferFee.epoch
    ? cfg.newerTransferFee
    : cfg.olderTransferFee;
}

