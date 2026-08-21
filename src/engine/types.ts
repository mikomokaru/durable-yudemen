// core/types.ts — プラットフォーム非依存のブランド型と定数。
// cloudflare:workers にも storage にも触れない、純粋な TypeScript モジュール。
//
// ブランド型でプリミティブの取り違え（slotId と noodleType の混同など）を型で防ぐ。
// 実体は string / number だが __brand により互いに代入不能にし、検証済みの値だけが
// 各型を名乗れるようにする（生成は smart constructor 経由のみ）。

/** スロット（釜）の識別子。所属するスロットを表す。 */
export type SlotId = string & { readonly __brand: "SlotId" };

/** 麺の種類。 */
export type NoodleType = string & { readonly __brand: "NoodleType" };

/** Timer の安定した一意識別子。キャンセルとブロードキャストの宛先。 */
export type TimerId = string & { readonly __brand: "TimerId" };

/** エポックミリ秒で表す絶対時刻。残り秒ではなく「事実」としての時刻。 */
export type EpochMillis = number & { readonly __brand: "EpochMillis" };

/** 茹で時間の下限（秒）。要件1.5。 */
export const BOIL_SECONDS_MIN = 1;

/** 茹で時間の上限（秒）。要件1.5。 */
export const BOIL_SECONDS_MAX = 1800;

/** 同時走行 Timer の最大件数。要件3.1 / 3.8。 */
export const MAX_TIMERS = 100;

/** 発火判定の許容窓（ミリ秒）。多重・境界付近発火を冪等に一括処理するための窓。 */
export const EPSILON_MS = 500 as const;

/** 永続スナップショットの現行スキーマバージョン。要件11。
 *  v3: Timer に boiled フェーズの事実 boiledAt を追加（発火＝除去をやめ、明示完了まで残す）。
 *  v4: Timer に startTime（茹で開始の絶対時刻）を追加。進捗リングの導出元（旧データは endTime で埋める）。
 *  v5: Timer に firmness（茹で加減）を追加。旧データは "normal" で埋める。
 *  v6: Timer に engine 専用の adjustment（同期用の符号付きオフセット）を追加。欠如は 0 で埋める。
 *  v7: pendingOrders / acceptedSlices / requestedDigest を追加（調理順スケジューリング）。単一キーは維持する。
 *      Timer には engine 専用の orderItem（由来する注文品目）が乗る。欠如は null で埋める。
 *  v8: PendingOrder に slotSpan（占有するスロット幅）、状態に lastSequenceByTerminal（取り込みの重複排除の
 *      判定材料）を追加（POS オーダー取り込み）。前者の欠如は 1、後者の欠如は空で埋める——v7 以前の待ち行列は
 *      現に 1 品目 1 スロットで計画され、取り込み経路が無いため判定材料を持つ端末も無い。 */
export const CURRENT_SCHEMA_VERSION = 8 as const;
