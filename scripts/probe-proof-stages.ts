/**
 * TEMPORARY LOCAL PROBE (attempt #5) — reproduces the EXACT device scenario
 * without any wallet or network:
 *   build → pin blockhash/feePayer → capture message bytes → sign LOCALLY →
 *   serialize → Transaction.from(bytes) round-trip (what Phantom's injected
 *   bridge does) → evaluate EVERY proveSignedTransaction condition in order.
 * No keys are printed, no bytes are printed, no transaction is sent.
 */
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

const payer = Keypair.generate();
const recipient = Keypair.generate().publicKey;

// ── Mirror AppPage's exact construction order ─────────────────────────────
const tx = new Transaction();
tx.add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 1 }),
);
tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); // any valid 32-byte value
tx.feePayer = payer.publicKey;

const expectedMessage = tx.serializeMessage();

// Sign LOCALLY with a throwaway keypair (no wallet, no network, nothing sent).
tx.sign(payer);

// ── The injected-bridge round trip: serialize → parse ────────────────────
const wire = tx.serialize();
const returned = Transaction.from(wire);

console.log("== shape ==");
console.log("  constructor        :", returned.constructor.name);
console.log("  signatures.length  :", returned.signatures.length);
console.log("  feePayer present   :", returned.feePayer !== null);
console.log("  blockhash present  :", returned.recentBlockhash !== null);
console.log("  instructionCount   :", returned.instructions.length);

const sig = returned.signature; // getter → signatures[0].signature
console.log("== proof stages ==");
console.log("  hasSerialize       :", typeof returned.serialize === "function");
console.log("  hasSignature       :", sig !== null && sig !== undefined);
console.log("  signatureLength    :", sig ? sig.length : 0);
console.log("  sig all-zero       :", sig ? sig.every((b) => b === 0) : "n/a");
console.log("  returnedMsgLength  :", returned.serializeMessage().length);
console.log("  simulatedMsgLength :", expectedMessage.length);
console.log(
  "  messageEqual       :",
  Buffer.compare(Buffer.from(returned.serializeMessage()), Buffer.from(expectedMessage)) === 0,
);
console.log("  verifySignatures() :", returned.verifySignatures());

// ── Stage-by-stage against the proof's exact order ────────────────────────
console.log("== stage evaluation (proof order) ==");
console.log("  1 shape                  : PASS");
const stage2 = !!sig && sig.length > 0 && !sig.every((b) => b === 0);
console.log("  2 signature_presence     :", stage2 ? "PASS" : "FAIL");
const rMsg = returned.serializeMessage();
const stage3 = rMsg.length === expectedMessage.length;
console.log("  3 message_length         :", stage3 ? "PASS" : "FAIL");
let stage4 = stage3;
if (stage3) {
  for (let i = 0; i < rMsg.length; i++) {
    if (rMsg[i] !== expectedMessage[i]) {
      stage4 = false;
      console.log("     first differing byte index:", i);
      break;
    }
  }
}
console.log("  4 message_integrity      :", stage4 ? "PASS" : "FAIL");
console.log("  5 signature_verification :", returned.verifySignatures() ? "PASS" : "FAIL");

// ── The serialize() bytes the app would broadcast if proof passed ─────────
console.log("== broadcast bytes check ==");
console.log("  round-trip serialize identical:", Buffer.compare(Buffer.from(returned.serialize()), Buffer.from(wire)) === 0);

console.log("\nLOCAL PROBE COMPLETE — nothing signed by a wallet, nothing sent.");
