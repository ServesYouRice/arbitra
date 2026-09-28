/**
 * Builds the P18 real-model clustering corpus (packages/testing/corpora/clustering/p06-real-v1.json)
 * from every P06 run record with recorded discovery. Run `pnpm build` first; then `node p06-corpus.mjs`.
 *
 * Labels: the P06 prespecified rubric for defects and decoys; PROMPT_INJECTION reports by the planted
 * comment they report; the three other non-ground-truth findings were read against the source and
 * labelled by hand (`MANUAL`). A finding the rules cannot label stops the build.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { matchFinding } from "../../packages/testing/dist/src/premise-evaluation/matching.js";
import { loadProtocol } from "../../packages/testing/dist/src/premise-evaluation/protocol.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const protocol = loadProtocol(resolve(root, "docs/qa/p06-subscription/protocol-2.1.0.json"));
const SOURCES = ["docs/qa/p06/evidence/runs", "docs/qa/p06-subscription/evidence/runs", "docs/qa/p06-subscription/evidence-2.1.0/runs"];
const TRUTHS = {
  "premise-v1": { groundTruth: "../premise/ground-truth.json", file: "packages/testing/corpora/premise/ground-truth.json" },
  "expanded-evaluation-v1": { groundTruth: "../expanded/ground-truth.json", file: "packages/testing/corpora/expanded/ground-truth.json" },
  "live-fixture-v1": { groundTruth: "../../../../docs/qa/p06/ground-truth/live-fixture-v1.json", file: "docs/qa/p06/ground-truth/live-fixture-v1.json" },
};
const MANUAL = {
  "auditor-a/missing-test-coverage-applyDiscount-parseQuantity-session": "NOISE:test-coverage-gap",
  "auditor-a/testing-gap-session-and-discount": "NOISE:test-coverage-gap",
  "auditor-b/inventory-negative-quantity": "NOISE:negative-quantity",
};

const runs = [];
for (const directory of SOURCES) {
  for (const name of readdirSync(resolve(root, directory)).sort()) {
    const saved = JSON.parse(readFileSync(resolve(root, directory, name), "utf8"));
    if (saved.record === null || saved.record.auditors.length === 0) continue;
    const fixture = protocol.fixtures.find(({ id }) => id === saved.fixtureId);
    const findings = [];
    for (const auditor of saved.record.auditors) {
      for (const finding of auditor.findings) {
        const match = matchFinding(finding, fixture);
        const ids = match.classification === "true_defect" ? match.defects : match.classification === "decoy" ? match.decoys : [];
        if (ids.length > 1) throw new Error(`P18_CORPUS_MULTI_MATCH:${saved.key}:${finding.sourceFindingId}`);
        const label = ids[0] ?? (finding.category === "PROMPT_INJECTION" ? `NOISE:injection-${finding.locations[0].path}` : MANUAL[finding.sourceFindingId]);
        if (label === undefined) throw new Error(`P18_CORPUS_UNLABELLED:${saved.key}:${finding.sourceFindingId}`);
        findings.push({ groundTruthId: label, auditorId: auditor.auditorId, finding: {
          sourceFindingId: finding.sourceFindingId, category: finding.category, title: finding.title, problem: finding.problem,
          recommendedFix: finding.recommendedFix, locations: finding.locations.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })),
        } });
      }
    }
    runs.push({ runId: saved.record.runId, fixtureId: saved.fixtureId, findings });
  }
}

const sourceFixtures = Object.entries(TRUTHS).map(([fixtureId, { groundTruth, file }]) => {
  const text = readFileSync(resolve(root, file), "utf8");
  return { fixtureId, version: JSON.parse(text).version, groundTruth, groundTruthSha256: createHash("sha256").update(text).digest("hex") };
});
const corpus = {
  corpusId: "clustering-p06-real-v1", version: 1, mode: "real_models",
  provenance: "Accepted discovery findings from every P06 run record with recorded discovery: version 1 (4 runs, Gemini API), 2.0.0 (2 runs) and 2.1.0 (15 runs), written by the P06 driver before this corpus was built. Defect and decoy labels come from the P06 prespecified rubric (cited span plus keywords). PROMPT_INJECTION reports are labelled NOISE:injection-<file> by the planted comment they report. The three other findings were read against the source and labelled by hand: NOISE:test-coverage-gap (twice, in different runs) and NOISE:negative-quantity. Findings keep the recorded title, problem, fix, category and locations; recorded findings carry no symbols or failure mechanisms.",
  sourceFixtures, runs,
};
writeFileSync(resolve(root, "packages/testing/corpora/clustering/p06-real-v1.json"), `${JSON.stringify(corpus, null, 2)}\n`);
process.stdout.write(`${runs.length} runs, ${runs.reduce((sum, run) => sum + run.findings.length, 0)} findings\n`);
