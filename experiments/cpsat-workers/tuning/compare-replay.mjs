import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

assert(process.argv[2] && process.argv[3] && process.argv[4]);
const entries = await Promise.all(
  process.argv.slice(2, 4).map(async (path) => JSON.parse(await readFile(path, "utf8"))),
);
const digest = (result) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        placements: result.placements,
        trace: result.trace,
        features: result.features,
      }),
    )
    .digest("hex");
const [a, b] = entries;
assert.deepEqual(a.preferences, b.preferences);
// Compare hashes rather than printing raw order/placement data on assertion failure.
assert.equal(digest(a.result), digest(b.result), "Replay behavior differs");
assert.equal(a.result.fixedScore, b.result.fixedScore);
assert.equal(a.result.solveCount, b.result.solveCount);
const report = {
  identicalBehavior: true,
  replaySha256: digest(a.result),
  solveCount: a.result.solveCount,
  completedItems: a.result.completedItems,
  evaluatedItems: a.result.evaluatedItems,
  fixedScore: a.result.fixedScore,
};
await writeFile(process.argv[4], JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(JSON.stringify(report));
