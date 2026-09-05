// domain/timer.ts — Timer という事実の単一の芯（engine と client が共有する表現非依存の形）。
// 同じ domain 内の firmness 語彙のみ取り込む（外部基盤には依存しない）。
//
// 7つのフィールド（id / slotIds / noodleType / firmness / startTime / endTime / orderItem）は「茹でタイマーという
// 事実」そのものであり、一度だけここで宣言する。表現（ワイヤの生プリミティブ / engine のブランド型）はフィールド型を
// 型パラメータで差し替えて導出する。既定（引数なし）はワイヤの生表現。firmness / orderItem は表現に依らず固定。
//
// domain は「真に両者で共有される契約」だけを持つ。片側専用の基底（engine 専用の Sequenced など）は
// その側に置く（定義の場所は audience に従う・steering/timer-model.md）。
// 詳細は yude-men-timer/design.md「Timer 表現の単一芯化（TimerFact）」を参照。

import type { Firmness } from "./firmness";

/**
 * NonEmptyArray — 1 要素以上を型で強制する非空配列（タプル＋rest）。
 *
 * 空配列リテラルは型として代入不能になり、`[0]` は常に定義済みとして扱える。
 * 「不正な状態を表現可能にしない」（design-philosophy.md）を配列の基数に適用したもの。
 * JSON を跨ぐと保証は失われるため、未検証入力の境界では isNonEmpty を通して再確立する。
 */
export type NonEmptyArray<T> = readonly [T, ...T[]];

/**
 * 配列が非空かを判定する型ガード。未検証入力（ワイヤ・永続）から NonEmptyArray を確立する唯一の関門。
 * cast をこの一点へ封じ込め、境界の検証結果に非空の保証を載せる（ブランド型と同じ構図）。
 */
export function isNonEmpty<T>(values: readonly T[]): values is NonEmptyArray<T> {
  return values.length > 0;
}

/**
 * OrderItemOrigin — Timer が由来する注文品目への参照と卓。null はアドホック麺茹で（POS を経ない開始）。
 *
 * engine 専用だった Ordered.orderItem（ADR-0003）をそのまま共有の芯へ移した形（lift-group-display 判断 16）。
 * 用途は三つ。(1) 開始済み品目の同定——同一注文の modification が全品目を再送してきたとき、生きた Timer
 * （running / boiled）を持つ品目を Pending_Order の置換から除いて二重調理を防ぐ（pos-order-ingress 要件 1.8 / 8.4）。
 * (2) 卓の同定——同じ卓の走行中 Timer を計画の群の成員に留め、群の 1 本目を入れた後も残りが 1 本目へ揃う
 * （lift-group-planning・ADR-0003）。(3) 群の開始の判定——client が「同じ卓の走行中で endTime が群の serveAt に
 * 等しいもの」を探すために読む。client が読むゆえ共有事実であり、engine 専用の合成には留められない
 * （timer-model.md「駆動オーダーの保持——client 可視なら共有事実として TimerFact へ」）。
 * tableId を Timer の直下ではなく orderItem の内側に置くのは、(orderItem = null, tableId 非 null) という
 * 「POS を経ないのに卓を知る Timer」を型として構築不能にするため（同 ADR）。
 * modification で品目の卓が移っても走行中 Timer の tableId は追随しない——その Timer は既に旧卓の群として
 * 茹でている事実であり、再送で届いた未着手の品目が新しい卓の群に入る（upsertOrder が生きた Timer の
 * 品目を置換から除く規律の帰結。新しいコードは要らない）。
 * 走行中カードの表示には使わない（lift-group-display 要件 5.8）。
 *
 * 項目は生プリミティブで、ブランド型の表現差を持たないため型パラメータを足さない。
 */
export interface OrderItemOrigin {
  readonly externalOrderId: string;
  readonly itemIndex: number;
  /** 由来する卓。null は卓を持たない品目。 */
  readonly tableId: string | null;
}

/**
 * TimerFact — タイマーという事実の形。
 *
 * 残り秒は含めず、開始・終了の2つの絶対時刻（事実）を運ぶ。残り・進捗・総時間はここからの導出:
 *   remaining = endTime - now / progress = (now - startTime)/(endTime - startTime) / duration = endTime - startTime。
 * 表現ごとにフィールド型を差し替える:
 *   - ワイヤ: TimerFact（既定 = string/number の生プリミティブ）。
 *   - engine: TimerFact<TimerId, SlotId, NoodleType, EpochMillis>（検証済みブランド型）。
 */
export interface TimerFact<Id = string, Slot = string, Noodle = string, Time = number> {
  /** 安定した一意識別子。キャンセルとブロードキャストの宛先。 */
  readonly id: Id;
  /** 駆動するスロット（釜）の集合。1 Timer は 1 つ以上のスロットを同時に駆動する（型で非空を強制）。 */
  readonly slotIds: NonEmptyArray<Slot>;
  /** 麺の種類。 */
  readonly noodleType: Noodle;
  /** 茹で加減（安定 id・Firmness）。麺ごとの硬さ別茹で秒表のキー。endTime はこれと startTime から決まる。 */
  readonly firmness: Firmness;
  /** 茹で開始の絶対時刻（事実）。endTime の兄弟。進捗リングはこの2点から導出する。 */
  readonly startTime: Time;
  /** 絶対終了時刻（事実）。残り秒ではない。 */
  readonly endTime: Time;
  /** 由来する注文品目への参照と卓。null はアドホック麺茹で（POS を経ない開始）。 */
  readonly orderItem: OrderItemOrigin | null;
}
