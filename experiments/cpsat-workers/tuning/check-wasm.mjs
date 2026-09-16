import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateSolution as validate } from "./validate-solution.mjs";

// Uses the existing localhost-only workerd harness. No cloud URL/deploy option.
const directory = resolve(process.argv[2]);
const captures = JSON.parse(await readFile(`${directory}/captures.json`, "utf8"));
const nativePath = `${directory}/wasm-input.json`;
const outputPath = `${directory}/wasm-output.json`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scenes = captures.map((entry, index) => ({
  id: `capture-${index}`,
  budget: entry.model.budget,
  protoBase64: entry.native.protoBase64,
  protoSha256: hash(Buffer.from(entry.native.protoBase64, "base64")),
}));
if (!process.argv.includes("--analyze-only")) {
  await writeFile(nativePath, JSON.stringify({ budget: 0.2, repeat: 3, scenes }), {
    mode: 0o600,
    flag: "wx",
  });
  await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      ["experiments/cpsat-workers/scripts/benchmark-real-orders.mjs", nativePath, outputPath],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? accept() : reject(new Error(`Workerd check exited ${code}`)),
    );
  });
}
const report = JSON.parse(await readFile(outputPath, "utf8"));
assert.equal(report.requests.length, captures.length * 6);
const rows = report.requests.map((request) => {
  const index = Number(request.id.split("-")[1]);
  const { model, native } = captures[index];
  const result = request.body.samples[0];
  assert(["OPTIMAL", "FEASIBLE"].includes(result.status));
  const recomputedObjective = validate(model, result);
  const nativeRecomputedObjective = validate(model, native);
  assert.equal(result.requestedDeterministicLimit, model.budget);
  assert.equal(result.wallTimeLimitEnabled, false);
  assert.equal(result.sharedWasmMemory, false);
  if (request.clock === "frozen") assert(result.frozenClockReads > 0);
  if (native.status === "OPTIMAL" && result.status === "OPTIMAL")
    assert.equal(result.objective, native.objective);
  return {
    id: request.id,
    clock: request.clock,
    repeat: request.repeat,
    status: result.status,
    nativeStatus: native.status,
    objective: result.objective,
    nativeObjective: native.objective,
    recomputedObjective,
    nativeRecomputedObjective,
    reportedObjectiveMismatch: result.objective !== recomputedObjective,
    sameObjective: result.objective === native.objective,
    sameSolution: JSON.stringify(result.solution) === JSON.stringify(native.solution),
    sameStatus: result.status === native.status,
    modelVariables: result.modelVariables,
    modelConstraints: result.modelConstraints,
    deterministicTime: result.deterministicTime,
    budget: model.budget,
    wasmMemoryBytes: result.wasmMemoryBytes,
    clientElapsedMs: request.clientElapsedMs,
  };
});
for (const scene of scenes) {
  const group = report.requests.filter((r) => r.id === scene.id).map((r) => r.body.samples[0]);
  // Both clocks and every repetition must yield the exact same solver outcome.
  const stable = (r) => JSON.stringify([r.status, r.objective, r.solution, r.deterministicTime]);
  assert(
    group.every((r) => stable(r) === stable(group[0])),
    `Unstable Wasm result: ${scene.id}`,
  );
}
const summary = {
  localOnly: true,
  captureSha256: hash(await readFile(`${directory}/captures.json`)),
  wasmSha256: report.wasmSha256,
  requests: rows.length,
  validSolutions: rows.length,
  sameObjectiveAsNative: rows.filter((r) => r.sameObjective).length,
  sameSolutionAsNative: rows.filter((r) => r.sameSolution).length,
  sameStatusAsNative: rows.filter((r) => r.sameStatus).length,
  reportedObjectiveMismatches: rows.filter((r) => r.reportedObjectiveMismatch).length,
  objectiveContractPassed: rows.every((r) => !r.reportedObjectiveMismatch),
  productionAdoption: "deferred",
  repeatedAndFrozenClockStable: true,
  startup: report.startup,
  minWasmMemoryBytes: Math.min(...rows.map((r) => r.wasmMemoryBytes)),
  maxWasmMemoryBytes: Math.max(...rows.map((r) => r.wasmMemoryBytes)),
  rows,
};
const summaryOutput =
  process.argv.find((v) => v.startsWith("--summary-output="))?.slice("--summary-output=".length) ??
  `${directory}/wasm-summary.json`;
await writeFile(summaryOutput, JSON.stringify(summary, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(JSON.stringify({ ...summary, rows: undefined }));
