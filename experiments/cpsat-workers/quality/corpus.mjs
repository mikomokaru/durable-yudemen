// experiments/cpsat-workers/quality/corpus.mjs — 7-B の局面材料を作る純 Node 層。
//
// ここがやるのは 2 つだけである。
//   1. 店舗設定（StoreConfig）を**実マスタから**組む。
//   2. コーパスの行を Arrival_Record の形へ包む（payload には触れない）。
//
// **取り込みの変換は書かない。** payload → OrderItem の翻訳は本番の
// `StoreTimerDO.receiveRecords`（module-private な `toReceivedOrders`）だけが行う。
// ここが書けば写しが 2 つになり、差が計画の差か変換の差か分からなくなる。
//
// 包むときに足すのは上流が観測から付ける 2 つのメタデータだけで、これはコーパスに
// 無い（コーパスは payload の保管であって取り込み経路の保管ではない）。
//   ・`arrival_timestamp_ms` — `payload.datetime`（JST・秒精度）から導く
//   ・`sequence_number` — 時刻順の連番を 56 桁へ揃える
// どちらも payload の中身ではない（batch.ts の注記「path・arrival_timestamp_ms・
// sequence_number は上流が観測から付与するメタデータであり payload とは層が違う」）。
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
export const CORPUS_DIRECTORY = resolve(root, "docs/data_samples/noodle_plan_histories");

/** 1 ユニットのスロット数（domain/store.ts の SLOTS_PER_UNIT と同じ値）。 */
const SLOTS_PER_UNIT = 6;

/** `payload.datetime` は JST の壁時計（manifest の time_semantics）。UTC へ直す。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 硬さコード。チェーン共通（実データの `plu_no` に 10010〜10012 が実在する）。 */
const FIRMNESS_CODES = [
  { code: 10010, firmness: "hard" },
  { code: 10011, firmness: "normal" },
  { code: 10012, firmness: "soft" },
];

/** CSV の 1 行を素朴に読む（この CSV は引用符もカンマ埋め込みも持たない）。 */
function parseCsv(text) {
  const [header, ...lines] = text.trim().split("\n");
  const keys = header.split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((v, i) => [keys[i], v])));
}

/** 時刻文字列（JST・タイムゾーン表記なし）を epoch ミリ秒へ。 */
function toEpochMillis(declared) {
  const parsed = Date.parse(`${declared}Z`);
  if (!Number.isFinite(parsed)) throw new Error(`Unreadable datetime: ${declared}`);
  return parsed - JST_OFFSET_MS;
}

/**
 * 実マスタ（noodle_reference.csv）とコーパスから店舗設定を組む。
 *
 * **茹で秒・占有・釜数は CSV（実マスタ）から取る。** 手で書いた対応表 fixture ではない
 * ——占有の規則（NOODLE_SIZE >= 2.0 で 2）が fixture と食い違っており、占有は配置に
 * 直接効く。`BOILTIME_OFFSET` は domain に対応する概念が無いので読まない（限界に記す）。
 *
 * **親品目 → 麺種はコーパスから導く。** CSV が持つのは子品目（麺量）の商品コードだけで、
 * 親の商品コードを持たない。親と子は注文の中でしか結びつかないので、注文に現れた組から
 * 引く。麺種が親ごとに一意であることは検査する（破れたらその親を落として数える）。
 */
export function buildStoreConfigs(referenceCsv, records) {
  const reference = parseCsv(referenceCsv);
  const byStore = new Map();
  for (const row of reference) {
    const store = byStore.get(row.STORE_ID) ?? { rows: [], slots: Number(row.NOODLE_SLOTS) };
    store.rows.push(row);
    byStore.set(row.STORE_ID, store);
  }

  // 親品目ごとに、同じ注文に現れた「CSV に在る子品目」の麺種を集める。
  const parentNoodleTypes = new Map();
  for (const { storeId, payload } of records) {
    const store = byStore.get(storeId);
    if (store === undefined) continue;
    const sizeCodes = new Map(store.rows.map((row) => [Number(row.ITEM_CODE), row.NOODLE_NAME]));
    for (const item of Array.isArray(payload.order_items) ? payload.order_items : []) {
      if (typeof item !== "object" || item === null) continue;
      const children = Array.isArray(item.child_items) ? item.child_items : [];
      const names = new Set(
        children.map((child) => sizeCodes.get(child?.plu_no)).filter((name) => name !== undefined),
      );
      if (names.size === 0) continue;
      const key = `${storeId}:${item.plu_no}`;
      const seen = parentNoodleTypes.get(key) ?? new Set();
      for (const name of names) seen.add(name);
      parentNoodleTypes.set(key, seen);
    }
  }

  const configs = new Map();
  const conflicts = [];
  for (const [storeId, store] of byStore) {
    // 麺種ごとの茹で秒。CSV は子品目の行を持つので麺種へ畳む（同一麺種の行は同じ秒である
    // ことを検査する——違えばどちらを取っても嘘になる）。
    const presets = new Map();
    const sizesByNoodleType = new Map();
    for (const row of store.rows) {
      const boilSeconds = {
        extraHard: Number(row.BOILTIME_VERYHARD),
        hard: Number(row.BOILTIME_HARD),
        normal: Number(row.BOILTIME_NORMAL),
        soft: Number(row.BOILTIME_SOFT),
      };
      const existing = presets.get(row.NOODLE_NAME);
      if (existing !== undefined) {
        for (const key of Object.keys(boilSeconds))
          if (existing[key] !== boilSeconds[key])
            throw new Error(`Inconsistent boil seconds for ${storeId}/${row.NOODLE_NAME}`);
      } else presets.set(row.NOODLE_NAME, boilSeconds);
      const sizes = sizesByNoodleType.get(row.NOODLE_NAME) ?? new Map();
      sizes.set(Number(row.ITEM_CODE), Number(row.SLOT_OCCUPANCY));
      sizesByNoodleType.set(row.NOODLE_NAME, sizes);
    }

    const menuItems = [];
    for (const [key, names] of parentNoodleTypes) {
      if (!key.startsWith(`${storeId}:`)) continue;
      const productCode = Number(key.slice(storeId.length + 1));
      if (!Number.isInteger(productCode)) continue;
      if (names.size !== 1) {
        conflicts.push({ storeId, productCode, noodleTypes: [...names] });
        continue;
      }
      const noodleType = [...names][0];
      const sizes = [...(sizesByNoodleType.get(noodleType) ?? new Map())].map(
        ([code, slotSpan]) => ({ code, slotSpan }),
      );
      menuItems.push({ productCode, noodleType, sizes });
    }

    const unitCount = store.slots / SLOTS_PER_UNIT;
    if (!Number.isInteger(unitCount) || unitCount < 1)
      throw new Error(`Unusable NOODLE_SLOTS for ${storeId}: ${store.slots}`);
    configs.set(storeId, {
      unitCount,
      noodlePresets: [...presets].map(([noodleType, boilSeconds]) => ({ noodleType, boilSeconds })),
      firmnessCodes: FIRMNESS_CODES,
      menuItems: menuItems.sort((a, b) => a.productCode - b.productCode),
    });
  }
  return { configs, conflicts };
}

/** コーパス全件を読む。1 行 = 1 レコード（`{path, payload}`）。 */
export async function readCorpus() {
  const names = (await readdir(CORPUS_DIRECTORY)).filter((name) => name.endsWith(".jsonl")).sort();
  const files = [];
  for (const name of names) {
    const text = await readFile(resolve(CORPUS_DIRECTORY, name), "utf8");
    const storeId = name.split("_")[0];
    const rows = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        const parsed = JSON.parse(line);
        return {
          storeId,
          file: name,
          line: index,
          path: parsed.path,
          payload: parsed.payload,
          corpusMillis: toEpochMillis(parsed.payload.datetime),
        };
      });
    // 時刻順に整える（同時刻は元の行順）。連番はこの順で振る。
    rows.sort((a, b) => a.corpusMillis - b.corpusMillis || a.line - b.line);
    files.push({ name, storeId, rows });
  }
  return files;
}

/** 上流の桁数に合わせた 56 桁の `sequence_number`（pos-records の統合テストと同じ規約）。 */
function sequenceNumber(index) {
  return String(index).padStart(56, "0");
}

/**
 * 1 局面ぶんの Arrival_Record 列を組む。
 *
 * `delta` は「コーパスの時刻 → 再生の時刻」の平行移動である。窓の最後の到着が `anchorAt`
 * に来るように取るので、**窓の内側の相対間隔はそのまま保たれ、すべての到着は `now` 以前に
 * 収まる**。窓ごとに新しい DO を使うため、平行移動が窓を跨いで食い違うことはない。
 */
export function toArrivalRecords(rows, delta) {
  return rows.map((row) => ({
    path: row.path,
    payload: row.payload,
    arrival_timestamp_ms: row.corpusMillis + delta,
    sequence_number: sequenceNumber(row.line),
  }));
}

/** 決定的な疑似乱数（seed は文字列・plan-quality-evaluation-plan の §2）。 */
export function seededRandom(seed) {
  let state = Number(BigInt(`0x${createHash("sha256").update(seed).digest("hex").slice(0, 8)}`));
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}
