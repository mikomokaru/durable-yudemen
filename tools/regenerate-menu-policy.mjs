#!/usr/bin/env node
// tools/regenerate-menu-policy.mjs — POS 対応表の `slotSpan` を**正本から導き直す**（2026-09-14）。
//
//   node tools/regenerate-menu-policy.mjs [--write]
//
// **`slotSpan` は導出値である。** 事実は麺の玉数（正本 `noodle_reference.csv` の `NOODLE_SIZE`）で、
// 釜数はそこから厨房の規則で決まる——**2 玉以上は釜 2 つ、それ未満は 1 つ**。正本 490 行すべてで
// この規則が成り立ち（例外 0・10 店舗すべて同じ）、`SLOT_OCCUPANCY` 列はその導出結果である。
//
// **人が値を入れる形だったので間違えられた。** 実測（2026-09-14）で、1.5 玉（中盛）の 9 コードが
// すべて `slotSpan: 2` になっていた——正本では 1 である。中盛は実データの麺量の約 2 割を占めるので、
// **5 杯に 1 杯が本来の倍の釜を占めていた**ことになる。`slotSpan` は上げ窓でも「2 本分」として
// 数えられる（`lift-group-planning` AC 11）ため、手が実際より早く足りなくなる側にも効く。
//
// **これは応急処置である。** 本筋は設定が玉数（`portions`）を持ち、アプリが `slotSpan` を導くこと
// ——そうすれば対応表を手で編集しても釜数は間違えられない。ただし `StoreConfig` の型と投影の
// 移行を伴うので別に計画する。本ツールは「正本から生成する」ことで同じ誤りの再発を防ぐ。
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = resolve(root, "docs/data_samples/noodle_plan_histories/noodle_reference.csv");
const POLICY = resolve(root, "experiments/cpsat-workers/fixtures/local/pos-menu-policy.json");

/** 厨房の規則。**2 玉以上は釜 2 つ。** 正本 490 行に例外は無い。 */
const slotSpanOf = (portions) => (portions >= 2 ? 2 : 1);

const csv = await readFile(MASTER, "utf8");
const [header, ...lines] = csv.trim().split("\n");
const columns = header.split(",");
/** コード → 玉数。正本は店舗ごとに行を持つが、同じコードの玉数は全店で一致する（検算する）。 */
const portionsOf = new Map();
const conflicts = [];
for (const line of lines) {
  const row = Object.fromEntries(line.split(",").map((value, index) => [columns[index], value]));
  const code = Number(row.ITEM_CODE);
  const portions = Number(row.NOODLE_SIZE);
  const known = portionsOf.get(code);
  if (known !== undefined && known !== portions) conflicts.push({ code, known, portions });
  portionsOf.set(code, portions);
  // 正本の `SLOT_OCCUPANCY` が規則と食い違えば、規則のほうが疑わしい。黙って上書きしない。
  if (Number(row.SLOT_OCCUPANCY) !== slotSpanOf(portions))
    conflicts.push({ code, portions, occupancy: Number(row.SLOT_OCCUPANCY) });
}
if (conflicts.length > 0) {
  console.error("正本が規則と食い違う（生成を中止）:", conflicts.slice(0, 5));
  process.exit(1);
}

const policy = JSON.parse(await readFile(POLICY, "utf8"));
const changed = [];
const unknown = [];
for (const item of policy.fields.menuItems.value)
  for (const size of item.sizes) {
    const portions = portionsOf.get(Number(size.code));
    if (portions === undefined) {
      unknown.push({ productCode: item.productCode, code: size.code });
      continue;
    }
    const correct = slotSpanOf(portions);
    if (size.slotSpan !== correct) {
      changed.push({ code: size.code, portions, from: size.slotSpan, to: correct });
      size.slotSpan = correct;
    }
  }

const byCode = new Map();
for (const row of changed) byCode.set(row.code, row);
console.log(`直した組み合わせ ${changed.length} 件（コード ${byCode.size} 種）`);
for (const row of byCode.values())
  console.log(`  ${row.code}  ${row.portions} 玉  ${row.from} 釜 → ${row.to} 釜`);
if (unknown.length > 0) {
  const codes = [...new Set(unknown.map((row) => row.code))];
  console.log(`\n**正本に無いコード** ${codes.length} 種——玉数が引けないので触らない:`, codes);
}
const missing = [...portionsOf.keys()].filter(
  (code) =>
    !policy.fields.menuItems.value.some((item) => item.sizes.some((s) => Number(s.code) === code)),
);
if (missing.length > 0)
  console.log(
    `\n**正本にあって対応表に無いコード** ${missing.length} 種——この麺量は茹で対象と認識されない:`,
    missing,
  );

if (process.argv.includes("--write")) {
  await writeFile(POLICY, `${JSON.stringify(policy, null, 2)}\n`);
  console.log("\n書き込みました:", POLICY);
} else {
  console.log("\n（--write を付けると書き込みます）");
}
