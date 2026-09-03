// domain/order.ts — 未着手オーダー（Pending_Order）という事実の契約。同じ domain 内の語彙（firmness・timer・store）だけを取り込む。
//
// Pending_Order は「まだ茹で始めていないオーダーの 1 品目」であり、正本は DO の永続層に置く（AC 2.1）。
// POS の状態を正本として参照しない——外部の可用性に待ち行列の真実を委ねると、瞬断のたびに現場の見え方が
// 揺れる。届いた事実をこちらで確定させ、確定した事実だけを配る。
//
// なぜ TimerFact と別に立つか（timer-model.md の判定）:
//   1. 「両者で共有される事実か」→ client が待ち行列と推奨を表示するため、共有される事実である。
//      ゆえに片側専用（engine / client）ではなく domain に置く。
//   2. 「TimerFact を god type にしないか」→ Timer は「既に茹でている釜の計時」、Pending_Order は
//      「まだ釜に入っていない品目」。占有する slot も endTime も持たない、基数も生存期間も違う概念である。
//      共有だからといって一つの型へ混ぜれば、共有の芯が片側都合で膨らみ、複雑性は抑制ではなく増幅に転じる。
//   3. 「概念が別なら名前を分ける」→ よって独立した契約として立てる。両者を結ぶのは engine 専用の
//      Ordered.orderItem（{ externalOrderId; itemIndex }）で、その紐づけは domain へは露出しない。

import { isFirmness, type Firmness } from "./firmness";
import { isNonEmptyString, isNonNegativeInteger, isRecord, toDeclaredName } from "./predicate";
import { isNonEmpty, type NonEmptyArray } from "./timer";
import { SLOT_SPAN_MAX, SLOT_SPAN_MIN, type NoodlePreset } from "./store";

/**
 * PendingOrder — 未着手オーダーの 1 品目。
 *
 * 茹で秒（boilSeconds）は持たない。StoreConfig.noodlePresets から noodleType × firmness で引ける導出値であり、
 * 持てば同じ真実が二箇所に生まれて必ずズレる（麺の設定変更が既存の待ち行列に反映されない、という形で現れる）。
 * Wait_Time も同様に持たない。arrivalTime（事実）と提供時刻からの導出値である。
 */
export interface PendingOrder {
  /** POS 側の識別子。同一オーダーの再送（modification）を upsert する鍵。 */
  readonly externalOrderId: string;
  /** 同一オーダー内の品目連番。externalOrderId との組で 1 品目を一意に指す。 */
  readonly itemIndex: number;
  /** 麺の種類。茹で秒はここから StoreConfig 経由で引く。 */
  readonly noodleType: string;
  /** 茹で加減（安定 id・Firmness）。麺ごとの硬さ別茹で秒表のキー。 */
  readonly firmness: Firmness;
  /** Table_Group（同卓提供を揃える単位）の識別子。null は「その品目だけの単独グループ」。 */
  readonly tableId: string | null;
  /** Order_Arrival_Time（絶対時刻の事実）。Wait_Time の起点であり、待ち行列の並び順の基準。 */
  readonly arrivalTime: number;
  /**
   * 1 品目がスロット軸上で占める幅（SLOT_SPAN_MIN〜SLOT_SPAN_MAX）。麺量の指定から翻訳して定める。
   *
   * timer-model.md の判定を通した結果ここに置く——client が待ち行列を表示し engine が計画を組むのに要る
   * ため共有される事実であり、片側専用の関心事ではない。Timer.slotIds（割り当てられた実体）とは
   * 「要求」と「割当」の関係で別概念ゆえ、被せず別の名で立てる。
   */
  readonly slotSpan: number;
  /**
   * POS が申告した親品目の商品名。伝票に印字される文字列そのもの。
   *
   * 設定（StoreConfig.menuItems）に名前表を設けず申告値を持つのは、伝票の文字列と釜の画面の文字列を同じ
   * 出所にするためである。表を別に持てば投入漏れと改名のズレが起きる。**正規化しない**——半角カナ等の
   * 整形は表示時の導出であり、保存は事実のままとする。
   *
   * 欠落・空文字・型違いは null（Pass_Through）。null は「POS が名前を送っていない」という正常な入力で、
   * 表示は noodleType で代替する。
   */
  readonly itemName: string | null;
  /** POS が申告した麺量 child の商品名。slotSpan を決めた child と同じ同定結果から取る。欠落は null。 */
  readonly sizeName: string | null;
}
/**
 * Order_Ingress が受けた到着の生値（品目の配列）を PendingOrder 列へ写す純粋関数。
 *
 * **1 品目でも不正なら全体を null へ落とす**（AC 1.4「当該到着を拒否し、Pending_Order 集合と Timer 集合の
 * いずれも変更しない」）。この点だけが toNoodlePresets と形が違う——設定は不正要素を畳んで残りで営業を続ける
 * のが善だが、到着は「注文の一部だけを受理した」状態を作れば現場が欠品に気づけない。要件が全体拒否を定めて
 * いるのは、部分受理という嘘を許さないためである。空配列も受理する内容が無いため null。
 *
 * 受理拒否（400）への写しは呼び出し側（shell の受け口）が行う。ここは「妥当な PendingOrder 列か否か」だけを
 * 答え、HTTP の語彙を domain へ持ち込まない。
 *
 * noodleType は presets との突き合わせで「未知の品目種別」（AC 1.4）を弾く。設定全体（StoreConfig）ではなく
 * 麺種プリセットだけを受け取る——判定に要るのはこの一つで、重み・許容幅・レイアウトは無関係である。
 * arrivalTime は生値に含めず引数で受ける。Order_Arrival_Time は「Order_Ingress 経由で受理された絶対時刻」
 * という受け手側の事実であって、POS の主張ではない（主張を許せば待ち時間の起点を外部が操作できてしまう）。
 *
 * 同一 (externalOrderId, itemIndex) の重複はここでは見ない。集合としての一意性は upsertOrder の関心事である。
 */
export function toPendingOrders(
  raw: unknown,
  presets: readonly NoodlePreset[],
  arrivalTime: number,
): NonEmptyArray<PendingOrder> | null {
  if (!Array.isArray(raw)) return null;
  const orders: PendingOrder[] = [];
  for (const item of raw) {
    const order = toPendingOrder(item, presets, arrivalTime);
    if (order === null) return null;
    orders.push(order);
  }
  return isNonEmpty(orders) ? orders : null;
}

/** 生値を 1 件の PendingOrder へ正規化する。必須属性の欠落・未知の品目種別・型違反はいずれも null。 */
function toPendingOrder(
  value: unknown,
  presets: readonly NoodlePreset[],
  arrivalTime: number,
): PendingOrder | null {
  if (!isRecord(value)) return null;
  const candidate = value;
  if (!isNonEmptyString(candidate.externalOrderId)) return null;
  // 品目連番は 0 以上の整数（NaN / Infinity は整数性の判定で落ちる・domain/predicate）。
  if (!isNonNegativeInteger(candidate.itemIndex)) return null;
  // 未知の品目種別を弾く（AC 1.4）。空文字はどのプリセットにも一致しないため、この一手で型違反も覆う。
  if (
    typeof candidate.noodleType !== "string" ||
    !presets.some((preset) => preset.noodleType === candidate.noodleType)
  ) {
    return null;
  }
  if (!isFirmness(candidate.firmness)) return null;
  // tableId は「無い」ことに意味がある（卓に紐づかない持ち帰りは単独グループ）。欠落・null は null へ正規化し、
  // 文字列以外と空文字は型違反として拒否する——空の卓 id を通すと、卓なしの品目が一つの卓へ黙って束ねられる。
  // 判定は toDeclaredName ただ一つに閉じる（同じ形の関門を項目ごとに書かない）。
  const tableId = toDeclaredName(candidate.tableId);
  if (tableId === null) return null;
  const slotSpan = toSlotSpan(candidate.slotSpan);
  if (slotSpan === null) return null;
  // 余剰フィールドを落として正規化する（外部の混ぜ物を待ち行列の正本へ持ち込まない）。
  return {
    externalOrderId: candidate.externalOrderId,
    itemIndex: candidate.itemIndex,
    noodleType: candidate.noodleType,
    firmness: candidate.firmness,
    tableId: tableId.name,
    // 商品名は素通しする（AC 4.3）。欠落・空文字・型違いは null へ畳み、Record も品目も拒否しない
    // ——名前は麺を茹でる判断に要らず、読めないことを拒否事由にすれば伝票が現場へ届かなくなる。
    itemName: toDeclaredName(candidate.itemName)?.name ?? null,
    sizeName: toDeclaredName(candidate.sizeName)?.name ?? null,
    arrivalTime,
    slotSpan,
  };
}

/**
 * 生値を占有幅へ写す。値域外・非整数・null は null（呼び出し側が到着全体を拒否する）。
 *
 * 欠如だけは 1 スロット占有へ畳む。麺量の語彙を持たない到着（既存 Order_Ingress の直接投入）は現に
 * 1 品目 1 スロットで計画されており、畳んだ値がその実際の挙動に一致する——これは「指定が無い」という
 * 入力の形に対する既定であり、不正値を黙って通すことではない。下限と同じ値になるのは偶然ではなく、
 * 占有しない麺が在りえないことの帰結である。
 *
 * 値域外はクランプせず拒否する（store.ts の toNoodleSize と同じ判断）。勝手に寄せれば、どこにも
 * 要求されていない占有幅を新たに作ってしまう。
 */
function toSlotSpan(value: unknown): number | null {
  if (value === undefined) return SLOT_SPAN_MIN;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < SLOT_SPAN_MIN || value > SLOT_SPAN_MAX) return null;
  return value;
}
