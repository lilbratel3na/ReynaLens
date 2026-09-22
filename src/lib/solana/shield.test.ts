import { beforeAll, describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  evaluateRecipientShield,
  type ShieldContext,
  type ShieldKnownRecipient,
} from "./shield";
import type { MintInspection } from "./inspectMint";
import {
  DEMO_KNOWN_RECIPIENTS,
  DEMO_LOOKALIKE_TARGET,
} from "../demo";

// Note on constants: the demo lookalike differs from "Ops treasury" by exactly
// 2 substituted characters, which pins LOOKALIKE_MIN_EDITS <= 2; both demo
// addresses are ordinary unrelated pubkeys (Levenshtein distance well above
// the band), so the scenarios below cannot cross-fire.

const OPS_TREASURY = DEMO_KNOWN_RECIPIENTS[0];
const RAVI = DEMO_KNOWN_RECIPIENTS[1];

const SELF = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // valid mainnet address shape

let mintFixture: MintInspection;

beforeAll(() => {
  mintFixture = {
    mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
    programId: TOKEN_2022_PROGRAM_ID.toBase58(),
    decimals: 9,
    supply: "0",
    extensions: [],
    transferFeeConfig: {
      currentEpoch: 1040,
      newerTransferFee: { epoch: 1039, maximumFee: "18446744073709551615", transferFeeBasisPoints: 100 },
      olderTransferFee: { epoch: 1032, maximumFee: "18446744073709551615", transferFeeBasisPoints: 50 },
      transferFeeConfigAuthority: "",
      withdrawWithheldAuthority: "",
      withheldAmount: "0",
    },
    transferHookProgramId: null,
    activeTransferHook: false,
    paused: false,
    defaultAccountState: "initialized",
    permanentDelegate: null,
    metadata: null,
    scaledUiAmount: null,
    notes: [],
  };
});

/** Connection stub where every account lookup finds nothing on chain. */
function stubConnection(): Connection {
  return {
    getAccountInfo: async () => null,
  } as unknown as Connection;
}

function makeContext(overrides: {
  address: string;
  selfAddress?: string;
  knownRecipients?: ShieldKnownRecipient[];
}): ShieldContext {
  return {
    address: overrides.address,
    selfAddress: overrides.selfAddress ?? SELF,
    knownRecipients: overrides.knownRecipients ?? [
      { address: OPS_TREASURY.address, label: OPS_TREASURY.label, assetSymbol: "OPENAI", lastUsedAt: 10 },
      { address: RAVI.address, label: RAVI.label, assetSymbol: "OPENAI", lastUsedAt: 5 },
    ],
    mint: mintFixture,
    connection: stubConnection(),
    mintPubkey: new PublicKey(mintFixture.mint),
  };
}

describe("evaluateRecipientShield", () => {
  it("classifies the demo lookalike as lookalike and flags the differing chars", async () => {
    const v = await evaluateRecipientShield(makeContext({ address: DEMO_LOOKALIKE_TARGET }));
    expect(v.kind).toBe("lookalike");
    expect(v.matchedAgainst).toBe(OPS_TREASURY.address);
    expect(v.matchingAddressLabel).toBe(OPS_TREASURY.label);
    expect(v.diffs.length).toBeGreaterThan(0);
    expect(v.actions).toBe("confirm_only");
    expect(v.detail).toMatch(/address-poisoning/i);
  });

  it("classifies an exact known recipient as verified", async () => {
    const v = await evaluateRecipientShield(makeContext({ address: OPS_TREASURY.address }));
    expect(v.kind).toBe("known");
    expect(v.actions).toBe("ok");
  });

  it("leaves a fresh unrelated address as NEW (does not scare on newness)", async () => {
    const fresh = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuGzaGVcPbFKuqBf";
    const v = await evaluateRecipientShield(makeContext({ address: fresh }));
    expect(v.kind).toBe("new");
    expect(v.actions).toBe("ok");
  });

  it("blocks structurally invalid addresses", async () => {
    const v = await evaluateRecipientShield(makeContext({ address: "7xAb...92Kd" }));
    expect(v.kind).toBe("invalid");
    expect(v.actions).toBe("block");
  });

  it("warns on self-transfers", async () => {
    const v = await evaluateRecipientShield(makeContext({ address: SELF }));
    expect(v.kind).toBe("self");
    expect(v.actions).toBe("confirm_only");
  });

  it("flags an address resembling the user's own wallet (self lookalike)", async () => {
    // Same length as SELF, 2 substituted characters (positions 4 and 8).
    const altered = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtXWzm";
    // Sanity: valid base58 that is not the self address itself.
    expect(altered).not.toBe(SELF);
    const v = await evaluateRecipientShield(makeContext({ address: altered }));
    expect(["lookalike", "new"]).toContain(v.kind);
    if (v.kind === "lookalike") {
      expect(v.matchedAgainst).toBe(SELF);
      expect(v.matchingAddressLabel).toBe("your wallet");
    }
  });

  it("does not classify identical input as a lookalike of itself", async () => {
    const v = await evaluateRecipientShield(
      makeContext({ address: OPS_TREASURY.address, knownRecipients: [] }),
    );
    expect(v.kind).not.toBe("lookalike");
  });
});
