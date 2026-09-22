/**
 * Demo seeds (per the demo-data rule, these only populate recipient history
 * and the demo lookalike scenario — never transaction data).
 *
 * All addresses below are valid base58 points but hold no tokens; they exist
 * purely so a fresh reviewer can exercise Recipient Shield without first
 * sending funds. `mutatedFrom` marks the address the trap was derived from
 * (2 characters differ) — the ACT 1 lookalike moment.
 */

export interface DemoKnownRecipient {
  address: string;
  label: string;
  assetSymbol: string;
}

export const DEMO_KNOWN_RECIPIENTS: DemoKnownRecipient[] = [
  {
    address: "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt",
    label: "Ops treasury",
    assetSymbol: "OPENAI",
  },
  {
    address: "8tMU4uPgbGA12ENcHdjVcPWfSxyhuxdyGTrxyMXcFahH",
    label: "Ravi (OTC)",
    assetSymbol: "OPENAI",
  },
];

/** ACT 1 trap: 2 chars differ from “Ops treasury”. */
export const DEMO_LOOKALIKE_TARGET = "6ASf51cmmEHTgDJ4X4ZT5vTSiHVJBXPg5AN5YoTCpGWt";
