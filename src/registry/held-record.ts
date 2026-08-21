// src/registry/held-record.ts — 保留（Unrouted_Record）と隔離（Upstream_Contract_Violation）が共有する
// 持ち物の型と、2 つの破棄（失効・件数上限）の純粋な判定。
//
// **2 つのキーで同じ型を運ぶのは、失効・件数上限・観測の規律が同一だからである**（design §9-b）。違うのは
// 再生の有無だけで、それはキーの側の事実であってこの型の事実ではない——`unrouted:{storeCode}` は店舗登録の
// 確定を契機に再生され、`contract-violation:{storeCode}` は 2 時間で失効して破棄されるだけである（隔離）。
//
// cloudflare:workers にも storage にも触れない純粋モジュール。作用（put・delete・キーの組み立て）は
// StoreRegistryDO が端で行う。

import { ARRIVAL_WINDOW_MS, isWithinArrivalWindow } from "../ingress/arrival-window";
import type { ArrivalRecord } from "../ingress/batch";

/**
 * HeldRecord — 保留・隔離が保つ 1 件。保持を始めた時刻（`heldAt`）を添える。
 *
 * **`heldAt` は `arrivalTimestampMs` とは別の事実である。** 後者は上流ストリームが記録した観測時刻
 * （retry でも動かない Order_Arrival_Time の起点）で、前者は本経路が保ち始めた時刻である。失効の判定に
 * 要るのは前者ではなく後者である——同じ Record が再送で二度保留されれば、保持の起点は二度目のそれになる。
 *
 * **判別可能な和型にする。** 中身は検証済みの `ArrivalRecord`（保留）か検証前の生値（隔離）のいずれかで、
 * 両方を持つことも一方も持たないこともない。`unknown` 1 本で受ければ、保留の側で既に確立している
 * 「4 構造を通っている」という事実が型から消え、再生（タスク 19 の identity ベース削除が
 * `sequenceNumber` を要する）が保留の中身を読み直すたびに検証をやり直すことになる。隔離の側は逆に
 * `ArrivalRecord` を構築できない（`arrival_timestamp_ms` が型を満たさない Record が実在する）ため、
 * 検証済みの形へ寄せることもできない。ゆえに 2 つの構成子を持つ 1 つの型が、両方の事実を偽らない唯一の形である。
 */
export type HeldRecord =
  /** 宛先未解決。検証済みゆえ再生時にそのまま宛先へ渡せる（再生はタスク 19）。 */
  | { readonly kind: "unrouted"; readonly heldAt: number; readonly record: ArrivalRecord }
  /** 上流の契約違反。**再生されない**——保持の意味は上流のバグを調べる証跡である（design §9-b）。 */
  | { readonly kind: "contract-violation"; readonly heldAt: number; readonly raw: unknown };

/**
 * HELD_RECORD_LIMIT — 1 Store_Code あたりに保つ Record 数の上限（AC 11.23）。
 *
 * 2 時間 × 4 件/分 × 3 端末 ≈ 1440 件を上回る余裕を持たせた値である。上限に達している状態は正常な運用では
 * 起こらず、不正送信または大量の登録漏れを示す。
 */
export const HELD_RECORD_LIMIT = 2000;

/**
 * HeldRetention — 保持し続けるものと、2 つの破棄の件数。
 *
 * **破棄を 1 つに畳まない**（AC 12.x の分離と同じ理由）。失効は登録の遅れを示し、上限超過は不正送信または
 * 大量の登録漏れを示す。混ぜれば、件数が動いたときに何を疑えばよいか判らなくなる。
 */
export interface HeldRetention {
  readonly retained: readonly HeldRecord[];
  /** 保持期間を過ぎて破棄した件数（`heldExpired`）。 */
  readonly expired: number;
  /** 件数上限の超過で破棄した件数（`heldOverflow`）。 */
  readonly overflow: number;
}

/**
 * isHeldExpired — 保持期間を過ぎているか。
 *
 * **保持期間は `ARRIVAL_WINDOW_MS`（値域窓の幅）そのものである。** 別の定数を立てれば、一方だけを直した
 * ときに「窓を抜けたのに保留に残る」あるいはその逆が生まれる。根拠も同一である——再生に意味があるのは、
 * その注文がまだ厨房で作られている可能性がある間だけである（AC 8.13・11.8）。
 *
 * 下限の閉じ方も `isWithinArrivalWindow` に揃える（`now - ARRIVAL_WINDOW_MS` を含む）。上限（未来の
 * `heldAt`）は見ない——時計が巻き戻ったときに保持を早く切る理由が無い。
 */
export function isHeldExpired(held: HeldRecord, now: number): boolean {
  return held.heldAt < now - ARRIVAL_WINDOW_MS;
}

/**
 * isHeldReplayable — 保持している 1 件が、いま再生してよいものか（AC 11.8・11.22）。
 *
 * **2 つの時刻を両方見る。** `heldAt`（保持を始めた時刻）が 2 時間を過ぎていれば失効であり、
 * `arrivalTimestampMs`（上流の観測時刻）が値域窓の外へ出ていれば再生の対象でない。前者だけを見れば、
 * 窓の下限をわずかに超えた Record を「保持したのが最近だから」送ってしまい、Wait_Time の起点が窓の外に
 * ある品目が待ち行列へ入る（並びの基準が Order_Arrival_Time ゆえ順序を壊す）。
 *
 * **窓の判定は `isWithinArrivalWindow` を通す。** 取り込みの入口（Worker）と再生が同じ関数を通ることが、
 * 「取り込みでは窓内なのに再生では窓外」という食い違いを起こさない唯一の形である。
 *
 * 隔離（`contract-violation`）は常に false を返す。あちらは決して再生されない（design §9-b）——保持の意味は
 * 上流のバグを調べる証跡であり、そもそも窓の再評価に要る Order_Arrival_Time を持たない（型違反の生値ゆえ）。
 *
 * **型述語（type predicate）として返す。** 真であることは「再生してよい」と同時に「検証済みの `record` を
 * 持つ」を意味しており、後者を呼び出し側が別の分岐で確かめ直せば、同じ事実の判定が二箇所に分かれる。
 */
export function isHeldReplayable(
  held: HeldRecord,
  now: number,
): held is Extract<HeldRecord, { kind: "unrouted" }> {
  if (isHeldExpired(held, now)) return false;
  if (held.kind !== "unrouted") return false;
  return isWithinArrivalWindow(held.record.arrivalTimestampMs, now);
}

/**
 * retainHeld — 既存の保持分と新たに保つ分から、保持し続けるものと破棄の件数を導く（AC 11.14〜11.16・11.23）。
 *
 * **失効の判定を書き込みと再生の両方が同じ関数で通る。** 常設 Alarm を持たない設計ゆえ（AC 11.16——保留が
 * 無い間も DO を起こし続けるのは hibernation の規律に反する）、期限切れが落ちるのはキーを読むこの瞬間だけ
 * である。判定を二箇所に書けば、書き込みでは残るのに再生では消えるという食い違いが生まれる。
 *
 * **上限超過は古い側から落とす。** 保全と即時性が衝突する分岐では即時性を選ぶ（AC 9.15）——上限に達する
 * 状況では、まだ厨房で作られている可能性が高い新しい注文の方が価値がある。失効の破棄も古い側を落とすため、
 * 2 つの破棄が同じ向きを向く。
 *
 * `arriving` を末尾へ足すことで到着順が保たれる（同一 Store_Code 内の順序は下流の単調性による冪等が要る）。
 */
export function retainHeld(
  existing: readonly HeldRecord[],
  arriving: readonly HeldRecord[],
  now: number,
): HeldRetention {
  const alive = existing.filter((held) => !isHeldExpired(held, now));
  const merged = arriving.length === 0 ? alive : [...alive, ...arriving];
  const overflow = merged.length > HELD_RECORD_LIMIT ? merged.length - HELD_RECORD_LIMIT : 0;
  return {
    retained: overflow === 0 ? merged : merged.slice(overflow),
    expired: existing.length - alive.length,
    overflow,
  };
}
