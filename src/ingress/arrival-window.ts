// src/ingress/arrival-window.ts — Order_Arrival_Time の値域窓。cloudflare:workers にも storage にも
// 触れない純粋モジュール。
//
// batch.ts の 4 構造検証（`arrivalTimestampMs` が非負整数）は型としての要件であり、上流が保証するのも
// そこまでである（Upstream_Contract は型のみを保証し値域を保証しない）。ゆえに値域は本経路が検査する
// ——`arrival_timestamp_ms = 0`（1970-01-01）は非負整数ゆえ構造検証を通るが、それが Order_Arrival_Time
// になれば Wait_Time が約 56 年となり、並び順の基準が Order_Arrival_Time であるため当該品目が永久に
// 待ち行列の先頭に居座る（AC 8.12）。
//
// **窓の外は `contract-violation` へ落とす。** 型として解釈できない値（構造検証で落ちる値）と原因が
// 同じ（上流が保証すべき値の異常）で、扱いも同じ（`contract-violation:{storeCode}` へ 2 時間隔離し
// 再生しない）ゆえ、種別を分けない（AC 8.15）。Poison_Record にはしない——毒にすれば上流のバグで
// データが静かに消える（Duplicate_Bias）。窓外の Record に対して受理時刻も `payload.datetime` も
// 代替の起点に用いない（起点を推測で埋めない・AC 8.10）。

/**
 * ARRIVAL_WINDOW_MS — 到着時刻が有効である幅（2 時間）。
 *
 * **この値の単一の出所である。** 値域窓の下限（`now - ARRIVAL_WINDOW_MS`）と Unrouted_Record の保持
 * 期間は同一の値であり、根拠も同一である——再生に意味があるのは、その注文がまだ厨房で作られている
 * 可能性がある間だけである（AC 8.13・11.8）。二箇所に書けば、一方だけを直したときに「窓を抜けたのに
 * 保留に残る」あるいはその逆が生まれる。
 *
 * 上流の DLQ リプレイ可能期間（168 時間）には合わせない。あちらは調査のための保持であって、
 * 待ち行列へ入れてよい範囲ではない。
 */
export const ARRIVAL_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * isWithinArrivalWindow — Order_Arrival_Time が値域窓の内にあるか。
 *
 * 窓は「受理時刻の 2 時間前から受理時刻まで」の閉区間である（両端を含む）。
 *
 * **下限は固定値ではなく受理時刻からの相対で定める**（AC 8.13）。固定の下限はコードに時代を焼き付け、
 * 時が経つほど窓が広がって意味を失う。
 *
 * **上限は受理時刻そのものである**（AC 8.14）。上流が保証する遅延予算は 15 秒であり、受理時刻より
 * 後の到着時刻は時計のずれを超えた異常である。
 *
 * `now` を引数で受け取り、内側で時計を読まない（純粋関数に時計を持ち込まない既存の規律）。窓の検査は
 * Worker が `now` を渡して行い、再生時にも同じ関数で再評価する——判定を二箇所に書けば、取り込みでは
 * 窓内なのに再生では窓外という食い違いが生まれる。
 */
export function isWithinArrivalWindow(arrivalTimestampMs: number, now: number): boolean {
  return arrivalTimestampMs <= now && arrivalTimestampMs >= now - ARRIVAL_WINDOW_MS;
}
