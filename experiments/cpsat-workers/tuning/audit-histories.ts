import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { toNoodleSpec } from "../../../src/ingress/noodle-spec";
import { toUniqueKey } from "../../../src/ingress/unique-key";
import { composeEffectiveConfig } from "../../../src/registry/compose";
import type { Policy, StoreOverride } from "../../../src/registry/ideal";

const directory = resolve(process.argv[2] ?? "docs/data_samples/noodle_plan_histories");
const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
const policy: Policy = JSON.parse(
  readFileSync("experiments/cpsat-workers/fixtures/local/pos-menu-policy.json", "utf8"),
);
const admin = JSON.parse(
  readFileSync("experiments/cpsat-workers/fixtures/local/admin-settings.json", "utf8"),
);
const jst = (value: string) => Date.parse(`${value}+09:00`) / 1000;
const ids = new Set<string>();
const storeSplit = new Map<string, string>();
const unknown = new Map<number, { count: number; children: Set<number> }>();
const bySize = new Map<
  number,
  { count: number; span: number; noodle: string; boil: Set<number> }
>();
const rows = [];
for (const h of manifest.histories) {
  assert(!ids.has(h.history_id));
  ids.add(h.history_id);
  assert(/^[0-9_]+\.jsonl$/.test(h.file));
  const bytes = readFileSync(resolve(directory, h.file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), h.sha256, `Hash: ${h.history_id}`);
  const records = bytes
    .toString()
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(records.length, h.line_count);
  assert.equal(records.length, h.counts.orders_total_window);
  assert(["exploration", "validation"].includes(h.split));
  if (storeSplit.has(h.store_id)) assert.equal(storeSplit.get(h.store_id), h.split);
  storeSplit.set(h.store_id, h.split);
  const bounds = [
    h.extract_start,
    h.warmup_end,
    h.eval_start,
    h.eval_end,
    h.tail_start,
    h.extract_end,
  ].map(jst);
  assert(bounds.every(Number.isSafeInteger));
  assert.equal(bounds[1], bounds[2]);
  assert.equal(bounds[3], bounds[4]);
  assert.equal(bounds[5]! - bounds[0]!, 7200);
  assert.equal(bounds[2]! - bounds[0]!, 1800);
  assert.equal(bounds[3]! - bounds[2]!, 3600);
  const settings = admin.stores.find((s: { storeCode: string }) => s.storeCode === h.shop_code);
  assert(settings && Number(h.shop_code) === Number(h.store_id) + 1000);
  const config = composeEffectiveConfig([policy], settings.override as StoreOverride);
  const keys = new Set<string>();
  let parentItems = 0,
    mapped = 0,
    span2 = 0,
    unknownItems = 0,
    evalBowls = 0;
  for (const r of records) {
    assert.equal(r.path, "/lio/order");
    const p = r.payload;
    assert.equal(String(p.store_id), h.store_id);
    assert.equal(p.canceled, false, "Cancellation requires explicit replay support");
    assert(!("customer_id" in p));
    assert(!p.free_remark && p.cooking_instructions.length === 0 && p.coupons.length === 0);
    const at = jst(p.datetime);
    assert(at >= bounds[0]! && at < bounds[5]!);
    const key = toUniqueKey(p);
    assert(key && !keys.has(key));
    keys.add(key);
    for (const item of p.order_items) {
      parentItems++;
      assert.equal(item.qty, 1);
      const spec = toNoodleSpec(item, config);
      if (!spec) {
        if (item.child_items.length) {
          unknownItems++;
          const value = unknown.get(item.plu_no) ?? { count: 0, children: new Set<number>() };
          value.count++;
          for (const child of item.child_items) value.children.add(child.plu_no);
          unknown.set(item.plu_no, value);
        }
        continue;
      }
      mapped++;
      if (spec.slotSpan === 2) span2++;
      if (at >= bounds[2]! && at < bounds[3]!) evalBowls++;
      const preset = config.noodlePresets.find((v) => v.noodleType === spec.noodleType);
      assert(preset);
      const menu = config.menuItems.find((v) => v.productCode === item.plu_no);
      assert(menu);
      for (const child of item.child_items) {
        if (!menu.sizes.some((s) => s.code === child.plu_no)) continue;
        const value = bySize.get(child.plu_no) ?? {
          count: 0,
          span: spec.slotSpan,
          noodle: spec.noodleType,
          boil: new Set<number>(),
        };
        value.count++;
        value.boil.add(preset.boilSeconds[spec.firmness]);
        bySize.set(child.plu_no, value);
      }
    }
  }
  assert.equal(parentItems, h.counts.parent_items_total);
  rows.push({
    id: h.history_id,
    split: h.split,
    orders: records.length,
    parentItems,
    mapped,
    evalBowls,
    span2,
    unknownItems,
    snowflakeMapped: h.counts.noodle_bowls_total,
    snowflakeSpan2: h.counts.slot_occupancy2_items,
    settingsSlots: config.unitCount * 6,
    referenceSlots: h.noodle_slots,
    boilSeconds: config.noodlePresets.map((v) => ({ type: v.noodleType, seconds: v.boilSeconds })),
  });
}
const report = {
  rows,
  totals: {
    histories: rows.length,
    orders: rows.reduce((s, r) => s + r.orders, 0),
    mapped: rows.reduce((s, r) => s + r.mapped, 0),
    unknown: rows.reduce((s, r) => s + r.unknownItems, 0),
    span2: rows.reduce((s, r) => s + r.span2, 0),
    evaluationBowls: rows.reduce((s, r) => s + r.evalBowls, 0),
    snowflakeMapped: rows.reduce((s, r) => s + r.snowflakeMapped, 0),
    snowflakeSpan2: rows.reduce((s, r) => s + r.snowflakeSpan2, 0),
  },
  unknownProducts: [...unknown].map(([code, v]) => ({
    code,
    count: v.count,
    children: [...v.children],
  })),
  sizeCodes: [...bySize].map(([code, v]) => ({
    code,
    count: v.count,
    span: v.span,
    noodle: v.noodle,
    boil: [...v.boil],
  })),
};
const output = process.argv.find((v) => v.startsWith("--output="))?.slice("--output=".length);
if (output)
  writeFileSync(resolve(output), JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
console.log(JSON.stringify(output ? report.totals : report, null, 2));
