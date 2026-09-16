import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { toNoodleSpec } from "../../../src/ingress/noodle-spec";
import { toUniqueKey } from "../../../src/ingress/unique-key";
import { composeEffectiveConfig } from "../../../src/registry/compose";
import { validateProvisioningInput } from "../../../src/registry/validate";
import type { Policy, StoreOverride } from "../../../src/registry/ideal";
import { position } from "../../../src/domain/store";
import { replayOrderHistory } from "./schedule";
import defaults from "./defaults.json";

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
const local = resolve("experiments/cpsat-workers/fixtures/local");
const policyBytes = readFileSync(resolve(local, "pos-menu-policy.json"));
const adminBytes = readFileSync(resolve(local, "admin-settings.json"));
const rawPolicy = object(JSON.parse(policyBytes.toString()));
assert(validateProvisioningInput({ target: "policyFields", raw: rawPolicy.fields }).accepted);
const policy: Policy = {
  policyId: "pos-menu",
  chainId: String(rawPolicy.chainId),
  name: String(rawPolicy.name),
  priority: Number(rawPolicy.priority),
  fields: rawPolicy.fields as Policy["fields"],
};
const admin = object(JSON.parse(adminBytes.toString()));
assert(Array.isArray(admin.stores));
const stores = admin.stores.map(object);
const source = resolve(process.argv[2] ?? "docs/data_samples/kenbaiki_orders");
const manifestPath = resolve(source, "manifest.json");
const manifestBytes = existsSync(manifestPath) ? readFileSync(manifestPath) : undefined;
const manifest = manifestBytes ? object(JSON.parse(manifestBytes.toString())) : undefined;
const metadata = manifest
  ? (assert(Array.isArray(manifest.histories)), manifest.histories.map(object))
  : [];
const jst = (value: unknown) => {
  assert(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value));
  const seconds = Date.parse(`${value}+09:00`) / 1000;
  assert(Number.isSafeInteger(seconds));
  return seconds;
};
const histories = readdirSync(source)
  .filter((file) => file.endsWith(".jsonl"))
  .sort()
  .map((file) => {
    const bytes = readFileSync(resolve(source, file));
    const meta = metadata.find((entry) => entry.file === file);
    if (manifest) {
      assert(meta, `File absent from manifest: ${file}`);
      assert.equal(hash(bytes), meta.sha256, `Source hash: ${file}`);
      assert(["exploration", "validation"].includes(String(meta.split)));
    }
    const records = bytes
      .toString()
      .trim()
      .split(/\r?\n/)
      .map((line) => object(JSON.parse(line)));
    const code = String(object(records[0]!.payload).store_id);
    if (meta) {
      assert.equal(code, meta.store_id);
      assert.equal(records.length, meta.line_count);
      assert.equal(records.length, object(meta.counts).orders_total_window);
      assert.equal(meta.shop_code, String(Number(code) + 1000));
      assert.equal(meta.warmup_start, meta.extract_start);
      assert.equal(meta.warmup_end, meta.eval_start);
      assert.equal(meta.eval_end, meta.tail_start);
      assert.equal(meta.tail_end, meta.extract_end);
      assert.equal(jst(meta.eval_start) - jst(meta.extract_start), 1800);
      assert.equal(jst(meta.eval_end) - jst(meta.eval_start), 3600);
      assert.equal(jst(meta.extract_end) - jst(meta.eval_end), 1800);
    }
    const adminStore = stores.find((store) => store.storeCode === String(Number(code) + 1000));
    assert(adminStore && JSON.stringify(adminStore.policyIds) === '["pos-menu"]');
    assert(
      validateProvisioningInput({ target: "storeOverride", raw: adminStore.override }).accepted,
    );
    const config = composeEffectiveConfig([policy], adminStore.override as StoreOverride);
    let parentItems = 0;
    const orderKeys = new Set<string>();
    const items = records.flatMap((record) => {
      assert(record.path === "/lio/order");
      const payload = object(record.payload);
      assert(payload.canceled === false && String(payload.store_id) === code);
      assert(
        typeof payload.datetime === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(payload.datetime),
      );
      const purchasedAt = jst(payload.datetime);
      if (meta)
        assert(purchasedAt >= jst(meta.extract_start) && purchasedAt < jst(meta.extract_end));
      const order = toUniqueKey(payload);
      assert(order && Array.isArray(payload.order_items));
      assert(!orderKeys.has(order), "Replay does not support duplicate or modified orders");
      orderKeys.add(order);
      return payload.order_items.flatMap((value: unknown, index: number) => {
        parentItems++;
        const item = object(value);
        assert(item.qty === 1 && Array.isArray(item.child_items));
        const spec = toNoodleSpec(item, config);
        if (!spec) {
          assert(item.child_items.length === 0);
          return [];
        }
        const preset = config.noodlePresets.find((v) => v.noodleType === spec.noodleType);
        assert(preset);
        return [
          {
            id: `${order}/${index}`,
            order,
            purchasedAt,
            boilSeconds: preset.boilSeconds[spec.firmness],
            slotSpan: spec.slotSpan,
          },
        ];
      });
    });
    assert(items.length > 0);
    if (meta) assert.equal(parentItems, object(meta.counts).parent_items_total);
    const origin = meta ? jst(meta.extract_start) : Math.min(...items.map((j) => j.purchasedAt));
    const evaluationWindow = meta
      ? { start: jst(meta.eval_start) - origin, end: jst(meta.eval_end) - origin }
      : undefined;
    return {
      id: meta ? String(meta.history_id) : code,
      ...(evaluationWindow ? { evaluationWindow } : {}),
      items: items.map((j) => ({ ...j, purchasedAt: j.purchasedAt - origin })),
      coordinates: Array.from({ length: config.unitCount * 6 }, (_, s) =>
        position(s, config.unitOrigins, config.slotOffsets),
      ),
      arms: config.arms,
      liftWindow: config.liftIntervalSeconds,
      tolerancePercent: config.toleranceRatio,
      audit: {
        storeCode: code,
        split: meta?.split ?? null,
        loadClass: meta?.load_class ?? null,
        evaluationWindow: evaluationWindow ?? null,
        sourceSha256: hash(bytes),
        orders: records.length,
        parentItems,
        boilableItems: items.length,
        origin,
      },
    };
  });
assert.equal(new Set(histories.map((h) => h.id)).size, histories.length);
if (manifest) {
  assert.equal(histories.length, metadata.length);
  for (const a of metadata)
    for (const b of metadata) {
      if (a === b || a.store_id !== b.store_id) continue;
      assert.equal(a.split, b.split, "Store leaks between exploration and validation");
      assert(
        jst(a.extract_end) <= jst(b.extract_start) || jst(b.extract_end) <= jst(a.extract_start),
        "Overlapping histories",
      );
    }
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[
  Symbol.asyncIterator
]();
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
send({
  kind: "ready",
  defaults,
  stores: histories.map((h) => ({ id: h.id, ...h.audit })),
  policySha256: hash(policyBytes),
  adminSha256: hash(adminBytes),
  manifestSha256: manifestBytes ? hash(manifestBytes) : null,
  inputVersion: manifest ? "smac-replay-cohort-v2" : "smac-replay-v1",
});
while (true) {
  const line = await lines.next();
  if (line.done) break;
  const request = JSON.parse(line.value);
  if (request.kind === "stop") break;
  assert(request.kind === "replay");
  const history = histories.find((h) => h.id === request.store);
  assert(history);
  try {
    const result = await replayOrderHistory(
      history,
      request.preferences ?? defaults,
      async (model) => {
        send({ kind: "solve", model });
        const reply = await lines.next();
        assert(!reply.done, "Solver transport closed");
        const response = JSON.parse(reply.value);
        assert(!response.error, response.error);
        return response;
      },
      { pendingLimit: request.pendingLimit ?? 6 },
    );
    send({ kind: "result", result });
  } catch (error) {
    send({ kind: "error", error: error instanceof Error ? error.stack : String(error) });
  }
}
