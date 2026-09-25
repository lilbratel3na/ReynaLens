# ReynaLens

**Send exactly what you mean.**

A normal token transfer asks how many tokens should *leave your wallet*. On PreStocks — Token-2022 assets with transfer fees — that number is not what arrives: the fee is taken on the way, and the recipient silently receives less. ReynaLens reverses the question. You specify the exact amount the recipient should **receive**, it reads the live Token-2022 mint configuration from Solana, computes the gross amount required so the net delivered equals your number, simulates the transaction before signing, executes it through your own wallet, and then proves what actually arrived by reading the recipient's real balance delta on chain.

**Live Demo:** https://reynalens.freebuff.app
**Source:** https://github.com/lilbratel3na/ReynaLens

---

## The problem

- **PreStocks are Token-2022 assets.** They use Solana's Token-2022 program, not legacy SPL Token.
- **Transfer fees change what arrives.** A Token-2022 mint can define a `TransferFeeConfig`: a basis-point fee (capped by a maximum) deducted from every transfer. Send 100 → receive 99, without any warning in a standard wallet.
- **Normal wallets push the fee math onto the sender.** The sender must mentally derive the gross amount that delivers the intended net — or get it wrong.
- **A transaction signature is not proof.** Even a confirmed transaction doesn't tell the sender whether the *intended recipient* received the *intended net amount*. The signature confirms execution, not delivery.

## The idea

ReynaLens reverses the transfer question: **“How much should the recipient actually receive?”**

You enter that number. ReynaLens then:

1. reads the mint's live configuration (fee tiers, epoch, maximum fee, decimals, transfer hooks) from mainnet state,
2. computes the required gross amount using exact integer arithmetic,
3. simulates the real transaction before anything is signed,
4. hands the transaction to your wallet (Phantom or Solflare) to sign and submit,
5. and after confirmation verifies the recipient's actual balance delta against your requested amount — issuing a receipt only for what truly arrived.

## Core workflow

```
Choose PreStock → Enter recipient → Recipient Shield → Enter exact receive amount
→ Inspect live Token-2022 state → Calculate gross → Simulate → Sign → Confirm
→ Verify delivery → Receipt
```

- **Choose PreStock** — a small curated set of real PreStocks mints. Selecting one triggers a live read of the actual mint account from mainnet.
- **Enter recipient** — a full Solana address, or one of your previously used recipients from your recipient book.
- **Recipient Shield** — validity, history, lookalike similarity, and live destination-account state are checked before you can continue.
- **Enter exact receive amount** — the number the recipient should end up with. This is the input that drives everything else.
- **Inspect live Token-2022 state** — decimals, applicable fee tier, current epoch, maximum fee, transfer-hook requirements, and account states all come from the chain at run time. Nothing is hardcoded.
- **Calculate gross** — the smallest gross amount whose delivered net equals your number, in integer base units.
- **Simulate** — the exact transaction is simulated against mainnet before the wallet is ever asked to sign. Failures halt the flow with the program-logged reason.
- **Sign** — your wallet signs and submits. ReynaLens never holds keys and never broadcasts on its own.
- **Confirm** — the returned signature is persisted immediately (surviving reloads and mobile handoffs) and confirmed by polling.
- **Verify delivery** — the destination token account is re-read and its balance delta compared against the request.
- **Receipt** — real signature, real amounts, and a Solana Explorer link.

## Why this is technically different

### Exact-out transfers
The product input is the recipient's amount, not the sender's. The UI shows **Recipient receives**, **You send** (computed gross), **Transfer fee**, and the estimated network fee. The exact guarantee is on the **token amount only** — any USD figure shown in the app is labelled *indicative*, because market prices change and no price oracle is wired.

### Live Token-2022 inspection
Before any math, ReynaLens reads the mint account from mainnet: program ownership (Token-2022 only), decimals, `TransferFeeConfig` (older/newer tiers, current epoch, maximum fee), transfer-hook configuration (required extra accounts are resolved from the hook's `ExtraAccountMetaList`; unsupported layouts are a hard stop), pause state, and token metadata. Every calculation and transaction is derived from this live read — never from assumptions.

### Simulation gate
The transaction is always simulated before the wallet prompt, and the fee configuration is re-read immediately before signing — if the live tier changed, the gross is recalculated rather than signing a stale transaction. A failed simulation blocks signing entirely and shows the actual program-logged reason.

### Recipient Shield
Observable-signal checks run before signing: address validity, your recipient history, lookalike similarity, and the live state of the destination token account. See [Recipient Shield](#recipient-shield) for the full list.

### Verified receipt
Confirmation is not acceptance. After the transaction confirms, ReynaLens reads the destination token account and verifies the actual balance delta against the requested amount. Only then does the receipt render. See [Proof / receipt](#proof--receipt).

## Exact-out math

Token-2022 charges the fee on the **gross** amount:

```
fee = min(ceil(gross × bps / 10000), maximumFee)
recipient receives = gross − fee
```

Given a desired net `n` and the live fee `b`, ReynaLens solves for the gross whose resulting net equals `n`:

- Start from the inverse-ceil estimate: `gross = ceil(n × 10000 / (10000 − b))`.
- When the fee hits the `maximumFee` cap, the net region is linear: `gross = n + maximumFee`.
- Iterate the fixpoint `gross = n + fee(gross)` — for `b < 10000` this converges in at most 2 steps.
- Assert the invariant **`gross − fee(gross) == n`** before a single transaction is built. If it cannot hold for the requested amount under the live rules, the app refuses to produce one.

All arithmetic uses `bigint` base units — there is no floating point anywhere, and this is not an `amount / 0.99` approximation. The full derivation is exposed as an audit trail in the UI.

## Recipient Shield

Recipient Shield performs **observable checks only** and never claims certainty about intent. It is not malware or clipboard detection — it classifies what can actually be observed:

- **Valid address** — base58 structural validation.
- **Previously verified recipient** — you have used this exact address before (per-user recipient book).
- **Lookalike address** — the entered address is 1–9 Levenshtein edits away from a previous recipient **or from your own wallet**, with the differing characters displayed. This is the signature of address-poisoning and copy/paste substitution attempts; the flow asks you to explicitly confirm before continuing.
- **Sender's own address** — flagged as unusual.
- **Frozen destination account** — the recipient's token account exists but is frozen by the mint's freeze authority; tokens sent there would be locked.
- **Token vs Token-2022 mismatch** — the destination account belongs to the legacy SPL Token program while the asset is a Token-2022 mint; the transfer would fail.

A valid address you haven't used before is presented as a **new recipient**, not treated as suspicious.

## Proof / receipt

After the wallet returns a signature, ReynaLens persists it, confirms that exact signature, and then verifies the actual on-chain result:

- the transaction succeeded on chain (no execution error),
- the fee payer is your wallet,
- the transaction touches the intended destination token account,
- the account's mint and owner match the request,
- and the balance delta equals the requested net amount **exactly**.

The receipt contains the real transaction signature, the real sent/fee/received amounts, and a Solana Explorer link. A transaction that was merely signed or confirmed is never presented as a successful delivery — **delivery verification is the final acceptance condition**. Your latest verified receipt is also surfaced on the compose screen, so the proof outlives the session.

## What is actually live

ReynaLens has been tested end-to-end on **Solana mainnet with real PreStocks assets and a real wallet-signed transaction** — live mint inspection, exact-out calculation, simulation, wallet submission, confirmation, and delivery verification all ran against live chain state. Every completed transfer produces a receipt carrying its real signature and Explorer link at runtime.

This is a hackathon build: no user counts, adoption, volume, or production-scale metrics are claimed, and none are implied.

## Architecture

- **React 19 / Vite / TypeScript / Tailwind CSS** — mobile-first single-flow UI
- **Solana web3.js + @solana/spl-token** — RPC, ATA derivation, account decoding
- **Token-2022 `TransferCheckedWithFee`** — the transfer instruction, built with the exact computed gross and fee
- **Wallet adapter (Phantom / Solflare)** — the wallet signs and submits; ReynaLens never handles key material
- **Convex** — per-user recipient book and receipt records; all chain data comes from Solana RPC, never from the database
- **Live Solana RPC** — public endpoints with automatic failover; optionally overridable via `VITE_SOLANA_RPC_URL`

```
src/
  lib/solana/
    prestocks.ts    Curated real PreStocks Token-2022 mints
    connection.ts   Shared RPC connection + failover endpoints
    inspectMint.ts  Live mint inspection (extensions, fee config, hooks, state)
    exactOut.ts     Integer exact-out math (inverse-ceil + fixpoint + invariant)
    shield.ts       Recipient Shield classification + destination inspection
    transfer.ts     Transaction construction + simulation gate
    verify.ts       Post-transfer delivery verification (balance-delta proof)
    balance.ts      Sender SOL / token balance reads
  lib/transferIntent.ts   Session-scoped intent + submitted-signature recovery
  pages/
    Landing.tsx     Product landing page
    AppPage.tsx     The transfer flow (compose → preview → receipt)
  convex/           Auth + recipientBook + receipts schema and functions
```

**Private keys never enter the application.** The wallet adapter is the single signing and submission mechanism; ReynaLens constructs and simulates the transaction, then hands it over.

## Security model

- Never requests or stores private keys, seed phrases, or secrets.
- No fake balances, fabricated signatures, or mocked simulations — every displayed figure is chain-derived.
- A failed preflight or simulation blocks signing; nothing reaches the wallet prompt.
- Transfer hooks are respected: required extra accounts are resolved from the hook's `ExtraAccountMetaList`; unsupported hook layouts are **rejected rather than bypassed**.
- Unsafe recipient or account states (invalid address, frozen destination, wrong token program) halt the flow with an explanation.
- The exact guarantee applies to the token amount; USD values are always labelled indicative.

## Known limitations

- **Public RPC endpoints** are used by default (with failover) and can be rate-limited or restrict browser origins. A dedicated endpoint can be supplied via `VITE_SOLANA_RPC_URL` without code changes; none is required to run the app.
- Only **Token-2022 mints with `TransferFeeConfig`** are supported — by design, since that is the problem being solved.
- Transfer hooks with **non-static `ExtraAccountMeta` layouts** are rejected rather than supported.
- **USD figures are indicative only**; no price oracle is wired.
- The recipient book and receipts are per-user Convex records (browser-session-scoped auth), **not an on-chain history**.

## Local development

```bash
bun install
bun run dev          # frontend (Vite)
bun convex dev       # backend (separate terminal)
bun run test         # unit tests (exact-out math, shield, verification, submission)
```

`VITE_CONVEX_URL` must point at your Convex deployment — `bun convex dev` provisions/updates the backend and prints the URL to set. No Solana RPC key is required; the app uses public mainnet endpoints by default (override with `VITE_SOLANA_RPC_URL` in `src/lib/solana/connection.ts` if you want a dedicated endpoint).

## Built for Stocklana

ReynaLens was built for the Stockla(hackathon) Solana hackathon with a deliberate focus: the **PreStocks / Token-2022 transfer problem**. It is not a generic wallet, not an exchange, not a portfolio tracker, and not a trading terminal — it is one workflow done properly: specify exactly what the recipient should receive, protect the recipient before signing, and prove what actually arrived.

## Try it

**Try it:** https://reynalens.freebuff.app
**Source:** https://github.com/lilbratel3na/ReynaLens
