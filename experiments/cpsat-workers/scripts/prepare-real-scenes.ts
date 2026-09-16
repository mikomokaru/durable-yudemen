import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { toNoodleSpec } from "../../../src/ingress/noodle-spec";
import { toUniqueKey } from "../../../src/ingress/unique-key";
import { readDeclaredText } from "../../../src/ingress/declared-text";
import { composeEffectiveConfig } from "../../../src/registry/compose";
import { validateProvisioningInput } from "../../../src/registry/validate";
import type { Policy, StoreOverride } from "../../../src/registry/ideal";
import { pendingOrders, toOrderItems } from "../../../src/domain/order";
import { occupiedSlotsOf } from "../../../src/domain/store";
import { decide } from "../../../src/engine/decide";
import type { Event } from "../../../src/engine/event";
import { EMPTY_STATE, type TimerState } from "../../../src/engine/state";
import { committedSchedule } from "../../../src/engine/commit";
import { adjustedEndTime, tableMembers } from "../../../src/engine/project";
import { initialLifts, withinLiftCap, liftsOf, advanceLifts } from "../../../src/engine/lift";
import {
  initialRelease,
  feasibleRelease,
  isStale,
  keepsAnchor,
  placeableTargets,
} from "../../../src/engine/schedule";
import { digestInput } from "../../../src/engine/digest";
import type { EpochMillis, TimerId } from "../../../src/engine/types";

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
const directory = resolve("experiments/cpsat-workers/fixtures/local");
const seed = process.argv[2] ?? "real-orders-20260908-v1";
const perStore = Number(process.argv[3] ?? "10");
assert(Number.isInteger(perStore) && perStore > 0 && perStore <= 100);
const policyBytes = readFileSync(resolve(directory, "pos-menu-policy.json"));
const policyRaw = object(JSON.parse(policyBytes.toString("utf8")));
assert(validateProvisioningInput({ target: "policyFields", raw: policyRaw.fields }).accepted);
assert(
  typeof policyRaw.chainId === "string" &&
    typeof policyRaw.name === "string" &&
    typeof policyRaw.priority === "number",
);
const policy: Policy = {
  policyId: "pos-menu",
  chainId: policyRaw.chainId,
  name: policyRaw.name,
  priority: policyRaw.priority,
  fields: policyRaw.fields as Policy["fields"],
};
const adminBytes = readFileSync(resolve(directory, "admin-settings.json"));
const admin = object(JSON.parse(adminBytes.toString("utf8")));
assert(Array.isArray(admin.stores));
const stores = admin.stores.map(object);
const inputDirectory = resolve("docs/data_samples/kenbaiki_orders");
const sources = readdirSync(inputDirectory)
  .filter((file) => file.endsWith(".jsonl"))
  .sort();
const reports = [];
const selected = [];

for (const file of sources) {
  const bytes = readFileSync(resolve(inputDirectory, file));
  const raw = bytes
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => object(JSON.parse(line)));
  const sampleStoreCode = String(object(raw[0]!.payload).store_id);
  const adminCode = String(Number(sampleStoreCode) + 1000); // User-confirmed mapping for this corpus only.
  const store = stores.find((entry) => entry.storeCode === adminCode);
  assert(store && JSON.stringify(store.policyIds) === '["pos-menu"]');
  assert(validateProvisioningInput({ target: "storeOverride", raw: store.override }).accepted);
  const params = composeEffectiveConfig([policy], store.override as StoreOverride);
  const arrivals = raw.map((envelope, line) => {
    assert(envelope.path === "/lio/order");
    const payload = object(envelope.payload);
    assert(String(payload.store_id) === sampleStoreCode && payload.canceled === false);
    assert(
      typeof payload.datetime === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(payload.datetime),
    );
    const now = Date.parse(`${payload.datetime}+09:00`) as EpochMillis;
    assert(Number.isSafeInteger(now));
    const externalOrderId = toUniqueKey(payload);
    assert(externalOrderId !== null && Array.isArray(payload.order_items));
    const table = readDeclaredText(payload.table_no);
    const items = payload.order_items.flatMap((value: unknown, itemIndex: number) => {
      const item = object(value);
      assert(item.qty === 1 && Array.isArray(item.child_items));
      const spec = toNoodleSpec(item, params);
      if (spec === null) {
        assert(item.child_items.length === 0, "Unmapped item with children; do not silently drop");
        return [];
      }
      assert(params.noodlePresets.some((preset) => preset.noodleType === spec.noodleType));
      return [
        {
          externalOrderId,
          itemIndex,
          ...spec,
          tableId: table === "0" ? null : table,
          arrivalTime: now,
          itemName: typeof item.item_name === "string" ? item.item_name : null,
          completedAt: null,
          interruptedAt: null,
        },
      ];
    });
    const checked = items.length > 0 ? toOrderItems(items, params.noodlePresets, now) : [];
    assert(checked !== null);
    return { line: line + 1, now, items: checked };
  });
  assert(arrivals.every((entry, i) => i === 0 || arrivals[i - 1]!.now <= entry.now));
  let state: TimerState = EMPTY_STATE;
  let arrivalIndex = 0;
  let eventIndex = 0;
  let nextStart = 0;
  let eligibleScenes = 0;
  const sampled: { rank: string; scene: unknown }[] = [];
  const apply = (event: Event) => {
    const outcome = decide(state, event, params);
    assert(outcome.ok, `Engine rejected ${event.type}`);
    state = outcome.state;
    eventIndex++;
    // Persist/Broadcast/RequestPlan are descriptions only. No interpreter or DO is invoked.
  };
  const first = arrivals[0]!.now;
  const last = arrivals.at(-1)!.now;
  let stoppedAt = first;
  for (let tick: number = first; tick <= last + 7_200_000; tick += 1000) {
    const now = tick as EpochMillis;
    stoppedAt = now;
    let changed = false;
    while (arrivalIndex < arrivals.length && arrivals[arrivalIndex]!.now <= now) {
      const arrival = arrivals[arrivalIndex++]!;
      if (arrival.items.length > 0) {
        assert(arrival.items[0] !== undefined);
        apply({
          type: "OrderArrived",
          arrival: [arrival.items[0], ...arrival.items.slice(1)],
          now,
        });
      }
      changed = true;
    }
    if (state.timers.some((timer) => adjustedEndTime(timer) <= now)) {
      apply({ type: "AlarmFired", now });
      for (const timer of state.timers) {
        if (adjustedEndTime(timer) <= now) apply({ type: "Complete", timerId: timer.id, now });
      }
      changed = true;
    }
    const pending = pendingOrders(state.orderItems, state.timers, now);
    if (pending.length === 0 && state.timers.length === 0 && arrivalIndex === arrivals.length)
      break;
    if (pending.length === 0) continue;
    const change = {
      shown: state.shownPlan,
      running: state.timers,
      now,
      pending,
      presets: params.noodlePresets,
    };
    const baseline = committedSchedule(
      [],
      pending,
      state.timers,
      now,
      params.noodlePresets,
      params,
      change,
    );
    const targets = placeableTargets(pending, now, params.noodlePresets, params);
    let release = initialRelease(state.timers, now, params.unitCount * 6);
    let lifts = initialLifts(state.timers);
    const members = tableMembers(state.timers);
    for (const slice of baseline.slices) {
      assert(!isStale(slice, targets), "Baseline coverage failed");
      assert(
        keepsAnchor(
          slice.placements,
          release,
          lifts,
          members.get(slice.tableKey) ?? null,
          targets,
          params.noodlePresets,
          params,
        ),
        "Baseline anchor failed",
      );
      assert(withinLiftCap(lifts, liftsOf(slice.placements), params), "Baseline lift cap failed");
      const advanced = feasibleRelease(slice.placements, release, targets, params.noodlePresets);
      assert(advanced !== null, "Baseline occupancy failed");
      release = advanced;
      lifts = advanceLifts(lifts, liftsOf(slice.placements));
    }
    const rank = hash(`${seed}/${sampleStoreCode}/${now}/${eventIndex}`);
    // Stratified hash sampling: 10 independently ranked scenes per store by default.
    if (changed || parseInt(rank.slice(0, 4), 16) % 17 === 0) {
      eligibleScenes++;
      const scene = {
        id: `${sampleStoreCode}-${now}-${eventIndex}`,
        sampleStoreCode,
        now,
        eventIndex,
        sourceFile: file,
        sourceSha256: hash(bytes),
        arrivalIndex,
        request: {
          storeId: `fixture-${sampleStoreCode}`,
          pending: targets,
          running: state.timers,
          params,
          noodlePresets: params.noodlePresets,
          digest: digestInput(state.orderItems, state.timers, params, now),
          shownPlan: state.shownPlan,
        },
        baseline,
      };
      sampled.push({ rank, scene });
      sampled.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
      if (sampled.length > perStore) sampled.pop();
    }
    const occupied = occupiedSlotsOf(state.timers);
    const due = baseline.slices
      .flatMap((slice) => slice.placements)
      .filter(
        (placement) =>
          placement.startAt <= now &&
          placement.slotIds.every((slot) => !occupied.has(Number(slot))),
      )
      .sort((a, b) => a.startAt - b.startAt || Number(a.slotIds[0]) - Number(b.slotIds[0]))[0];
    if (due && now >= nextStart) {
      apply({
        type: "StartOrderItem",
        slotIds: due.slotIds,
        externalOrderId: due.externalOrderId,
        itemIndex: due.itemIndex,
        newTimerId: `sim-${sampleStoreCode}-${eventIndex}` as TimerId,
        now,
      });
      nextStart = now + (1 + (parseInt(rank.slice(4, 8), 16) % 6)) * 1000;
    }
  }
  const expectedItems = arrivals.reduce((sum, entry) => sum + entry.items.length, 0);
  assert(
    state.timers.length === 0 &&
      state.orderItems.length === expectedItems &&
      state.orderItems.every((item) => item.completedAt !== null),
    "Simulation did not finish every item",
  );
  assert(sampled.length === perStore);
  reports.push({
    file,
    sha256: hash(bytes),
    sampleStoreCode,
    adminCode,
    orders: arrivals.length,
    items: expectedItems,
    completed: state.orderItems.length,
    eligibleScenes,
    eventIndex,
    stoppedAt,
  });
  selected.push(...sampled);
}
selected.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
const report = {
  seed,
  perStore,
  assumptions: {
    storeCodeOffset: 1000,
    timezone: "+09:00",
    startEmpty: true,
    policySource: "user-approved local file; live equality unverified",
    adminSettings: "current, not historical",
    staff:
      "one start every seeded 1..6 seconds; complete at first one-second tick after adjusted end",
    actualHistoricalState: false,
    cpSatFeedbackIntoSimulation: false,
  },
  policySha256: hash(policyBytes),
  adminSha256: hash(adminBytes),
  stores: reports,
  scenes: selected.map((entry) => entry.scene),
};
const output = resolve(directory, "real-scenes.json");
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, seed, scenes: selected.length, stores: reports }));
