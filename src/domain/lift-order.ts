// domain/lift-order.ts — 上がり順（Lift_Order）の導出。走行中の Timer に「茹で上がる順の番号」を振る純粋関数。
//
// 番号は保持しない導出値である（lift-order-numbering 判断 6）。描画のたびに Timer 集合と now から導き、状態にも
// ワイヤにも永続にも持たない——残り時間と同じ規律（要件 12.2 の思想）。ここに置くのは、番号の単位（同じ実効 endTime
// かつ同じ注文）と並び（endTime → 最早 startTime → 注文の識別子）という規則が一つであるべきで、client の描画側に
// 式を書けば釜のカードと将来の読み手（音・レール）が別の番号に達しうるからである。群・先頭（lift-group.ts）と同じく
// **店舗全体**で判定し、担当範囲で絞るのは表示だけ（判断 1・lift-group-display AC 1.6 / 2.12）。
//
// 入力は engine の `Timer` も wire の `TimerFact` / client の `ClientTimer` も満たす構造型で受ける。読むのは
// id・startTime・endTime（実効 endTime＝Boil_Sync の調整込み）と `orderItem.externalOrderId` だけである。

import { compareText } from "./order";

/**
 * 上がり順の導出が読む Timer の形。`slotIds` は読まない——複数釜を駆動する Timer は 1 本として数え、番号は Timer の id に
 * 付く（駆動する各釜のカードが同じ id で引くので自然に同じ番号になる・判断 5）。
 */
export interface LiftTimer {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
  /** 由来する注文。null はアドホック開始（1 本 1 単位）。`itemIndex` は読まない（単位は注文であって品目ではない）。 */
  readonly orderItem: { readonly externalOrderId: string } | null;
}

/** Lift_Unit（上げて盛る回）——同じ実効 endTime かつ同じ注文の走行中 Timer の組。 */
interface LiftUnit {
  readonly endTime: number;
  /** 単位内の最早 startTime（先に始めた注文が先・判断 2）。 */
  startTime: number;
  /** 注文の識別子。アドホックは NUL ＋ Timer の id（注文の識別子は非空の文字列なので衝突しない）。 */
  readonly orderKey: string;
  readonly ids: string[];
}

/**
 * liftOrderOf — 走行中（`endTime > now`）の Timer を上がり順に番号づけする。鍵は Timer の id、値は 1 始まりの密な順位。
 *
 * 1. 対象は走行中だけ。茹で上がり（`endTime ≤ now`）は番号を持たない（Map に無い・判断 3）。
 * 2. 単位は「同じ実効 endTime かつ同じ注文」。同じ Sync_Set でも注文が違えば別の番号——上げるタイミングは同じでも
 *    盛り付けと配膳は注文ごとに分かれる（判断 2）。注文を持たない Timer は 1 本 1 単位。
 * 3. 単位の並びは endTime 昇順 → 単位内の最早 startTime 昇順 → 注文の識別子の符号単位順（決定的）。
 * 4. 番号は並びの index + 1（密——1・1・2・3 であって 1・1・3・4 ではない）。番号は「上げて盛る回」で、本数ではない。
 *
 * 入力の並びに依らず同じ Map に達する（同じ入力からは同じ結果）。`now` は補正済み（サーバ基準）の現在時刻で、
 * 走行中の判定 `endTime > now` は client の `remainingMs(...) > 0` と同じ線である。
 */
export function liftOrderOf(
  timers: readonly LiftTimer[],
  now: number,
): ReadonlyMap<string, number> {
  const units = new Map<string, LiftUnit>();
  for (const timer of timers) {
    if (timer.endTime <= now) continue; // 茹で上がりは対象外（判断 3）
    const orderKey =
      timer.orderItem === null ? `\u0000${timer.id}` : timer.orderItem.externalOrderId;
    const key = `${timer.endTime}\u0000${orderKey}`;
    const unit = units.get(key);
    if (unit === undefined) {
      units.set(key, {
        endTime: timer.endTime,
        startTime: timer.startTime,
        orderKey,
        ids: [timer.id],
      });
    } else {
      unit.startTime = Math.min(unit.startTime, timer.startTime);
      unit.ids.push(timer.id);
    }
  }

  const ordered = [...units.values()].sort(
    (a, b) =>
      a.endTime - b.endTime || a.startTime - b.startTime || compareText(a.orderKey, b.orderKey),
  );

  const order = new Map<string, number>();
  ordered.forEach((unit, index) => {
    for (const id of unit.ids) order.set(id, index + 1);
  });
  return order;
}
