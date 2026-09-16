import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Explicit allow-list: no raw order IDs, timestamps, placements, protos or secrets.
const directory = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const read = async (name) => JSON.parse(await readFile(`${directory}/${name}`, "utf8"));
const summary = await read("summary.json");
const manifest = await read("manifest.json");
const files = (await readdir(directory)).filter((name) => /^replay-\d+\.json$/.test(name)).sort();
const same = (a, b) =>
  b !== null &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((k) => a[k] === b[k]);
const rows = [];
let optimalChecks = 0,
  feasibleChecks = 0,
  maxTreeGap = 0;
for (const file of files) {
  const { preferences, result: r } = await read(file);
  assert.equal(r.completedItems, r.expectedItems);
  optimalChecks += r.optimalObjectiveChecks;
  feasibleChecks += r.feasibleObjectiveChecks;
  maxTreeGap = Math.max(maxTreeGap, r.maxAuxiliaryTreeGap);
  rows.push({
    store: r.historyId,
    baseline: same(preferences, summary.baselinePreferences),
    selected: same(preferences, summary.selectedPreferences),
    split: manifest.trainStores.includes(r.historyId) ? "train" : "holdout",
    completedItems: r.completedItems,
    evaluatedItems: r.evaluatedItems ?? r.completedItems,
    waitSummary: r.waitSummary ?? null,
    wasm: r.wasm ?? null,
    features: r.features,
    fixedScore: r.fixedScore,
    fragmentMinutes: r.fragmentMinutes,
    distanceMinutes: r.distanceMinutes,
    solveCount: r.solveCount,
    fallbackCount: r.fallbackCount,
    statuses: r.statuses,
    maxVariables: r.maxVariables,
    maxConstraints: r.maxConstraints,
    maxDeterministicTime: r.maxDeterministicTime,
    // Allows independent replay equality checks without publishing placements.
    replaySha256: createHash("sha256")
      .update(JSON.stringify({ placements: r.placements, trace: r.trace, features: r.features }))
      .digest("hex"),
  });
}
const evaluations =
  files.length && manifest.trials && summary.evaluatedConfigurations
    ? await read("evaluations.json")
    : [];
const audited = rows.length ? await read(files[0]) : null;
const reportAudit = audited?.result.reportedObjectiveMismatches !== undefined;
const audits = reportAudit ? await Promise.all(files.map(read)) : [];
const result = {
  ...summary,
  seed: manifest.seed,
  versions: manifest.versions,
  trainStores: manifest.trainStores,
  holdoutStores: manifest.holdoutStores,
  inputVersion: manifest.corpus.inputVersion,
  sourceSha256: manifest.sourceSha256,
  corpusSha256: Object.fromEntries(manifest.corpus.stores.map((s) => [s.id, s.sourceSha256])),
  policySha256: manifest.corpus.policySha256,
  adminSha256: manifest.corpus.adminSha256,
  localOnly: true,
  searchRuntime: manifest.searchRuntime ?? "native",
  transport: manifest.transport ?? null,
  optimalObjectiveChecks: optimalChecks,
  feasibleObjectiveChecks: feasibleChecks,
  maxAuxiliaryTreeGap: maxTreeGap,
  objectiveAudit: reportAudit ? "decomposed-v2" : "combined-upper-bound-v1",
  reportedObjectiveMismatches: reportAudit
    ? audits.reduce((s, r) => s + r.result.reportedObjectiveMismatches, 0)
    : null,
  maxReportedObjectiveGap: reportAudit
    ? Math.max(...audits.map((r) => r.result.maxReportedObjectiveGap))
    : null,
  maxVariables: Math.max(...rows.map((r) => r.maxVariables)),
  maxConstraints: Math.max(...rows.map((r) => r.maxConstraints)),
  maxDeterministicTime: Math.max(...rows.map((r) => r.maxDeterministicTime)),
  bestExplored: evaluations.toSorted((a, b) => a.score - b.score)[0] ?? null,
  evaluations,
  rows,
};
await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    output,
    replays: rows.length,
    solves: summary.totalSolves,
    optimalChecks,
    feasibleChecks,
    maxTreeGap,
  }),
);
