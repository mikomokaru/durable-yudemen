// 調理状態の再現や solve は行わない。既存の純粋な POS 解釈を使う入力監査だけに留める。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { toFirmnessCode, toMenuItem } from "../../../src/domain/store";
import { toNoodleSpec } from "../../../src/ingress/noodle-spec";
import { toUniqueKey } from "../../../src/ingress/unique-key";
import { validateProvisioningInput } from "../../../src/registry/validate";

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Expected object");
  return value as Record<string, unknown>;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPolicy(path: string) {
  const bytes = readFileSync(path);
  const policy = record(JSON.parse(bytes.toString("utf8")));
  const fields = record(policy.fields);
  const verdict = validateProvisioningInput({ target: "policyFields", raw: fields });
  assert(verdict.accepted, "Invalid Policy fields");
  const menuItems = record(fields.menuItems).value;
  const firmnessCodes = record(fields.firmnessCodes).value;
  assert(Array.isArray(menuItems) && menuItems.length > 0, "Empty menuItems is not test coverage");
  assert(Array.isArray(firmnessCodes) && firmnessCodes.length > 0, "Missing firmnessCodes");
  return {
    sha256: sha256(bytes),
    lookup: {
      menuItems: menuItems.map((value: unknown) => {
        const item = toMenuItem(value);
        assert(item !== null);
        return item;
      }),
      firmnessCodes: firmnessCodes.map((value: unknown) => {
        const firmness = toFirmnessCode(value);
        assert(firmness !== null);
        return firmness;
      }),
    },
  };
}

const [inputDirectory, policyPath, ...extra] = process.argv.slice(2);
assert(
  inputDirectory && policyPath && extra.length === 0,
  "Usage: inspect-real-orders.ts INPUT_DIR POLICY_JSON",
);
const policy = readPolicy(resolve(policyPath));
const knownProducts = new Set(policy.lookup.menuItems.map((item) => item.productCode));
const allKeys = new Set<string>();
const files = readdirSync(inputDirectory)
  .filter((name) => name.endsWith(".jsonl"))
  .sort();
assert(files.length > 0, "No JSONL samples");

const sources = files.map((file) => {
  const bytes = readFileSync(resolve(inputDirectory, file));
  const lines = bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const stores = new Set<string>();
  const datetimes: string[] = [];
  const counts = {
    orders: 0,
    items: 0,
    canceled: 0,
    duplicateKeys: 0,
    quantityNotOne: 0,
    missingArrivalTimestamp: 0,
    missingSequenceNumber: 0,
    missingTimezone: 0,
    withChildren: 0,
    mapped: 0,
    unmappedWithChildren: 0,
    withoutChildren: 0,
    knownProductWithoutSize: 0,
  };
  const specifications = new Map<string, number>();
  const unmappedProducts = new Map<number, number>();

  for (const line of lines) {
    const envelope = record(JSON.parse(line));
    assert(envelope.path === "/lio/order", `${file}: unexpected path`);
    const payload = record(envelope.payload);
    const key = toUniqueKey(payload);
    assert(key !== null, `${file}: incomplete order identity`);
    if (allKeys.has(key)) counts.duplicateKeys++;
    allKeys.add(key);
    stores.add(String(payload.store_id));
    assert(typeof payload.datetime === "string", `${file}: non-string datetime`);
    // ホストの timezone で Date.parse しない。ここでは原文の時系列と offset の有無だけを見る。
    datetimes.push(payload.datetime);
    counts.missingTimezone += /(?:Z|[+-]\d{2}:\d{2})$/.test(payload.datetime) ? 0 : 1;
    counts.missingArrivalTimestamp += envelope.arrival_timestamp_ms === undefined ? 1 : 0;
    counts.missingSequenceNumber += envelope.sequence_number === undefined ? 1 : 0;
    assert(typeof payload.canceled === "boolean", `${file}: missing cancellation flag`);
    counts.canceled += payload.canceled ? 1 : 0;
    counts.orders++;
    assert(Array.isArray(payload.order_items), `${file}: missing order_items`);

    for (const rawItem of payload.order_items) {
      const item = record(rawItem);
      assert(
        typeof item.plu_no === "number" && Number.isSafeInteger(item.plu_no),
        `${file}: invalid product code`,
      );
      assert(Array.isArray(item.child_items), `${file}: missing child_items`);
      counts.items++;
      counts.quantityNotOne += item.qty === 1 ? 0 : 1;
      const hasChildren = item.child_items.length > 0;
      counts.withChildren += hasChildren ? 1 : 0;
      counts.withoutChildren += hasChildren ? 0 : 1;
      const spec = toNoodleSpec(item, policy.lookup);
      if (spec !== null) {
        counts.mapped++;
        const signature = `${spec.noodleType}/${spec.firmness}/${spec.slotSpan}`;
        specifications.set(signature, (specifications.get(signature) ?? 0) + 1);
      } else {
        if (knownProducts.has(item.plu_no)) counts.knownProductWithoutSize++;
        if (hasChildren) {
          counts.unmappedWithChildren++;
          unmappedProducts.set(item.plu_no, (unmappedProducts.get(item.plu_no) ?? 0) + 1);
        }
      }
    }
  }
  assert(stores.size === 1 && counts.orders > 0, `${file}: expected one nonempty store window`);
  return {
    file,
    sha256: sha256(bytes),
    storeCode: [...stores][0],
    firstDatetime: datetimes[0],
    lastDatetime: datetimes.at(-1),
    orderedByDeclaredDatetime: datetimes.every(
      (value, index) => index === 0 || datetimes[index - 1]! <= value,
    ),
    counts,
    specifications: Object.fromEntries([...specifications].sort()),
    unmappedProductsWithChildren: Object.fromEntries(
      [...unmappedProducts].sort((a, b) => a[0] - b[0]),
    ),
  };
});

const totals = Object.fromEntries(
  Object.keys(sources[0]!.counts).map((key) => [
    key,
    sources.reduce((sum, source) => sum + source.counts[key as keyof typeof source.counts], 0),
  ]),
);
console.log(
  JSON.stringify(
    {
      purpose: "input-audit-only; not a planning or solver result",
      policy: {
        sha256: policy.sha256,
        menuItems: policy.lookup.menuItems.length,
        firmnessCodes: policy.lookup.firmnessCodes.length,
      },
      totals,
      sources,
    },
    null,
    2,
  ),
);
