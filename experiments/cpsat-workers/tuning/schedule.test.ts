import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, test } from "vitest";
import { replayOrderHistory, type SchedulePreferences } from "./schedule";
import defaults from "./defaults.json";

const child = spawn(
  "experiments/cpsat-workers/fixtures/local/tuning-venv/bin/python",
  ["experiments/cpsat-workers/tuning/native_bridge.py"],
  {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" },
  },
);
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const solve: Parameters<typeof replayOrderHistory>[2] = async (model) => {
  child.stdin.write(`${JSON.stringify({ model })}\n`);
  const reply = await lines.next();
  assert(!reply.done, "Native bridge closed");
  const result = JSON.parse(reply.value);
  assert(!result.error, result.error);
  return result;
};
afterAll(() => child.kill());
const waitOnly = Object.fromEntries(
  Object.keys(defaults).map((key) => [key, 0]),
) as unknown as SchedulePreferences;
type History = Parameters<typeof replayOrderHistory>[0];
const coordinates = Array.from({ length: 6 }, (_, s) => ({ x: s % 3, y: Math.floor(s / 3) }));
function history(items: History["items"], changes: Partial<History> = {}): History {
  return {
    id: "synthetic",
    items,
    coordinates,
    arms: 2,
    liftWindow: 1,
    tolerancePercent: 0,
    ...changes,
  };
}
function item(id: string, boilSeconds: number, purchasedAt = 0, slotSpan = 1, order = id) {
  return { id, boilSeconds, purchasedAt, slotSpan, order };
}
describe("isolated native CP-SAT replay", () => {
  test("scores the purchase cohort including late lifts and adjacent context, not just lifts inside the window", async () => {
    const result = await replayOrderHistory(
      history([item("warmup", 60, 0), item("evaluation", 50, 30), item("tail", 10, 60)], {
        evaluationWindow: { start: 30, end: 60 },
      }),
      waitOnly,
      solve,
    );
    expect(result.completedItems).toBe(3);
    expect(result.evaluatedItems).toBe(1);
    expect(result.features.waitSeconds).toBe(50);
    expect(result.features.clusters).toBe(1);
    expect(result.features.purchaseInversions).toBe(1);
    expect(result.features.gapShortfallSeconds).toBe(35);
    expect(result.placements.find((p) => p.id === "evaluation")!.end).toBe(80);
    expect(result.waitSummary).toEqual({
      total: 50,
      mean: 50,
      p95: 50,
      max: 50,
      over720Seconds: 0,
    });
  });
  test("an all-inclusive cohort preserves the existing scoring contract", async () => {
    const h = history([item("a", 20), item("b", 15, 2)]);
    const first = await replayOrderHistory(h, defaults, solve);
    const second = await replayOrderHistory(
      { ...h, evaluationWindow: { start: 0, end: 100 } },
      defaults,
      solve,
    );
    expect(first.features).toEqual(second.features);
    expect(first.fixedScore).toBe(second.fixedScore);
    expect(first.placements).toEqual(second.placements);
  });
  test("rejects an empty or invalid evaluation cohort", async () => {
    await expect(
      replayOrderHistory(
        history([item("a", 10)], { evaluationWindow: { start: 10, end: 20 } }),
        defaults,
        solve,
      ),
    ).rejects.toThrow("Empty evaluation cohort");
    await expect(
      replayOrderHistory(
        history([item("a", 10)], { evaluationWindow: { start: 10, end: 0 } }),
        defaults,
        solve,
      ),
    ).rejects.toThrow();
  });
  test("advances across an empty kitchen between separated purchases", async () => {
    const result = await replayOrderHistory(
      history([item("a", 10), item("b", 10, 100)]),
      waitOnly,
      solve,
    );
    expect(result.placements.map((p) => p.end)).toEqual([10, 110]);
    expect(result.features.waitSeconds).toBe(20);
  });
  test("sums purchase-to-lift wait per bowl, not per slot or order maximum", async () => {
    const result = await replayOrderHistory(
      history([item("a", 300, 0, 1, "order"), item("b", 417, 0, 1, "order")]),
      waitOnly,
      solve,
    );
    expect(result.features.waitSeconds).toBe(720);
    expect(result.completedItems).toBe(2);
    expect(result.fallbackCount).toBe(0);
  });
  test("both overflow tiers stay soft even above arms + 2", async () => {
    const result = await replayOrderHistory(
      history(Array.from({ length: 5 }, (_, i) => item(String(i), 60 - 3 * i))),
      waitOnly,
      solve,
    );
    expect(result.placements.map((v) => v.end)).toEqual([60, 60, 60, 60, 60]);
    expect(result.features.liftOverflow).toBe(2);
    expect(result.features.severeLiftOverflow).toBe(1);
    expect(result.features.clusters).toBe(1);
    expect(result.features.purchaseInversions).toBe(0);
  });
  test("a two-slot bowl incurs one wait but two lifts; adjacency has no internal gap", async () => {
    const result = await replayOrderHistory(
      history([item("a", 120, 0, 2)], { arms: 1 }),
      defaults,
      solve,
    );
    expect(result.features.waitSeconds).toBe(120);
    expect(result.features.liftOverflow).toBe(1);
    expect(result.features.multiSlotDistance).toBe(0);
    expect(result.placements[0]!.slots).toHaveLength(2);
    expect(result.fallbackCount).toBe(0);
  });
  test("fires a due lift before a same-time arrival and never drifts the recipe window", async () => {
    const result = await replayOrderHistory(
      history([item("a", 10), item("b", 10, 8)], { tolerancePercent: 20 }),
      waitOnly,
      solve,
    );
    expect(result.placements.find((v) => v.id === "a")!.end).toBe(8);
    expect(result.trace.find((v) => v.at === 8)?.lifted).toEqual(["a"]);
    for (const p of result.placements)
      expect(Math.abs(p.end - p.start - p.boilSeconds)).toBeLessThanOrEqual(2);
  });
  test("checks exact optimal objectives including geometry, FIFO, gaps, and slot-change terms", async () => {
    const result = await replayOrderHistory(
      history([item("a", 90, 0, 2, "x"), item("b", 30, 1, 1, "x"), item("c", 40, 5)], {
        tolerancePercent: 10,
      }),
      defaults,
      solve,
    );
    expect(result.completedItems).toBe(3);
    expect(result.fallbackCount).toBe(0);
    expect(result.statuses.OPTIMAL).toBeGreaterThan(0);
    expect(Number.isFinite(result.fixedScore)).toBe(true);
  });
  test("completes all items beyond the rolling horizon and reproduces the same result", async () => {
    const h = history([item("a", 20), item("b", 15), item("c", 10), item("d", 12)]);
    const first = await replayOrderHistory(h, defaults, solve, { pendingLimit: 2 });
    const second = await replayOrderHistory(h, defaults, solve, { pendingLimit: 2 });
    expect(first.completedItems).toBe(4);
    expect(first).toEqual(second);
  });
  test("rejects malformed preferences and invalid item spans before solving", async () => {
    await expect(
      replayOrderHistory(history([item("a", 10)]), { ...defaults, liftOverflowCost: -1 }, solve),
    ).rejects.toThrow();
    await expect(
      replayOrderHistory(history([item("a", 10, 0, 1.5)]), defaults, solve),
    ).rejects.toThrow();
  });
  test("reports UNKNOWN fallback explicitly, while still preserving every bowl", async () => {
    const result = await replayOrderHistory(history([item("a", 10)]), defaults, async (model) => ({
      status: "UNKNOWN",
      objective: null,
      solution: [],
      deterministicTime: model.budget,
      modelVariables: model.variables.length,
      modelConstraints: model.constraints.length,
    }));
    expect(result.fallbackCount).toBeGreaterThan(0);
    expect(result.completedItems).toBe(1);
  });
});
