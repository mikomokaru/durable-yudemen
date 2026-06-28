// domain/timer.ts — Timer という事実の単一の芯（engine と client が共有する表現非依存の形）。
// プラットフォーム非依存の純粋な型定義。import を持たない。
//
// 4つのフィールド（id / slotId / noodleType / endTime）は「茹でタイマーという事実」そのものであり、
// 一度だけここで宣言する。表現（ワイヤの生プリミティブ / engine のブランド型）はフィールド型を
// 型パラメータで差し替えて導出する。既定（引数なし）はワイヤの生表現。
//
// domain は「真に両者で共有される契約」だけを持つ。片側専用の基底（engine 専用の Sequenced など）は
// その側に置く（定義の場所は audience に従う・steering/timer-model.md）。
// これは「Timer は 1 概念・2 表現」という判断（枠組み B）の芯にあたる。
// 詳細は yude-men-timer/design.md「Timer 表現の単一芯化（TimerFact）」を参照。

/**
 * TimerFact — タイマーという事実の形。
 *
 * 残り秒は含めず endTime（事実）を運ぶ。表現ごとにフィールド型を差し替える:
 *   - ワイヤ: TimerFact（既定 = string/number の生プリミティブ）。
 *   - engine: TimerFact<TimerId, SlotId, NoodleType, EpochMillis>（検証済みブランド型）。
 */
export interface TimerFact<Id = string, Slot = string, Noodle = string, Time = number> {
  /** 安定した一意識別子。キャンセルとブロードキャストの宛先。 */
  readonly id: Id;
  /** 所属するスロット（釜）。 */
  readonly slotId: Slot;
  /** 麺の種類。 */
  readonly noodleType: Noodle;
  /** 絶対終了時刻（事実）。残り秒ではない。 */
  readonly endTime: Time;
}
