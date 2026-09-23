import { motion } from "framer-motion";
import {
  ArrowRight,
  ScanLine,
  ShieldCheck,
  ShieldAlert,
  Send,
  ReceiptText,
  FileCheck,
  Crosshair,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
};

function Nav() {
  return (
    <header className="border-b border-border bg-background/95">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <a href="/" className="flex items-center gap-2">
          <ScanLine className="size-5 text-primary" />
          <span className="text-sm font-semibold tracking-tight">REYNALENS</span>
        </a>
        <Button asChild size="sm" className="cursor-pointer rounded-full">
          <a href="/app">
            Open app
            <ArrowRight className="size-3.5" />
          </a>
        </Button>
      </div>
    </header>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <div>
        <Nav />

        {/* Hero */}
        <section className="mx-auto max-w-5xl px-4 pb-16 pt-16 sm:pt-24">
          <motion.div {...fadeUp} transition={{ duration: 0.4 }} className="mx-auto max-w-2xl text-center">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1">
              <span className="size-1.5 rounded-full bg-status-ok" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Exact-out PreStocks transfers · Token-2022
              </span>
            </div>
            <h1 className="text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              Send exactly what you mean.
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-pretty text-sm leading-6 text-muted-foreground sm:text-base">
              ReynaLens is a dedicated PreStocks transfer experience. You specify what
              the recipient should receive, we verify who you are sending to, calculate
              the real Token-2022 requirements from live Solana state, execute, and
              prove what actually arrived.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild size="lg" className="w-full cursor-pointer sm:w-auto">
                <a href="/app">
                  Start a transfer <ArrowRight className="size-4" />
                </a>
              </Button>
              <Button asChild variant="outline" size="lg" className="w-full cursor-pointer sm:w-auto">
                <a href="#how">See how it works</a>
              </Button>
            </div>
          </motion.div>

          {/* The problem: send vs receive */}
          <motion.div
            {...fadeUp}
            transition={{ duration: 0.4, delay: 0.12 }}
            className="mx-auto mt-14 grid max-w-3xl gap-3 sm:grid-cols-2"
          >
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="mt-3 flex items-center gap-2 text-status-bad">
                <Crosshair className="size-4" />
                <span className="text-xs font-semibold tracking-wide">NORMAL WALLET ASKS</span>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">“How many tokens do you want to <span className="font-semibold text-foreground">send</span>?”</p>
              <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                With Token-2022 transfer fees, what leaves your wallet is not what
                arrives. The recipient gets less — silently.
              </p>
            </div>
            <div className="rounded-2xl border border-status-ok bg-status-ok-soft p-4">
              <div className="flex items-center gap-2 text-status-ok">
                <ShieldCheck className="size-4" />
                <span className="text-xs font-semibold tracking-wide">REYNALENS ASKS</span>
              </div>
              <p className="mt-3 text-sm text-foreground">“How many tokens should the recipient actually <span className="font-semibold">receive</span>?”</p>
              <p className="mt-3 text-[11px] leading-5 text-foreground/80">
                ReynaLens inverts the live Token-2022 fee calculation and sends the
                exact gross amount that delivers your number.
              </p>
            </div>
          </motion.div>
        </section>

        {/* How it works */}
        <section id="how" className="border-t border-border bg-secondary/40">
          <div className="mx-auto max-w-5xl px-4 py-16">
            <motion.h2
              {...fadeUp}
              transition={{ duration: 0.35 }}                className="text-center text-2xl font-bold tracking-tight"
            >
              One workflow. Done properly.
            </motion.h2>
            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  icon: ScanLine,
                  title: "Inspect",
                  body: "We read the live Token-2022 mint: decimals, TransferFeeConfig tiers, current epoch, maximum fee, transfer hook, pause state. The chain decides — never assumptions.",
                },
                {
                  icon: ShieldCheck,
                  title: "Shield",
                  body: "Recipient Shield checks address validity, your recipient history, and lookalike similarity before you ever reach the signature screen.",
                },
                {
                  icon: Send,
                  title: "Calculate & simulate",
                  body: "You enter the amount the recipient should receive. ReynaLens derives the exact gross in integer base units, builds the transferCheckedWithFee transaction, and simulates it.",
                },
                {
                  icon: ReceiptText,
                  title: "Prove",
                  body: "After confirmation we read the destination balance and prove the actual delivered amount against what you requested — then issue the receipt.",
                },
              ].map((f, i) => (
                <motion.div
                  key={f.title}
                  {...fadeUp}
                  transition={{ duration: 0.35, delay: 0.06 * i }}
                  className="rounded-2xl border border-border bg-card p-4"
                >
                  <f.icon className="size-5 text-primary" />
                  <h3 className="mt-3 text-sm font-semibold">{f.title}</h3>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{f.body}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Recipient Shield highlight */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl px-4 py-16">
            <div className="grid items-center gap-8 lg:grid-cols-2">
              <motion.div {...fadeUp} transition={{ duration: 0.35 }}>
                <div className="inline-flex items-center gap-2 rounded-full border border-status-warn bg-status-warn-soft px-2.5 py-1">
                  <ShieldAlert className="size-3.5 text-status-warn" />
                  <span className="text-[11px] font-semibold tracking-wide text-status-warn">
                    RECIPIENT SHIELD
                  </span>
                </div>
                <h2 className="mt-4 text-2xl font-bold tracking-tight">
                  Address poisoning has a counter.
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Scammers dust you with lookalike addresses hoping you copy-paste
                  theirs. ReynaLens compares every destination against your recipient
                  history and flags near-matches — showing exactly which characters
                  differ — before you sign.
                </p>
                <ul className="mt-4 space-y-2 text-xs leading-5 text-muted-foreground">
                  <li className="flex gap-2">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-status-ok" />
                    Verified recipients you have used before
                  </li>
                  <li className="flex gap-2">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-status-warn" />
                    Lookalike warnings with character-level diffs
                  </li>
                  <li className="flex gap-2">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-status-ok" />
                    Frozen / wrong-program destination detection
                  </li>
                </ul>
              </motion.div>
              <motion.div {...fadeUp} transition={{ duration: 0.35, delay: 0.1 }} className="rounded-2xl border border-status-warn bg-status-warn-soft p-4">
                <div className="text-[11px] font-semibold tracking-wide text-status-warn">
                  ⚠ LOOKALIKE ADDRESS DETECTED
                </div>
                <p className="mt-2 text-[11px] leading-5 text-foreground/90">
                  This address resembles a previous recipient but is not the same
                  address (2 characters differ). This may indicate an address-poisoning
                  or copy/paste substitution attempt.
                </p>
                <div className="mt-3 space-y-1 break-all text-[10px] leading-4">
                  <div>
                    <span className="text-muted-foreground">PREVIOUS </span>
                    6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt
                  </div>
                  <div>
                    <span className="text-muted-foreground">ENTERED  </span>
                    6ASf5<span className="font-bold text-status-bad">1c</span>mmEHTgDJ4X4ZT5vT
                    <span className="font-bold text-status-bad">S</span>iHVJBXPg5AN5YoTCpGWt
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[10px] font-medium">USE PREVIOUS ADDRESS</span>
                  <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[10px] font-medium">I VERIFIED THIS ADDRESS</span>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Receipt highlight */}
        <section className="border-t border-border bg-secondary/40">
          <div className="mx-auto max-w-5xl px-4 py-16">
            <div className="grid items-center gap-8 lg:grid-cols-2">
              <motion.div
                {...fadeUp}
                transition={{ duration: 0.35 }}
                className="order-2 rounded-2xl border border-status-ok bg-card p-4 shadow-sm lg:order-1"
              >
                <div className="flex items-center gap-2">
                  <FileCheck className="size-4 text-status-ok" />
                  <span className="text-[11px] font-semibold tracking-wide text-status-ok">
                    ✓ VERIFIED ON SOLANA
                  </span>
                </div>
                <div className="mt-3 space-y-2 text-xs">
                  {[
                    ["Asset", "OPENAI (PreStocks)"],
                    ["Recipient should receive", "100.00 OPENAI"],
                    ["Sent from your wallet", "101.01 OPENAI"],
                    ["Transfer fee", "1.01 OPENAI"],
                    ["Actually received", "100.00 OPENAI"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-3">
                      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</span>
                      <span className="tabular-nums">{v}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[10px] text-muted-foreground">
                  Example values for illustration only — every figure in the real
                  receipt comes from your actual transaction.
                </p>
              </motion.div>
              <motion.div {...fadeUp} transition={{ duration: 0.35, delay: 0.08 }} className="order-1 lg:order-2">
                <h2 className="text-2xl font-bold tracking-tight">
                  “Sent” is not proof.
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Every ReynaLens transfer ends with verification, not hope. We read the
                  recipient's token account from Solana and compare the actual delta
                  against your requested amount. The receipt shows what truly arrived.
                </p>
                <div className="mt-6">
                  <Button asChild className="cursor-pointer">
                    <a href="/app">
                      Try ReynaLens <ArrowRight className="size-4" />
                    </a>
                  </Button>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-border">
          <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-8 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <ScanLine className="size-4 text-primary" />
              <span className="text-xs font-semibold tracking-tight">REYNALENS</span>
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              Exact-out PreStocks transfers. Recipient protection before you sign.
              Indicative values only — the exact guarantee is the token amount
              delivered.
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
