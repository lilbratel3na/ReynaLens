# ReynaLens

**Send exactly what you mean.**

ReynaLens is a dedicated PreStocks transfer experience built for the Stocklana Solana hackathon. The sender specifies exactly what the recipient should receive, ReynaLens verifies the recipient before signing, calculates the real Token-2022 transfer requirements from live Solana state, executes the transfer, and proves what actually arrived.

> Exact-out PreStocks transfers. Recipient protection before you sign.

## Why this exists

A normal token transfer asks *"How many tokens do you want to **send**?"* — but PreStocks assets are Token-2022 mints that can carry transfer fees. What leaves your wallet is not what arrives; the recipient silently receives less.

ReynaLens asks the inverse question: *"How many tokens should the recipient actually **receive**?"* — then inverts the live on-chain fee configuration to compute the exact gross amount to transfer. The calculation uses integer arithmetic only (no floats, no `amount / 0.99` approximations) and mirrors the official SPL `TransferFeeConfig::calculate_fee` semantics.

## Core workflow

```
Choose PreStock → recipient entry → Recipient Shield → exact-out amount
→ live mint inspection → dynamic gross calculation → build Token-2022 tx
→ simulation gate → wallet signing → confirmation → verified receipt
```

Every step reads live mainnet state. Nothing is hardcoded: fee tiers, decimals, epoch applicability, maximum fee, transfer hooks and account states all come from the chain at run time.

## Key features

### ReynaLens Exact
- You enter the amount the **recipient** should receive — any valid amount, no fixed product constraints.
- ReynaLens computes, in integer base units:
  - the gross amount to transfer,
  - the exact transfer fee (`ceil(gross × bps / 10000)`, capped by `maximumFee`),
  - the net the recipient will actually get.
- The exact guarantee applies to the **token amount**, not USD. Any USD figures are labelled *indicative*.

### Recipient Shield
Observable-signal checks before you sign — never claims of certainty about intent:
- **Valid new recipient** — valid address, not previously used by you (not treated as suspicious).
- **Verified recipient** — you have previously used this address (per-user recipient book).
- **Lookalike address** — the address resembles a previous recipient or the sender's own wallet but is not identical. ReynaLens shows the differing characters and warns about address-poisoning / copy-paste substitution. You can *Use previous address* or *I verified this address*.
- **Invalid recipient** — wrong token program (legacy SPL vs Token-2022), frozen destination account, malformed address.

### Live Token-2022 inspection
Before anything else, ReynaLens reads the mint account from mainnet: program ownership (Token-2022 only), decimals, `TransferFeeConfig` (older/newer tiers, current epoch, maximum fee), transfer-hook configuration (active hooks are resolved; unsupported hook layouts are a hard stop), pause state, and token metadata.

### Simulation gate
The transaction is always simulated against mainnet state before the wallet is asked to sign. `READY TO SIGN` only appears after a successful preflight; failures show `TRANSACTION BLOCKED` with the actual program-logged reason.

### Verified receipt
After confirmation, ReynaLens re-reads the destination token account and proves the actual balance delta against the requested amount — then renders a receipt with the real signature, real amounts, and an explorer link.

## Tech stack

- **React 19 + Vite + TypeScript + Tailwind CSS v4** (mobile-first, 390px target)
- **Solana web3.js + @solana/spl-token** — Token-2022 `transferCheckedWithFee`, ATA derivation/creation, live account decoding
- **Wallet adapter** — Phantom / Solflare; keys never touch the app
- **Convex** — per-user recipient book + receipts (history only; all chain data comes from Solana RPC)
- **Convex Auth** — email OTP / anonymous session gating the app route

## Getting started

```bash
bun install
bun run dev          # frontend (Vite)
bun convex dev       # backend (separate terminal)
bun run test         # unit tests (exact-out math, shield classification)
```

Environment: `VITE_CONVEX_URL` must point at your Convex deployment. No Solana RPC key required — public mainnet endpoints are used by default (swap in `src/lib/solana/connection.ts` for production).

## Architecture

```
src/
  lib/solana/
    prestocks.ts    Real PreStocks Token-2022 mints (small curated set)
    connection.ts   Shared RPC connection + failover endpoints
    inspectMint.ts  Live mint inspection (extensions, fee config, hook, pause)
    exactOut.ts     Integer exact-out math (inverse-ceil + fixpoint, audit trail)
    shield.ts       Recipient Shield: validity, history, lookalike, account state
    transfer.ts     Tx construction (ATA create + transferCheckedWithFee) + simulation gate
    verify.ts       Post-transfer delivery verification (balance delta proof)
    balance.ts      Sender SOL/token balance reads
  pages/
    Landing.tsx     Product landing page
    AppPage.tsx     The 8-screen transfer flow (asset → recipient → shield →
                    amount → preview → preflight → sign → receipt)
  convex/           Auth + recipientBook + receipts schema and functions
```

### Exact-out math

Token-2022 charges `fee = min(ceil(amount × bps / 10000), maximumFee)` on the **gross** transfer; the recipient receives `gross − fee`. Given a desired net `n` and fee `b`, ReynaLens starts from `gross = ceil(n × 10000 / (10000 − b))` and iterates the fixpoint `gross = n + fee(gross)` (converges in ≤ 2 steps for `b < 10000`), then asserts the invariant `gross − fee(gross) == n` before building any transaction. All arithmetic is `bigint` base units; the audit trail is shown in the UI.

### Recipient Shield

Similarity uses Levenshtein distance (with substituted-character diffs) against the user's recipient book and the sender's own wallet. One to nine edits mark a lookalike; identical addresses are verified recipients. Destination accounts are inspected live for existence, frozen state, and token-program mismatch.

## Security model

- Never requests or stores private keys, seed phrases, or secrets.
- Never hardcodes fees, fakes transactions, balances, signatures, or simulations.
- Does not claim clipboard-malware detection or certainty about malicious intent — only observable signals (validity, history, similarity, on-chain account state).
- Transfer hooks are honoured: the required extra accounts are resolved from the `ExtraAccountMetaList`; unsupported layouts stop the flow instead of bypassing them.
- Kill switches: no `TransferFeeConfig`, unbuildable transactions, failed simulations, or unsafe recipient states all halt the flow with an explanation.

## Known limitations

- Public RPC endpoints are rate-limited; production should use a paid RPC.
- Only Token-2022 mints with `TransferFeeConfig` are supported (by design — that is the problem being solved).
- Transfer hooks with non-static `ExtraAccountMeta` layouts are rejected rather than supported.
- USD values, when shown, are indicative only; no price oracle is currently wired.
- The recipient book and receipts are per-browser-session user records (Convex), not an on-chain history.
