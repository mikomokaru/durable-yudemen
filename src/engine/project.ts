// engine/project.ts — engine の Timer を「他が読める形」へ落とす射影の唯一の置き場。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// 射影はここ一箇所に集約する（重複の根絶）。seq / boiledAt / adjustment は engine 専用の事実ゆえ
// 削ぎ落とし、endTime には実効値（オリジナル + adjustment）を畳んで載せる。実効 endTime の算出が
// 二度書かれれば二つの真実になるため、start.ts / adjust.ts / shell / 計画はこの関数を import して用いる。
// 走行中 Timer から卓ごとの提供時刻を引く表（tableMembers）も同じ理由でここに在る——実効 endTime の
// 出所と同じファイルに置けば、endTime + adjustment を二度書く余地が消える。

import type { EpochMillis } from "./types";
import type { Timer } from "./timer";
import { isNonEmpty, type NonEmptyArray, type TimerFact } from "../domain/timer";

/**
 * 実効茹で上がり時刻（Adjusted_Boil_Time）。オリジナル endTime に Adjustment を載せた事実。
 *
 * オリジナル endTime（不変アンカー）は書き換えず、符号付き adjustment を足して実効値を導出する。
 * adjustment が 0 のとき実効値はオリジナル endTime に等しい。
 */
export function adjustedEndTime(timer: Timer): EpochMillis {
  return (timer.endTime + timer.adjustment) as EpochMillis;
}

/**
 * engine の Timer を wire の TimerFact へ射影する唯一の関数。
 *
 * seq / boiledAt / adjustment（いずれも engine 専用）を削ぎ、endTime に実効値（= endTime + adjustment）を
 * 載せる。client は調整の存在を知らず、受け取った endTime から残り時間・boiled を今までどおり導出する。
 */
export function toWireTimer(timer: Timer): TimerFact {
  return {
    id: timer.id,
    slotIds: timer.slotIds,
    noodleType: timer.noodleType,
    firmness: timer.firmness,
    startTime: timer.startTime,
    endTime: adjustedEndTime(timer),
  };
}

/**
 * TableMembers — 卓ごとの走行中の仲間の提供時刻（実効 endTime）。鍵は tableId、値は昇順・非空。
 *
 * 解放表（initialRelease・「その釜がいつ空くか」）と同じ資格の第二の表で、こちらは「その卓がいつ上がるか」。
 * 状態ではない——running からの導出値であり、毎回作って捨てる。配置（baselineSchedule）と採点
 * （scoreSchedule）は Timer ではなくこの表だけを読む。
 */
export type TableMembers = ReadonlyMap<string, NonEmptyArray<EpochMillis>>;

/**
 * 走行中 Timer から卓ごとの提供時刻の表を作る（lift-group-planning・ADR-0003）。
 *
 * tableId を持たない Timer（アドホック麺茹で・卓なしの品目）は表に現れない。鍵が無いだけで、除外の条件は
 * 書かない。単独キー（\u0000 始まり）は非空の tableId と決して一致しないので、卓なし同士が束ねられる経路も
 * 無い（照合は文字列の一致という一つの規則から従う）。
 *
 * 値を昇順に並べるのは決定性のため——Map の走査順は挿入順＝running の並びに依存し、running の並びは状態の
 * 履歴に依存する。錨は最大値ひとつだが、採点は各成員の遅れを足すので列の全体が要る。
 */
export function tableMembers(running: readonly Timer[]): TableMembers {
  const members = new Map<string, EpochMillis[]>();
  for (const timer of running) {
    const tableId = timer.orderItem?.tableId;
    if (tableId === undefined || tableId === null) continue;
    const ends = members.get(tableId);
    if (ends) ends.push(adjustedEndTime(timer));
    else members.set(tableId, [adjustedEndTime(timer)]);
  }
  const sorted = new Map<string, NonEmptyArray<EpochMillis>>();
  for (const [tableId, ends] of members) {
    ends.sort((a, b) => a - b);
    // 非空は構成から従う（要素を 1 つ入れたときにだけ鍵を作る）。型へ載せるための関門。
    if (isNonEmpty(ends)) sorted.set(tableId, ends);
  }
  return sorted;
}
