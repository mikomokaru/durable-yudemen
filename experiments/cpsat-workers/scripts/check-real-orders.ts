import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Effect } from "../../../src/engine/effect";
import type { EpochMillis } from "../../../src/engine/types";
import { itemKeyOf } from "../../../src/domain/order";
import { tableMembers } from "../../../src/engine/project";
import { initialLifts, advanceLifts, liftsOf, withinLiftCap } from "../../../src/engine/lift";
import { admit } from "../../../src/engine/admit";
import { scoreSchedule } from "../../../src/engine/objective";
import {
  type CookSchedule,
  toCookSchedule,
  initialRelease,
  feasibleRelease,
  isStale,
  keepsAnchor,
} from "../../../src/engine/schedule";

// Local, hash-bound outputs of prepare-real-scenes.ts and real_orders.py, not a public input API.
interface Scene {
  id: string;
  sampleStoreCode: string;
  now: EpochMillis;
  request: Omit<Extract<Effect, { type: "RequestPlan" }>, "type">;
  baseline: CookSchedule;
}
interface Sample {
  status: string;
  objective: number | null;
  bestBound: number;
  solution: number[];
  deterministicTime: number;
  branches: number;
  conflicts: number;
}
interface Model {
  id: string;
  startVariables: number[];
  endVariables: number[];
  slotVariables: number[][];
  modelVariables: number;
  pinnedAnchors: number;
  freeItems: number;
  samples: Sample[];
}
const directory = resolve("experiments/cpsat-workers/fixtures/local");
const nativePath = resolve(process.argv[2] ?? `${directory}/native-real.json`);
const workerPath = process.argv[3];
const outputPath = resolve(process.argv[4] ?? `${directory}/real-checks.json`);
const sceneBytes = readFileSync(`${directory}/real-scenes.json`);
const source = JSON.parse(sceneBytes.toString()) as { seed: string; scenes: Scene[] };
const nativeBytes = readFileSync(nativePath);
const native = JSON.parse(nativeBytes.toString()) as {
  sceneSha256: string;
  budget: number;
  repeat: number;
  scenes: Model[];
};
function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
assert.equal(hash(sceneBytes), native.sceneSha256);
const scenes = new Map(source.scenes.map((scene) => [scene.id, scene]));
assert.equal(scenes.size, source.scenes.length);

function checkPlan(scene: Scene, raw: unknown): string[] {
  const plan = toCookSchedule(raw);
  if (plan === null) return ["shape"];
  const { pending, running, params, noodlePresets } = scene.request;
  const expected = pending.map(itemKeyOf).sort();
  const placed = plan.slices.flatMap((slice) => slice.placements.map(itemKeyOf)).sort();
  const reasons = [];
  if (JSON.stringify(expected) !== JSON.stringify(placed)) reasons.push("coverage");
  if (new Set(plan.slices.map((slice) => slice.tableKey)).size !== plan.slices.length)
    reasons.push("duplicateTable");
  let release = initialRelease(running, scene.now, params.unitOrigins.length * 6);
  let lifts = initialLifts(running);
  const members = tableMembers(running);
  for (const slice of plan.slices) {
    if (isStale(slice, pending)) reasons.push("staleOrSpan");
    if (
      !keepsAnchor(
        slice.placements,
        release,
        lifts,
        members.get(slice.tableKey) ?? null,
        pending,
        noodlePresets,
        params,
      )
    )
      reasons.push("anchor");
    if (!withinLiftCap(lifts, liftsOf(slice.placements), params)) reasons.push("lift");
    const advanced = feasibleRelease(slice.placements, release, pending, noodlePresets);
    if (advanced === null) reasons.push("occupancyOrDuration");
    else release = advanced;
    lifts = advanceLifts(lifts, liftsOf(slice.placements));
  }
  return [...new Set(reasons)];
}

function decode(scene: Scene, model: Model, sample: Sample): CookSchedule {
  assert.equal(sample.solution.length, model.modelVariables);
  assert(sample.solution.every(Number.isSafeInteger));
  const placements = scene.request.pending.map((item, i) => {
    const previous = scene.baseline.slices
      .flatMap((slice) => slice.placements)
      .find((placement) => itemKeyOf(item) === itemKeyOf(placement));
    assert(previous);
    const start = sample.solution[model.startVariables[i]!];
    const end = sample.solution[model.endVariables[i]!];
    assert(start !== undefined && end !== undefined);
    const choices = model.slotVariables[i]!.map((v) => sample.solution[v]);
    assert(choices.every((choice) => choice === 0 || choice === 1));
    const slotIds = choices.flatMap((choice, slot) => (choice === 1 ? [String(slot)] : []));
    if (previous.anchor !== null) {
      assert.equal(scene.now + start, previous.startAt);
      assert.deepEqual(
        slotIds,
        [...previous.slotIds].sort((a, b) => Number(a) - Number(b)),
      );
    }
    return {
      externalOrderId: item.externalOrderId,
      itemIndex: item.itemIndex,
      slotIds,
      startAt: scene.now + start,
      serveAt: scene.now + end,
      anchor: previous.anchor,
    };
  });
  assert.equal(
    placements.reduce((sum, p) => sum + p.serveAt - scene.now, 0),
    sample.objective,
  );
  assert(sample.bestBound <= sample.objective! + 1e-6);
  assert.equal(scene.baseline.slices.length, 1);
  const plan = toCookSchedule({
    slices: [{ tableKey: scene.baseline.slices[0]!.tableKey, placements }],
  });
  assert(plan);
  return plan;
}
function signature(sample: Sample): string {
  return JSON.stringify([
    sample.status,
    sample.objective,
    sample.bestBound,
    sample.solution,
    sample.branches,
    sample.conflicts,
  ]);
}
const rows: {
  scene: string;
  environment: string;
  repeat: number;
  status: string;
  reasons: string[];
  accepted: boolean;
  scoreDelta: number | null;
}[] = [];
const signatures = new Map<string, string>();
const parityMismatches: { scene: string; environment: string; repeat: number }[] = [];
let negativeControls = 0;
let liftNegativeControls = 0;
for (const scene of source.scenes) {
  assert.deepEqual(checkPlan(scene, scene.baseline), [], `Baseline ${scene.id}`);
  const slice = scene.baseline.slices[0]!;
  const first = slice.placements[0]!;
  // Verify independent checks actually reject missing/duplicate items, wrong duration,
  // non-existing slots, past starts, false anchor claims and physical overlap.
  const variants: unknown[] = [
    { slices: [] },
    { slices: [{ ...slice, placements: [...slice.placements, first] }] },
    {
      slices: [
        {
          ...slice,
          placements: [{ ...first, serveAt: first.serveAt + 1 }, ...slice.placements.slice(1)],
        },
      ],
    },
    {
      slices: [
        { ...slice, placements: [{ ...first, slotIds: ["999"] }, ...slice.placements.slice(1)] },
      ],
    },
    {
      slices: [
        {
          ...slice,
          placements: [{ ...first, startAt: scene.now - 1 }, ...slice.placements.slice(1)],
        },
      ],
    },
    { slices: [{ ...slice, placements: [{ ...first, anchor: 0 }, ...slice.placements.slice(1)] }] },
  ];
  if (slice.placements.length > 1) {
    const second = slice.placements[1]!;
    variants.push({
      slices: [
        {
          ...slice,
          placements: [
            first,
            {
              ...second,
              slotIds: [first.slotIds[0], ...second.slotIds.slice(1)],
              startAt: first.startAt,
              serveAt: first.startAt + second.serveAt - second.startAt,
            },
            ...slice.placements.slice(2),
          ],
        },
      ],
    });
  }
  for (const variant of variants) {
    assert(checkPlan(scene, variant).length > 0);
    negativeControls++;
  }
  if (
    slice.placements.reduce((sum, p) => sum + p.slotIds.length, 0) >
    scene.request.params.arms + 2
  ) {
    const end = Math.max(...slice.placements.map((p) => p.serveAt));
    const variant = {
      slices: [
        {
          ...slice,
          placements: slice.placements.map((p) => ({
            ...p,
            startAt: end - (p.serveAt - p.startAt),
            serveAt: end,
          })),
        },
      ],
    };
    assert(checkPlan(scene, variant).includes("lift"));
    negativeControls++;
    liftNegativeControls++;
  }
}
function checkSample(model: Model, sample: Sample, environment: string, repeat: number): void {
  const scene = scenes.get(model.id);
  assert(scene);
  const key = `${environment}/${model.id}`;
  const previous = signatures.get(key);
  if (previous !== undefined && previous !== signature(sample))
    parityMismatches.push({ scene: model.id, environment: `${environment}-repeat`, repeat });
  signatures.set(key, signature(sample));
  if (environment !== "native" && signature(sample) !== signature(model.samples[0]!))
    parityMismatches.push({ scene: model.id, environment: `${environment}-native`, repeat });
  let reasons: string[];
  let accepted = false;
  let scoreDelta: number | null = null;
  if (sample.status !== "FEASIBLE" && sample.status !== "OPTIMAL") {
    assert.equal(sample.solution.length, 0);
    assert.equal(sample.objective, null);
    reasons = [sample.status === "UNKNOWN" ? "noIncumbent" : sample.status];
  } else {
    const plan = decode(scene, model, sample);
    reasons = checkPlan(scene, plan);
    const { pending, running, shownPlan, noodlePresets, params } = scene.request;
    const context = {
      members: tableMembers(running),
      lifts: initialLifts(running),
      change: { shown: shownPlan, running, now: scene.now, pending, presets: noodlePresets },
    };
    scoreDelta =
      scoreSchedule(plan.slices, pending, context, params).total -
      scoreSchedule(scene.baseline.slices, pending, context, params).total;
    accepted =
      admit(plan, scene.baseline, pending, running, shownPlan, scene.now, noodlePresets, params)
        .length > 0;
    assert(!accepted || reasons.length === 0);
  }
  rows.push({
    scene: model.id,
    environment,
    repeat,
    status: sample.status,
    reasons,
    accepted,
    scoreDelta,
  });
}
for (const model of native.scenes) {
  assert.equal(model.samples.length, native.repeat);
  model.samples.forEach((sample, repeat) => checkSample(model, sample, "native", repeat));
}
if (workerPath) {
  const worker = JSON.parse(readFileSync(workerPath, "utf8")) as {
    nativeSha256: string;
    requests: { id: string; clock: string; repeat: number; body: { samples: Sample[] } }[];
  };
  assert.equal(worker.nativeSha256, hash(nativeBytes));
  const models = new Map(native.scenes.map((model) => [model.id, model]));
  const seen = new Set<string>();
  for (const request of worker.requests) {
    assert(request.clock === "host" || request.clock === "frozen");
    assert(
      Number.isInteger(request.repeat) && request.repeat >= 0 && request.repeat < native.repeat,
    );
    const key = `${request.id}/${request.clock}/${request.repeat}`;
    assert(!seen.has(key));
    seen.add(key);
    const model = models.get(request.id);
    assert(model && request.body.samples.length === 1);
    checkSample(model, request.body.samples[0]!, request.clock, request.repeat);
  }
  assert.equal(worker.requests.length, native.scenes.length * native.repeat * 2);
}
const environments = [...new Set(rows.map((row) => row.environment))].map((environment) => {
  const group = rows.filter((row) => row.environment === environment);
  return {
    environment,
    solves: group.length,
    valid: group.filter((row) => !row.reasons.length).length,
    accepted: group.filter((row) => row.accepted).length,
    statuses: Object.fromEntries(
      [...new Set(group.map((row) => row.status))].map((status) => [
        status,
        group.filter((row) => row.status === status).length,
      ]),
    ),
    failures: group.filter((row) => row.reasons.length),
  };
});
const report = {
  sceneSha256: hash(sceneBytes),
  nativeSha256: hash(nativeBytes),
  seed: source.seed,
  budget: native.budget,
  scenes: native.scenes.length,
  negativeControls,
  liftNegativeControls,
  parityMismatches,
  environments,
  coverage: {
    pendingMin: Math.min(...source.scenes.map((scene) => scene.request.pending.length)),
    pendingMax: Math.max(...source.scenes.map((scene) => scene.request.pending.length)),
    runningScenes: source.scenes.filter((scene) => scene.request.running.length > 0).length,
    runningMax: Math.max(...source.scenes.map((scene) => scene.request.running.length)),
    anchoredScenes: native.scenes.filter((model) => model.pinnedAnchors > 0).length,
    freeItems: native.scenes.reduce((sum, model) => sum + model.freeItems, 0),
    pinnedItems: native.scenes.reduce((sum, model) => sum + model.pinnedAnchors, 0),
  },
  rows,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify({
    ...report,
    rows: undefined,
    environments: environments.map((entry) => ({
      ...entry,
      failures: entry.failures.filter((row) => row.repeat === 0),
    })),
  }),
);
