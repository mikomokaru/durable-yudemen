import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/cpsat-counts.json";

function summarize(path: string) {
  return spawnSync(
    "pnpm",
    [
      "exec",
      "vite-node",
      "--config",
      "tools/preflight.vite.config.ts",
      "tools/observe/cpsat-summary.ts",
      path,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    },
  );
}

describe("CP-SAT summary CLI", () => {
  it("runs the saved fixture without cloud, then rejects its missing-middle-row variant", () => {
    const positive = summarize("tests/observe/fixtures/cpsat-counts.json");
    expect(positive.error).toBeUndefined();
    expect(positive.status).toBe(0);
    expect(positive.stdout).toContain('"generated": 2');
    expect(positive.stdout).toContain('"dispatched": 1');
    expect(positive.stdout).toContain('"solveStarted": 0');
    const directory = mkdtempSync(join(tmpdir(), "cpsat-observation-"));
    const path = join(directory, "missing-dispatch.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({ ...fixture, rows: fixture.rows.filter((row) => row.eventId !== "d-2") }),
      );
      const negative = summarize(path);
      expect(negative.error).toBeUndefined();
      expect(negative.status).toBe(1);
      expect(negative.stdout).toContain('"usableForRates": false');
      expect(negative.stdout).toContain('"counts": null');
      expect(negative.stdout).toContain("broken-causal-link");
    } finally {
      unlinkSync(path);
      rmdirSync(directory);
    }
  });

  it("reports invalid input without printing the path or raw exception", () => {
    const result = summarize("__missing_cpsat_fixture_SECRET__.json");
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain("SECRET");
  });
});
