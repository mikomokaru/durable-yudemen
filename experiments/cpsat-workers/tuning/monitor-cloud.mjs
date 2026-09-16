import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

assert(process.argv[2]);
const directory = process.argv[2];
const summary = JSON.parse(await readFile(`${directory}/summary.json`, "utf8"));
const text = await readFile(`${directory}/requests.jsonl`, "utf8");
const lines = text.split("\n");
// A concurrently appended final line may not be complete yet.
lines.pop();
const requests = lines.filter(Boolean).map(JSON.parse);
const results = requests.filter((r) => r.kind === "result");
const counts = {};
for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, "utf8"));
const coverage = new Map();
const replayNames = (await readdir(directory)).filter((n) => /^replay-\d+\.json$/.test(n));
for (const name of replayNames) {
  const { preferences, history } = JSON.parse(await readFile(`${directory}/${name}`, "utf8"));
  if (!manifest.trainHistories.includes(history)) continue;
  const key = JSON.stringify(Object.entries(preferences).sort(([a], [b]) => a.localeCompare(b)));
  coverage.set(key, (coverage.get(key) ?? 0) + 1);
}
const importedAttempts = summary.importedAttempts ?? 0;
console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    startedAt: summary.startedAt,
    state: summary.status,
    completedReplays: replayNames.length,
    completedConfigurations: summary.evaluatedConfigurations,
    trainCoverage: [...coverage.values()],
    requiredTrainHistories: manifest.trainHistories.length,
    extensionAttempts: importedAttempts
      ? requests.filter((r) => r.kind === "attempt").length - importedAttempts
      : null,
    extensionErrors: importedAttempts
      ? requests.filter((r) => r.kind === "error" && r.number > importedAttempts).length
      : null,
    attemptedSolves: requests.filter((r) => r.kind === "attempt").length,
    completedSolves: results.length,
    errors: requests.filter((r) => r.kind === "error").length,
    statuses: counts,
    isolateCount: new Set(results.map((r) => r.isolateId)).size,
    maxMemoryBytes: results.reduce((max, r) => Math.max(max, r.wasmMemoryBytes), 0),
    maxVariables: results.reduce((max, r) => Math.max(max, r.modelVariables), 0),
    baselineTrainScore: summary.baselineTrainScore,
    selectedTrainScore: summary.selectedTrainScore,
    baselineHoldoutScore: summary.baselineHoldoutScore,
    selectedHoldoutScore: summary.selectedHoldoutScore,
  }),
);
