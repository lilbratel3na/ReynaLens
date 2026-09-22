/**
 * Recipient Shield — observable-signal checks only.
 *
 * It classifies an address as: NEW / KNOWN (previously used by this user) /
 * LOOKALIKE (resembles a previous recipient but differs) / INVALID. It never
 * claims certainty about intent, malware, or "fake wallets".
 */

import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  getAccount,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { MintInspection } from "./inspectMint";

export type ShieldKind =
  | "invalid"
  | "self"
  | "known"
  | "lookalike"
  | "new"
  | "wrong_account"
  | "frozen"
  | "paused";

export interface ShieldDiff {
  index: number;
  expected: string;
  actual: string;
}

export interface ShieldVerdict {
  kind: ShieldKind;
  title: string;
  detail: string;
  actions: "block" | "confirm_only" | "ok";
  diffs: ShieldDiff[];
  /** Canonical base58 of the address the user entered (for diff display). */
  enteredAddress?: string;
  matchedAgainst?: string;
  matchingAddressLabel?: string | null;
  destinationAccount?: {
    exists: boolean;
    owner: string | null;
    frozen: boolean | null;
    balance: string | null;
    needsCreation: boolean;
  };
  systemAccount?: boolean;
}

export interface ShieldKnownRecipient {
  address: string;
  label: string | null;
  assetSymbol: string | null;
  lastUsedAt: number | null;
}

const D1 = 1;
const D2 = 2;
const SUB_COST = 5;
const LOOKALIKE_MIN_EDITS = 2;
const LOOKALIKE_MAX_EDITS = 9;

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function diffPositions(a: string, b: string, max = 6): ShieldDiff[] {
  const diffs: ShieldDiff[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n && diffs.length < max; i++) {
    if (a[i] !== b[i]) diffs.push({ index: i, expected: a[i], actual: b[i] });
  }
  return diffs;
}

export interface ShieldContext {
  /** Address entered by the user. */
  address: string;
  /** Sender's own wallet address. */
  selfAddress: string;
  /** Previously used recipients for this user (from Convex recipient book). */
  knownRecipients: ShieldKnownRecipient[];
  /** The inspected mint (for account-type and freeze checks). */
  mint: MintInspection;
  connection: Connection;
  mintPubkey: PublicKey;
}

export async function evaluateRecipientShield(
  ctx: ShieldContext,
): Promise<ShieldVerdict> {
  const { address, selfAddress, knownRecipients, mint, connection, mintPubkey } = ctx;

  // 1. Structural validation
  if (!address || address.length === 0) {
    return {
      kind: "invalid",
      title: "EMPTY ADDRESS",
      detail: "Enter a recipient address to continue.",
      actions: "block",
      diffs: [],
    };
  }
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(address);
  } catch {
    return {
      kind: "invalid",
      title: "INVALID ADDRESS",
      detail:
        "This is not a valid base58 Solana address. Check for typos or truncation — a valid address is 32–44 characters.",
      actions: "block",
      diffs: [],
    };
  }

  // 2. Self-transfer check
  if (pubkey.toBase58() === selfAddress) {
    return {
      kind: "self",
      title: "THIS IS YOUR OWN WALLET",
      detail:
        "You are sending to yourself. ReynaLens allows it, but it is unusual — double-check before continuing.",
      actions: "confirm_only",
      diffs: [],
    };
  }

  // 3. Lookalike / known detection against the recipient book
  const lowercaseSelf = selfAddress.toLowerCase();
  const sortedKnown = [...knownRecipients].sort(
    (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
  );
  let best: { rec: ShieldKnownRecipient; d: number } | null = null;
  for (const rec of sortedKnown) {
    if (rec.address === pubkey.toBase58()) {
      // exact known recipient
      const dest = await inspectDestination(connection, pubkey, mintPubkey, mint);
      return {
        kind: "known",
        title: "VERIFIED RECIPIENT",
        detail: `You have previously used this address${rec.label ? ` (“${rec.label}”)` : ""} in ReynaLens.`,
        actions: "ok",
        diffs: [],
        matchedAgainst: rec.address,
        matchingAddressLabel: rec.label,
        destinationAccount: dest,
      };
    }
    if (rec.address.toLowerCase() === lowercaseSelf) continue;
    const d = levenshtein(pubkey.toBase58(), rec.address);
    if (!best || d < best.d) best = { rec, d };
  }

  if (best && best.d >= LOOKALIKE_MIN_EDITS && best.d <= LOOKALIKE_MAX_EDITS) {
    const diffs = diffPositions(best.rec.address, pubkey.toBase58());
    const dest = await inspectDestination(connection, pubkey, mintPubkey, mint);
    return {
      kind: "lookalike",
      title: "LOOKALIKE ADDRESS DETECTED",
      detail: `This address resembles a previous recipient but is not the same address (${best.d} characters differ). This may indicate an address-poisoning or copy/paste substitution attempt. Verify before continuing.`,
      actions: "confirm_only",
      diffs,
      enteredAddress: pubkey.toBase58(),
      matchedAgainst: best.rec.address,
      matchingAddressLabel: best.rec.label,
      destinationAccount: dest,
    };
  }

  // 4. Destination account state inspection
  const dest = await inspectDestination(connection, pubkey, mintPubkey, mint);
  if (dest.exists && dest.frozen) {
    return {
      kind: "frozen",
      title: "DESTINATION FROZEN",
      detail:
        "The destination token account exists but is frozen by the mint's freeze authority. Tokens sent here will be locked.",
      actions: "block",
      diffs: [],
      destinationAccount: dest,
    };
  }
  if (dest.exists && dest.owner && dest.owner === TOKEN_PROGRAM_ID.toBase58() && mint.programId === TOKEN_2022_PROGRAM_ID.toBase58()) {
    return {
      kind: "wrong_account",
      title: "WRONG TOKEN PROGRAM ACCOUNT",
      detail:
        "The destination token account uses the legacy SPL Token program, but this asset is a Token-2022 mint. A transfer to this account would fail.",
      actions: "block",
      diffs: [],
      destinationAccount: dest,
    };
  }

  // 5. New valid recipient
  return {
    kind: "new",
    title: "NEW RECIPIENT",
    detail:
      "Address is valid but has not been used by you before in ReynaLens.",
    actions: "ok",
    diffs: [],
    destinationAccount: dest,
  };
}

async function inspectDestination(
  connection: Connection,
  recipientOwner: PublicKey,
  mintPubkey: PublicKey,
  mint: MintInspection,
): Promise<NonNullable<ShieldVerdict["destinationAccount"]>> {
  let ata: PublicKey;
  try {
    [ata] = PublicKey.findProgramAddressSync(
      [
        recipientOwner.toBytes(),
        mintPubkey.toBytes(),
        TOKEN_2022_PROGRAM_ID.toBytes(),
      ],
      TOKEN_2022_PROGRAM_ID,
    );
  } catch {
    return { exists: false, owner: null, frozen: null, balance: null, needsCreation: true };
  }
  try {
    const acc = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    return {
      exists: true,
      owner: acc.owner.toBase58(),
      frozen: acc.isFrozen,
      balance: acc.amount.toString(),
      needsCreation: false,
    };
  } catch {
    return { exists: false, owner: null, frozen: null, balance: null, needsCreation: true };
  }
}

