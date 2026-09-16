// Public report: aggregated metrics only, never orders/placements/protobuf/secrets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

assert(process.argv[2] && process.argv[3]);
const directory = resolve(process.argv[2]);
const read = async (name) => JSON.parse(await readFile(`${directory}/${name}`, "utf8"));
const summary = await read("summary.json");
const manifest = await read("manifest.json");
const names = (await readdir(directory)).filter((name) => /^replay-\d+\.json$/.test(name)).sort();
const same = (a, b) => b !== null && Object.keys(a).every((k) => a[k] === b[k]);
const rows = [];
for (const name of names) {
  const { history, preferences, result: r } = await read(name);
  assert.equal(r.completedItems, r.expectedItems);
  rows.push({
    history,
    preferences,
    baseline: same(preferences, summary.baselinePreferences),
    selected: same(preferences, summary.selectedPreferences),
    split: manifest.trainHistories.includes(history) ? "train" : "holdout",
    completedItems: r.completedItems,
    evaluatedItems: r.evaluatedItems,
    waitSummary: r.waitSummary,
    features: r.features,
    fixedScore: r.fixedScore,
    fragmentMinutes: r.fragmentMinutes,
    distanceMinutes: r.distanceMinutes,
    solveCount: r.solveCount,
    fallbackCount: r.fallbackCount,
    statuses: r.statuses,
    cloud: r.cloud,
    maxVariables: r.maxVariables,
    maxConstraints: r.maxConstraints,
    maxDeterministicTime: r.maxDeterministicTime,
    optimalObjectiveChecks: r.optimalObjectiveChecks,
    feasibleObjectiveChecks: r.feasibleObjectiveChecks,
    reportedObjectiveMismatches: r.reportedObjectiveMismatches,
    maxReportedObjectiveGap: r.maxReportedObjectiveGap,
    replaySha256: createHash("sha256")
      .update(JSON.stringify({ placements: r.placements, trace: r.trace, features: r.features }))
      .digest("hex"),
  });
}
const statuses = {},
  latencies = [],
  isolates = new Set();
const responsesPerIsolate = new Map();
const inFlight = new Set();
let peakConcurrentSolves = 0;
let attempts = 0,
  completed = 0,
  errors = 0,
  validated = 0,
  maxMemory = 0,
  maxVariables = 0;
for await (const line of createInterface({
  input: createReadStream(`${directory}/requests.jsonl`),
  crlfDelay: Infinity,
})) {
  const r = JSON.parse(line);
  if (r.kind === "attempt") {
    attempts++;
    assert(!inFlight.has(r.number), "Duplicate in-flight request number");
    inFlight.add(r.number);
    peakConcurrentSolves = Math.max(peakConcurrentSolves, inFlight.size);
  } else {
    assert(inFlight.delete(r.number), "Response without a matching attempt");
  }
  if (r.kind === "error") errors++;
  if (r.kind !== "result") continue;
  completed++;
  validated += Number(r.validated);
  statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  latencies.push(r.clientElapsedMs);
  isolates.add(r.isolateId);
  responsesPerIsolate.set(r.isolateId, (responsesPerIsolate.get(r.isolateId) ?? 0) + 1);
  maxMemory = Math.max(maxMemory, r.wasmMemoryBytes);
  maxVariables = Math.max(maxVariables, r.modelVariables);
}
latencies.sort((a, b) => a - b);
const evaluations = summary.evaluatedConfigurations ? await read("evaluations.json") : [];
const coverage = new Map();
for (const row of rows.filter((r) => r.split === "train")) {
  const key = JSON.stringify(
    Object.entries(row.preferences).sort(([a], [b]) => a.localeCompare(b)),
  );
  const group = coverage.get(key) ?? {
    preferences: row.preferences,
    baseline: row.baseline,
    histories: [],
    partialScore: 0,
  };
  group.histories.push(row.history);
  group.partialScore += row.fixedScore;
  coverage.set(key, group);
}
const configurationCoverage = [...coverage.values()].map((group) => ({
  preferences: group.preferences,
  baseline: group.baseline,
  completedTrainHistories: group.histories.length,
  requiredTrainHistories: manifest.trainHistories.length,
  complete: group.histories.length === manifest.trainHistories.length,
  comparableTrainScore:
    group.histories.length === manifest.trainHistories.length ? group.partialScore : null,
}));
function aggregate(preferences, split) {
  if (!preferences) return null;
  const group = rows.filter((row) => row.split === split && same(row.preferences, preferences));
  const expected =
    split === "train" ? manifest.trainHistories.length : manifest.holdoutHistories.length;
  if (group.length !== expected) return null;
  const sum = (get) => group.reduce((total, row) => total + get(row), 0);
  const evaluatedItems = sum((row) => row.evaluatedItems);
  const waitSeconds = sum((row) => row.waitSummary.total);
  return {
    histories: group.length,
    completedItems: sum((row) => row.completedItems),
    evaluatedItems,
    fixedScore: sum((row) => row.fixedScore),
    waitSeconds,
    meanWaitSeconds: waitSeconds / evaluatedItems,
    maxWaitSeconds: Math.max(...group.map((row) => row.waitSummary.max)),
    over720Seconds: sum((row) => row.waitSummary.over720Seconds),
    solveCount: sum((row) => row.solveCount),
    fallbackCount: sum((row) => row.fallbackCount),
    features: Object.fromEntries(
      Object.keys(group[0].features).map((name) => [name, sum((row) => row.features[name])]),
    ),
    fragmentMinutes: sum((row) => row.fragmentMinutes),
    distanceMinutes: sum((row) => row.distanceMinutes),
    reportedObjectiveMismatches: sum((row) => row.reportedObjectiveMismatches),
    maxReportedObjectiveGap: Math.max(...group.map((row) => row.maxReportedObjectiveGap)),
  };
}
const result = {
  reportGeneratorSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  ...Object.fromEntries(
    [
      "status",
      "searchRuntime",
      "startedAt",
      "originalStartedAt",
      "updatedAt",
      "elapsedSeconds",
      "parallelHistories",
      "parallelCandidates",
      "attemptedSolves",
      "importedAttempts",
      "extensionAttempts",
      "completedReplays",
      "completedReplaySolves",
      "totalFallbacks",
      "evaluatedConfigurations",
      "trainingStop",
      "baselinePreferences",
      "selectedPreferences",
      "baselineTrainScore",
      "selectedTrainScore",
      "baselineHoldoutScore",
      "selectedHoldoutScore",
    ].map((k) => [k, summary[k]]),
  ),
  localOnly: false,
  nativeSolverUsed: false,
  manifest: {
    transport: manifest.transport,
    args: manifest.args,
    versions: manifest.versions,
    sourceSha256: manifest.sourceSha256,
    inputVersion: manifest.corpus.inputVersion,
    policySha256: manifest.corpus.policySha256,
    adminSha256: manifest.corpus.adminSha256,
    corpusManifestSha256: manifest.corpus.manifestSha256,
    histories: manifest.corpus.stores,
    batchDriverSha256: manifest.batchDriverSha256 ?? null,
    extensionDriverSha256: manifest.extensionDriverSha256 ?? null,
    resumeSource: manifest.resumeSource
      ? {
          manifestSha256: manifest.resumeSource.manifestSha256,
          journalSha256: manifest.resumeSource.journalSha256,
          spentRequests: manifest.resumeSource.spentRequests,
          replays: manifest.resumeSource.replays,
        }
      : null,
    explicitHostSleepRecovery: manifest.explicitHostSleepRecovery ?? false,
    absoluteDeadlineUtc: manifest.absoluteDeadlineUtc ?? null,
    requestStartDeadlineUtc: manifest.requestStartDeadlineUtc ?? null,
    deadlineClocks: manifest.deadlineClocks ?? null,
    cleanupReserveSeconds: manifest.cleanupReserveSeconds ?? null,
    importedBaseline: manifest.importedBaseline
      ? {
          manifestSha256: manifest.importedBaseline.manifestSha256,
          journalSha256: manifest.importedBaseline.journalSha256,
          spentRequests: manifest.importedBaseline.spentRequests,
          elapsedSeconds: manifest.importedBaseline.elapsedSeconds,
        }
      : null,
    parallelUnit: manifest.parallelUnit,
    initialDesign: manifest.initialDesign,
    completionOrderDoesNotAffectTellOrder: manifest.completionOrderDoesNotAffectTellOrder ?? null,
  },
  requestMetrics: {
    attempts,
    completed,
    errors,
    validated,
    peakConcurrentSolves,
    unsettledAttempts: inFlight.size,
    statuses,
    isolateCount: isolates.size,
    maxResponsesPerIsolate: Math.max(0, ...responsesPerIsolate.values()),
    maxMemoryBytes: maxMemory,
    maxVariables,
    meanRequestMs: completed ? latencies.reduce((a, b) => a + b, 0) / completed : null,
    p95RequestMs: latencies[Math.ceil(completed * 0.95) - 1] ?? null,
    maxRequestMs: latencies.at(-1) ?? null,
  },
  evaluations,
  comparisons: {
    baseline: {
      train: aggregate(summary.baselinePreferences, "train"),
      holdout: aggregate(summary.baselinePreferences, "holdout"),
    },
    selected: {
      train: aggregate(summary.selectedPreferences, "train"),
      holdout: aggregate(summary.selectedPreferences, "holdout"),
    },
  },
  configurationCoverage,
  completedNonDefaultConfigurations: configurationCoverage.filter((r) => r.complete && !r.baseline)
    .length,
  rows,
};
await writeFile(process.argv[3], JSON.stringify(result, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: result.status,
    replays: rows.length,
    metrics: result.requestMetrics,
    baselineTrainScore: result.baselineTrainScore,
    selectedTrainScore: result.selectedTrainScore,
    baselineHoldoutScore: result.baselineHoldoutScore,
    selectedHoldoutScore: result.selectedHoldoutScore,
  }),
);
