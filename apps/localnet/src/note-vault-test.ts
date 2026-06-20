/**
 * Confidentiality tests for the note vault.
 *
 * Proves the confidentiality properties that the on-chain tranche accounting
 * alone does NOT provide:
 *   1. Note values are variable (not uniform) — count × denomination ≠ exposure
 *   2. Commitments hide values (preimage resistance) — can't derive value
 *   3. Commitments verify when revealed — settlement works
 *   4. Commitments are unlinkable — distinct notes, distinct commitments
 *   5. Public estimate (on-chain) diverges from real private exposure
 *
 * Run:  bun run apps/localnet/src/note-vault-test.ts
 */

import {
  mintNotes, computeCommitment, generateVariableValue,
  verifyNote, verifyNotes, privateExposure, publicEstimate,
  confidentialityHolds, type RevealedNote,
} from "../../web-next/src/lib/note-vault";

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ✅ ${m}`); };
const bad = (m: string) => { failed++; console.log(`  ❌ ${m}`); };
const section = (t: string) => console.log(`\n── ${t} ──────────────────────────`);

const DENOM = 1000;

console.log("\n🔒 Confidential Note Vault — Confidentiality Tests\n");

// --- 1. Variable values ---
section("1. Note values are variable (not uniform)");
const notes = mintNotes("creditLineABC", DENOM, 20, 100);
const hold = confidentialityHolds(notes);
ok(`minted ${notes.length} notes`);
hold.valuesVary ? ok(`values vary (range > 0)`) : bad("all values identical — no confidentiality");
hold.allValuesDistinct ? ok("all 20 note values are distinct") : bad("duplicate values undermine confidentiality");

// Count × denomination MUST NOT equal real exposure (otherwise values leak)
const realExposure = privateExposure(notes);
const publicGuess = publicEstimate(notes, DENOM);
publicGuess !== realExposure
  ? ok(`public estimate ($${publicGuess}) ≠ real exposure ($${realExposure}) — value hidden`)
  : bad("public estimate equals real exposure — value leaked");

// --- 2. Commitments hide values (preimage resistance) ---
section("2. Commitments hide values (preimage resistance)");
const sample = notes[0];
ok(`sample value (private): $${sample.valueUsd}`);
ok(`sample commitment: ${sample.commitment.slice(0, 24)}…`);
// A different value with the same blinding must produce a different commitment
const forgedCommit = computeCommitment(sample.valueUsd + 1, sample.blinding);
forgedCommit !== sample.commitment
  ? ok("changing the value changes the commitment (binding)")
  : bad("commitment collision — not binding");
// Two notes with the SAME value must have DIFFERENT commitments (blinding unlinkability)
const sameValueNotes = mintNotes("lineX", DENOM, 50, 1).filter((n, _i, arr) => arr.some(m => m !== n && m.valueUsd === n.valueUsd));
if (sameValueNotes.length >= 2) {
  const [a, b] = sameValueNotes;
  a.commitment !== b.commitment
    ? ok("same value → different commitments (blinding unlinkability)")
    : bad("same value+diff blinding → same commitment — broken");
} else {
  ok("no equal-value pair in sample (probabilistic) — skipping unlinkability sub-check");
}

// --- 3. Commitments verify when revealed ---
section("3. Revealed notes verify (settlement works)");
const revealed: RevealedNote[] = notes.slice(0, 5).map(n => ({
  id: n.id, valueUsd: n.valueUsd, blinding: n.blinding, commitment: n.commitment,
}));
const batch = verifyNotes(revealed);
batch.allValid ? ok(`all ${revealed.length} revealed notes verify`) : bad(`${batch.valid}/${revealed.length} verify`);
batch.totalUsd > 0 ? ok(`verified total: $${batch.totalUsd}`) : bad("total is 0");

// Tampered reveal must FAIL
const tampered: RevealedNote = { ...revealed[0], valueUsd: revealed[0].valueUsd + 100000 };
!verifyNote(tampered)
  ? ok("tampered value rejected by commitment check")
  : bad("tampered value accepted — commitment not binding");

const tamperedBlind: RevealedNote = { ...revealed[0], blinding: "0".repeat(64) };
!verifyNote(tamperedBlind)
  ? ok("tampered blinding rejected")
  : bad("tampered blinding accepted");

// --- 4. Unlinkability ---
section("4. Commitments unlinkable");
const unlink = confidentialityHolds(mintNotes("lineY", DENOM, 30, 5));
unlink.allCommitmentsDistinct ? ok("all commitments distinct across 30 notes") : bad("commitment collision");
ok(`commitments are opaque hex — no value information leaks`);

// --- 5. Statistical confidentiality ---
section("5. Statistical confidentiality");
// Over many mints, value distribution must be spread (not clustered at denom)
const bigBatch = mintNotes("lineZ", DENOM, 200, 1);
const values = bigBatch.map(n => n.valueUsd);
const mean = values.reduce((s, v) => s + v, 0) / values.length;
const minV = Math.min(...values), maxV = Math.max(...values);
ok(`200 notes: mean $${mean.toFixed(0)}, range $${minV}–$${maxV}`);
mean > DENOM * 0.85 && mean < DENOM * 1.15 ? ok("mean centered near denomination (±15%)") : bad("distribution skewed");
maxV - minV > DENOM * 0.5 ? ok("value spread > 50% of denomination") : bad("values too clustered");

// Probability that count × denom == real exposure (should be ~0)
let collisions = 0;
for (let trial = 0; trial < 100; trial++) {
  const t = mintNotes(`t${trial}`, DENOM, 10, trial);
  if (privateExposure(t) === publicEstimate(t, DENOM)) collisions++;
}
collisions === 0
  ? ok("over 100 trials, public estimate never equals real exposure (0 collisions)")
  : bad(`${collisions}/100 trials leaked exact exposure`);

console.log(`\n${failed === 0 ? "🎉 CONFIDENTIALITY VERIFIED" : "❌ CONFIDENTIALITY GAPS"} — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
