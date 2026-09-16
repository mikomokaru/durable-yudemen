// Tail 側の記録検査（2026-09-16）。**このリポジトリで検証ライブラリを使ってよい唯一の file である**
// （例外の根拠は `tests/pos-order-ingress.static.test.ts` の (e)）。
//
// なぜ Tail 側でオブジェクトを検査するのか。Producer は `console.log(payload)` でオブジェクトのまま
// 出し、Tail が受け取って検査し、通ったものだけ Pipelines へ流す。
//
// **文字列で渡していた理由は実測で崩れた。** 2026-09-16 に使い捨ての Producer と Tail を配備して測った
// ところ、200 KB の文字列も 5,000 要素の配列も 200 段の入れ子も**値が途中で切れずに届いた**。
// 切り詰めは行を丸ごと落とす形で起き、そのとき event の `truncated` が true になる（小さい走では
// false なので旗は意味を持つ）。ゆえに「canonical へ戻して byte 比較する」検出は、実際には起きない
// 壊れ方への備えだった。落ちた行そのものは取り戻せないが、落ちた事実は `truncated` 列に残る。
//
// 得たものは名乗りの確かさである。文字列時代の名乗りは `line.includes('"operationKind"')` という
// **部分一致の当て推量**で、2026-09-16 の午前に本番の普通のログを全て「壊れた操作記録」として数え、
// 毎分約 200 件の警告を出した。オブジェクトなら `typeof value.operationKind === "string"` という
// 場の検査になる。
//
// **この file を Producer 側から import してはならない。** 店舗 DO の bundle に検証ライブラリが載る。
// 検査は Tail Worker の実行だけで走る。

import { z } from "zod";
import { isValidStoreId } from "../registry/slug";
import type { OperationRecord } from "../operation-history/record";
import {
  LIFT_DELAY_RECORD_TYPE,
  LIFT_DELAY_START_RECORD_TYPE,
  LIFT_DELAY_SUPPORTED_PAYLOAD_VERSIONS,
  type LiftDelayRecord,
  type LiftDelayStartRecord,
} from "../lift-delay/record";
import { ORDER_ARRIVAL_RECORD_TYPE, type OrderArrivalRecord } from "../order-arrival/record";

/**
 * 正の整数 epoch millisecond。`OperationRecord` の該当属性は branded type なので、検証を通った値を
 * その型として扱う。**branding は検証の結果に付ける名であって、検証の代わりではない。**
 */
const epochMillis = z
  .int()
  .positive()
  .transform((value) => value as OperationRecord["eventTime"]);

/** 空でない文字列。空文字を「未設定」として受け入れない。 */
const nonEmptyString = z.string().min(1);

/** 店舗 slug。ingress と同じ判定を使う（規則を二重に書かない）。 */
const storeId = z.string().refine(isValidStoreId, { message: "invalid store id" });

/** 空でない slot ID の列。`NonEmptyArray<string>` は `readonly [T, ...T[]]` である。 */
const slotIds = z
  .array(nonEmptyString)
  .min(1)
  .transform((value) => value as unknown as OperationRecord["slotIds"]);

const firmness = z.enum(["extraHard", "hard", "normal", "soft"]);

/**
 * 共通属性。`operationKind` は各枝が自分の literal で上書きする。
 *
 * 各枝は `.strict()` である。未知の属性も、その kind に許されない既知属性も落ちる
 * （文字列時代の `disallowed-operation-kind-attribute` と同じ禁）。
 */
const operationCommon = {
  storeId,
  timerId: nonEmptyString,
  eventTime: epochMillis,
  slotIds,
  noodleType: nonEmptyString,
  firmness,
};

/**
 * 操作記録。kind ごとに閉じた形で、**kind に属さない属性を持つ行は通さない**。
 *
 * 型注釈 `z.ZodType<OperationRecord>` が漂流の検出器である。`record.ts` に属性が増えたのに
 * ここを直し忘れれば、**型検査が落ちる**。
 */
export const operationRecordSchema: z.ZodType<OperationRecord, unknown> = z.discriminatedUnion(
  "operationKind",
  [
    z
      .strictObject({
        ...operationCommon,
        operationKind: z.literal("boil-started"),
        startTime: epochMillis,
        endTime: epochMillis,
      })
      .readonly(),
    z
      .strictObject({
        ...operationCommon,
        operationKind: z.literal("boiled"),
        endTime: epochMillis,
        boiledAt: epochMillis,
      })
      .readonly(),
    z
      .strictObject({
        ...operationCommon,
        operationKind: z.literal("adjusted"),
        endTime: epochMillis,
      })
      .readonly(),
    z.strictObject({ ...operationCommon, operationKind: z.literal("completed") }).readonly(),
    z.strictObject({ ...operationCommon, operationKind: z.literal("cancelled") }).readonly(),
  ],
);

/** 読める形式版。書く版と読める版は別である（`src/lift-delay/record.ts`）。 */
const liftDelayPayloadVersion = z
  .int()
  .refine((value) => LIFT_DELAY_SUPPORTED_PAYLOAD_VERSIONS.includes(value), {
    message: "unsupported payload version",
  });

/** 開始直前の提案にあった配置。見つからないことを「単独群だった」と読ませない。 */
const shownPlacement = z.union([
  z
    .strictObject({
      kind: z.literal("found"),
      startAt: z.number(),
      serveAt: z.number(),
      mates: z.number(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("absent") }).readonly(),
]);

/** 遅延ログの終端。時刻そのものを持ち、遅延という導出値は持たない。 */
export const liftDelayRecordSchema: z.ZodType<LiftDelayRecord, unknown> = z
  .strictObject({
    recordType: z.literal(LIFT_DELAY_RECORD_TYPE),
    // 読める版だけを通す。未知の版は理由付きで弾く——黙って読み違えるより良い。
    payloadVersion: liftDelayPayloadVersion,
    eventId: nonEmptyString,
    storeId,
    timerId: nonEmptyString,
    outcome: z.enum(["completed", "cancelled"]),
    startedAt: z.number(),
    dueAt: z.number(),
    terminalAt: z.number(),
    noodleType: nonEmptyString,
    firmness,
    slotIds,
  })
  .readonly();

/** 遅延ログの開始。終端を待たずにその場で出す 1 行。 */
export const liftDelayStartRecordSchema: z.ZodType<LiftDelayStartRecord, unknown> = z
  .strictObject({
    recordType: z.literal(LIFT_DELAY_START_RECORD_TYPE),
    payloadVersion: liftDelayPayloadVersion,
    eventId: nonEmptyString,
    storeId,
    timerId: nonEmptyString,
    startedAt: z.number(),
    source: z.enum(["order-item", "ad-hoc"]),
    pendingBeforeStart: z.int().nonnegative(),
    pendingOtherItems: z.int().nonnegative(),
    activeTimerCount: z.int().nonnegative(),
    occupiedSlotCount: z.int().nonnegative(),
    shownPlacement,
    appliedWait: z.strictObject({ kind: z.literal("not-introduced") }).readonly(),
    /**
     * 品目への参照（payload 版 2 で追加）。**入力では任意、出力では常に在る。**
     *
     * 任意にするのは配備の順序のためである。Tail を先に出す規律は Tail が**緩い**ときだけ効く。
     * ここを必須にすると、新しい Tail が版 1 の行（この場を持たない）を全て弾き、Producer を
     * 出すまでの間ずっと開始の行が落ちる。2026-09-16 に逆順で踏んだのと同じ事故になる。
     */
    orderItem: z
      .union([
        z
          .strictObject({ externalOrderId: nonEmptyString, itemIndex: z.int().nonnegative() })
          .readonly(),
        z.null(),
      ])
      .default(null),
  })
  .readonly();

/**
 * JSON オブジェクトを表す文字列。**構造は一切見ない。**
 *
 * 読み解くのは「括弧が閉じているか」までで、鍵の名も値の型も数えない。ベンダーが項目を 1 つ増やして
 * も通る——素通し原則（pos-order-ingress 要件 14）が守るのはそこである。
 *
 * **オブジェクトであることまで要求してよい理由。** 取り込みの入口が既に同じことを要求している
 * （`src/ingress/batch.ts` の `readRecordStructure` は payload が非 null・非配列のオブジェクトで
 * なければ Record を成さないとする）。ここで同じ線を引くのは、新しい制約を足すのではなく**既にある
 * 制約と同じ水準に揃える**ことである。
 *
 * **何のための検査か。** いまは `JSON.stringify(record.payload)` で作っているので、構成上かならず
 * 妥当な JSON になる。検査が捕まえるのは将来の作り方の変化——連結・切詰め・別経路からの投入——で
 * ある。**壊れた原文を保存しない**方が、保存してから読めないと気づくより良い。分析の根拠は
 * `rawPayload` そのものだからである。
 */
const jsonObjectText = z.string().refine(
  (value) => {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  },
  { message: "not a JSON object" },
);

/**
 * 注文到着。**封筒だけを検査する。**
 *
 * 検査するのは我々の場と、上流が観測から付与したメタデータ（`arrivalTimestampMs` / `sequenceNumber` /
 * `path`）だけである。これらは素通し原則の対象外だと要件が明示している（pos-order-ingress 要件
 * 14.10・14.11）——層が違うので、型・構造の要件を課しても例外にあたらない。
 *
 * `rawPayload` は `z.string()` であって、中身も長さも問わない。**`order_items` 以下の構造には一切
 * 触れない。** ここに構造を書けば、ベンダーが項目を 1 つ増やした瞬間に記録が壊れる側になる。
 * 大きさの上限は物理行の側（`arrival.ts`）が持ち、超えれば理由付きで弾かれる。
 *
 * `externalOrderId` は `toUniqueKey` の結果である。中身の綴りを検査しない——上流の
 * パーセントエンコードの規則をここへ書き写せば、規則が二箇所になる。
 */
export const orderArrivalRecordSchema: z.ZodType<OrderArrivalRecord, unknown> = z
  .strictObject({
    recordType: z.literal(ORDER_ARRIVAL_RECORD_TYPE),
    payloadVersion: z.int().positive(),
    eventId: nonEmptyString,
    storeId,
    externalOrderId: nonEmptyString,
    arrivalTimestampMs: z.int().positive(),
    sequenceNumber: nonEmptyString,
    path: nonEmptyString,
    // 妥当な JSON オブジェクトであることだけを見る。中の構造は見ない（上の `jsonObjectText`）。
    rawPayload: jsonObjectText,
    payloadBytes: z.int().nonnegative(),
  })
  .readonly();

/** 診断に残す issue の上限。1 行の失敗で warning を膨らませない。 */
const ISSUE_LIMIT = 4;

/**
 * 検査の失敗を短い語の列にする。**Zod の文面をそのまま残さない**——診断ログの長さが入力次第で
 * 伸びる形にしないためで、必要なのは「どの場が、どう駄目だったか」だけである。
 */
export function issueSummary(error: z.ZodError): readonly string[] {
  const summary = error.issues
    .slice(0, ISSUE_LIMIT)
    .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`);
  return error.issues.length > ISSUE_LIMIT
    ? [...summary, `(+${error.issues.length - ISSUE_LIMIT} more)`]
    : summary;
}
