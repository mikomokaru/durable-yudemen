// tests/domain/wireGenerators.ts — ワイヤ契約の生成器（verified-wire-contract）。
//
// 二層で用いる。
//  1. 妥当なメッセージ（往復・Property 2 が使う）。「サーバ／端末が実際に送りうる形」だけを作る。
//  2. それを構造的に壊した入力（全域性・Property 3 と差分・Property 4 が使う）。
//
// 素の `fc.string()` だけでは足りない。JSON として解釈できる確率がほぼゼロで、`JSON.parse` が投げない
// ことしか検査できず、境界の面白い入力（キー欠落・型違い・空配列・撤去済み種別・入れ子の不正）に一度も
// 届かない。壊し方の一覧はこのファイルが正本である。
//
// 妥当な値は**正規化済み**とする。ServerMessage 側の復号は store.ts の要素検証を共有しており、余剰
// フィールドを落とし値域も見る（正の秒数・正の商品コード・slotSpan の域内）。ゆえに深い等価が成り立つのは
// 「サーバが StoreConfig を経て送る値」に限る。これは性質の前提であって抜け穴ではない——ワイヤに載るのは
// 常に正規化済みの値だからである。
//
// optional 項目は省くときキーごと省く。`undefined` を値として置くと `JSON.stringify` が落とし、往復の
// 等価性が生成器の都合で破れる。
//
// **tests/client/generators.ts の同名生成器と統合しない。** 形は同じだが義務が違う。あちらは狭いプール
// （TIMER_ID_POOL / SLOT_ID_POOL / EXTERNAL_ORDER_ID_POOL）から引いて **id の衝突と再出現を誘発する**
// ——Reconcile の全置換・processedIds の刈り取り・snapshot 復活という性質は、衝突が起きなければ一度も
// 踏まれない。こちらは逆に、復号が見る形の面を広く踏むため域を広く取る。一つに畳めば引数でプールを
// 切り替える分岐が生まれ、どちらの義務なのか読めなくなる（domain/wire.ts が toPendingOrder を流用しない
// のと同じ判断）。

import * as fc from "fast-check";
import type { ClientMessage, CookRecommendation, ServerMessage } from "../../src/domain/messages";
import type { PendingOrder } from "../../src/domain/order";
import type { NonEmptyArray, TimerFact } from "../../src/domain/timer";
import type { Firmness } from "../../src/domain/firmness";
import {
  DEFAULT_NOODLE_PRESETS,
  DEFAULT_SLOT_OFFSETS,
  defaultUnitOrigins,
  type StoreConfig,
} from "../../src/domain/store";
import { nonEmpty } from "../nonEmpty";

const SLOT_ID_POOL = ["0", "1", "2", "3", "4", "5"] as const;
const NOODLE_POOL = ["Thin", "Medium", "Thick"] as const;
const FIRMNESS_POOL: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

const genFirmness: fc.Arbitrary<Firmness> = fc.constantFrom(...FIRMNESS_POOL);
const genEpoch: fc.Arbitrary<number> = fc.integer({ min: 0, max: 4_000_000_000_000 });

/** 非空の slot 集合。型が非空を強制する 3 箇所（Timer / start / 推奨）が共有する。 */
const genSlotIds: fc.Arbitrary<NonEmptyArray<string>> = fc
  .subarray([...SLOT_ID_POOL], { minLength: 1 })
  .map((slots) => nonEmpty(slots));

const genTimerFact: fc.Arbitrary<TimerFact> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  slotIds: genSlotIds,
  noodleType: fc.constantFrom(...NOODLE_POOL),
  firmness: genFirmness,
  startTime: genEpoch,
  endTime: genEpoch,
});

const genPendingOrder: fc.Arbitrary<PendingOrder> = fc.record({
  externalOrderId: fc.string({ minLength: 1, maxLength: 8 }),
  itemIndex: fc.integer({ min: 0, max: 8 }),
  noodleType: fc.constantFrom(...NOODLE_POOL),
  firmness: genFirmness,
  tableId: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 6 })),
  arrivalTime: genEpoch,
  slotSpan: fc.integer({ min: 1, max: 6 }),
  // POS 申告の商品名。null と非空文字列の双方を分布する（要件 6.5）。
  itemName: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
  sizeName: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: null }),
});

const genRecommendation: fc.Arbitrary<CookRecommendation> = fc.record({
  externalOrderId: fc.string({ minLength: 1, maxLength: 8 }),
  itemIndex: fc.integer({ min: 0, max: 8 }),
  slotIds: genSlotIds,
  startAt: genEpoch,
  group: fc.string({ minLength: 1, maxLength: 8 }),
  anchor: fc.option(genEpoch, { nil: null }),
});

/**
 * StoreConfig — 正規化済みの確定値。
 *
 * 表（noodlePresets / firmnessCodes / menuItems / slotOffsets）は既定値に固定する。要素検証を共有する
 * ため生成の分散を広げても復号の枝は増えず、往復の前提（正規化済み）を崩す危険だけが増える。
 * unitOrigins は unitCount と長さを揃える（既定の導出をそのまま使う）。
 */
const genStoreConfig: fc.Arbitrary<StoreConfig> = fc
  .integer({ min: 1, max: 4 })
  .chain((unitCount) =>
    fc.record({
      unitCount: fc.constant(unitCount),
      arms: fc.integer({ min: 1, max: 6 }),
      toleranceRatio: fc.integer({ min: 0, max: 100 }),
      noodlePresets: fc.constant(DEFAULT_NOODLE_PRESETS),
      orderSyncWeight: fc.integer({ min: 0, max: 10 }),
      tableSyncWeight: fc.integer({ min: 0, max: 10 }),
      affinityWeight: fc.integer({ min: 0, max: 10 }),
      orderSyncToleranceSeconds: fc.integer({ min: 0, max: 120 }),
      tableSyncToleranceSeconds: fc.integer({ min: 0, max: 120 }),
      affinityToleranceDistance: fc.integer({ min: 0, max: 60 }),
      unitOrigins: fc.constant(defaultUnitOrigins(unitCount)),
      slotOffsets: fc.constant(DEFAULT_SLOT_OFFSETS),
      firmnessCodes: fc.constant([]),
      menuItems: fc.constant([]),
    }),
  );

/** 妥当な ServerMessage — 3 種すべてを分布する。 */
export const genValidServerMessage: fc.Arbitrary<ServerMessage> = fc.oneof(
  fc.record({
    type: fc.constant("snapshot" as const),
    serverTime: genEpoch,
    timers: fc.array(genTimerFact, { maxLength: 4 }),
    pendingOrders: fc.array(genPendingOrder, { maxLength: 4 }),
    recommendations: fc.array(genRecommendation, { maxLength: 4 }),
  }),
  fc
    .record({ type: fc.constant("config" as const), serverTime: genEpoch })
    .chain((head) => genStoreConfig.map((config) => ({ ...head, ...config }))),
  fc.record({
    type: fc.constant("error" as const),
    serverTime: genEpoch,
    code: fc.string({ maxLength: 12 }),
    message: fc.string({ maxLength: 24 }),
  }),
);

/**
 * 妥当な ClientMessage — 5 種すべてを分布する。
 *
 * start は品目参照を持たない 1 形だけである（slot-suggested-start が品目参照を startOrderItem へ移した）。
 */
export const genValidClientMessage: fc.Arbitrary<ClientMessage> = fc.oneof(
  // start はアドホック麺茹で専用に戻った（品目参照は startOrderItem が持つ）。ゆえに 1 形だけである。
  fc.record({
    type: fc.constant("start" as const),
    slotIds: genSlotIds,
    noodleType: fc.constantFrom(...NOODLE_POOL),
    boilSeconds: fc.integer({ min: 1, max: 1800 }),
  }),
  // 品目を指す開始。運ぶのは 3 項目だけで、麺種・茹で加減・茹で秒を持たない。
  fc.record({
    type: fc.constant("startOrderItem" as const),
    slotIds: genSlotIds,
    externalOrderId: fc.string({ minLength: 1, maxLength: 8 }),
    itemIndex: fc.integer({ min: 0, max: 8 }),
  }),
  fc.record({ type: fc.constant("cancel" as const), timerId: fc.string({ maxLength: 8 }) }),
  fc.record({ type: fc.constant("complete" as const), timerId: fc.string({ maxLength: 8 }) }),
  fc.record({
    type: fc.constant("adjust" as const),
    timerId: fc.string({ maxLength: 8 }),
    firmness: genFirmness,
  }),
);

// ── 壊し方 ───────────────────────────────────────────────────────────────────

/** 撤去済み種別（snapshot-broadcast で消えた 5 種）。復号は必ず失敗しなければならない。 */
export const RETIRED_MESSAGE_TYPES = [
  "started",
  "cancelled",
  "completed",
  "boiled",
  "adjusted",
] as const;

/** 壊し方の種別。名前で「何を壊したか」を反例に残す。 */
type Mutation =
  | { readonly kind: "drop-key" }
  | { readonly kind: "retype-value" }
  | { readonly kind: "empty-array" }
  | { readonly kind: "retired-type" }
  | { readonly kind: "break-nested" }
  // 「形は合うが値が境界」——空文字・0・負・非整数。typeof だけを見る条件と、非空や下限まで見る条件を
  // 区別できる唯一の壊し方であり、受理集合が縮んだことを検出できるかはこれに懸かっている。
  | { readonly kind: "edge-value" };

const genMutation: fc.Arbitrary<Mutation> = fc.constantFrom<Mutation>(
  { kind: "drop-key" },
  { kind: "retype-value" },
  { kind: "empty-array" },
  { kind: "retired-type" },
  { kind: "break-nested" },
  { kind: "edge-value" },
);

/** 形は合うが境界に居る値。文字列は空、数値は 0 / 負 / 非整数。 */
const EDGE_STRINGS = ["", " "] as const;
const EDGE_NUMBERS = [0, -1, 1.5] as const;

/** 壊れた値を作る。壊せなかった場合は元の値をそのまま返す（性質は「落ちない」ことだけを要求する）。 */
function mutate(value: Record<string, unknown>, mutation: Mutation, index: number): unknown {
  const keys = Object.keys(value);
  const key = keys[index % keys.length] ?? "type";
  switch (mutation.kind) {
    case "drop-key": {
      const { [key]: _dropped, ...rest } = value;
      return rest;
    }
    case "retype-value":
      return { ...value, [key]: typeof value[key] === "string" ? 0 : "x" };
    case "empty-array": {
      const arrayKey = keys.find((k) => Array.isArray(value[k]));
      return arrayKey === undefined ? value : { ...value, [arrayKey]: [] };
    }
    case "retired-type":
      return { ...value, type: RETIRED_MESSAGE_TYPES[index % RETIRED_MESSAGE_TYPES.length] };
    case "edge-value": {
      const current = value[key];
      if (typeof current === "string") {
        return { ...value, [key]: EDGE_STRINGS[index % EDGE_STRINGS.length] };
      }
      if (typeof current === "number") {
        return { ...value, [key]: EDGE_NUMBERS[index % EDGE_NUMBERS.length] };
      }
      return value;
    }
    case "break-nested": {
      const arrayKey = keys.find(
        (k) => Array.isArray(value[k]) && (value[k] as unknown[]).length > 0,
      );
      if (arrayKey === undefined) return value;
      const items = [...(value[arrayKey] as unknown[])];
      items[0] = { broken: true };
      return { ...value, [arrayKey]: items };
    }
  }
}

/** 妥当なメッセージを構造的に壊した Wire_Text。復号は null を返すか、通ったなら宣言型を満たす。 */
function genMutatedText(base: fc.Arbitrary<object>): fc.Arbitrary<string> {
  return fc
    .tuple(base, genMutation, fc.nat({ max: 8 }))
    .map(([message, mutation, index]) =>
      JSON.stringify(mutate(message as Record<string, unknown>, mutation, index)),
    );
}

/** 任意の Wire_Text — 妥当・構造的に壊れた形・素の文字列（JSON 解釈失敗の枝）の三領域。 */
export const genServerWireText: fc.Arbitrary<string> = fc.oneof(
  genValidServerMessage.map((message) => JSON.stringify(message)),
  genMutatedText(genValidServerMessage),
  fc.string({ maxLength: 24 }),
);

/** 任意の Wire_Text（client → server 側）。 */
export const genClientWireText: fc.Arbitrary<string> = fc.oneof(
  genValidClientMessage.map((message) => JSON.stringify(message)),
  genMutatedText(genValidClientMessage),
  fc.string({ maxLength: 24 }),
);
