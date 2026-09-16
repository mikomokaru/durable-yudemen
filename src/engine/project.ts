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
 *
 * 品目への参照（`orderItem`）は鍵だけを写す（order-lifecycle AC 4.4）——`tableId` は開始時点の卓（計画の錨の出所・
 * engine 専用）で、client は品目を参照で引いて最新の卓を読む（判断 7）。null はアドホック・v12 由来。
 */
export function toWireTimer(timer: Timer): TimerFact {
  return {
    id: timer.id,
    slotIds: timer.slotIds,
    noodleType: timer.noodleType,
    firmness: timer.firmness,
    startTime: timer.startTime,
    endTime: adjustedEndTime(timer),
    orderItem:
      timer.orderItem === null
        ? null
        : {
            externalOrderId: timer.orderItem.externalOrderId,
            itemIndex: timer.orderItem.itemIndex,
          },
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

/**
 * Table_Group の識別子。tableId を持たない品目は**同じ伝票（`externalOrderId`）ごと**のグループへ写す。
 *
 * **落とし先を品目ごとから伝票ごとへ変えた（2026-09-13）。** 上流の POS は卓が特定できない受注に
 * 既定値を入れて送るので（`toTableId`）、卓なしは例外ではなく**多数派**である。品目ごとに割ると、
 * 同じ 1 枚の伝票に載った 2 杯——同じお客の 2 杯——が別の群になり、一緒に上げる理由が費用から
 * 消える。実データでは **2 杯以上の注文が 27.1%、そこに載る杯が全体の 45.9%** であり、
 * 半分近くの杯が同期の対象から外れることになる。
 *
 * 伝票は「同じお客のひとまとまり」を表す唯一の申告値である。卓が分かるならそちらが優先されるのは
 * 変わらない——同じ卓に相席・追加注文が来れば、伝票が違っても一緒に上げたいからである。
 *
 * 単独キーの区切りに NUL を使う。tableId は任意の非空文字列を採れるため、単独キーが本物の卓 id と
 * 衝突すれば、卓に紐づかない品目が黙って一つの卓へ束ねられる（objective.ts の品目鍵と同じ規律）。
 * 上の成員表の鍵（tableId）と同じ文字列規則で照合するので、卓なしの単独キーは表に当たらない。
 *
 * **ここに置く（plan-stability design Component 7・startable-placement task 3′.2）。** 計画（schedule.ts）が一片の鍵に、
 * 変更費用（stability.ts）が旧 Shown_Plan を一片に組み直すときに、復元（retain）が Shown_Plan を一片の列に戻すときに、
 * 同じ鍵を読む。schedule.ts は stability.ts を読む（変更費用の差分）ので、stability.ts が schedule.ts を値で読めば
 * 循環になる——茹で時間の導出を boil.ts に置いたのと同じ理由で、鍵の規則は両者が読める成員表の隣に置く。
 * 読む側の入口は schedule.ts の再公開でもよい。
 */
export function tableKeyOf(order: {
  readonly externalOrderId: string;
  readonly itemIndex: number;
  readonly tableId: string | null;
}): string {
  return order.tableId ?? `\u0000${order.externalOrderId}`;
}
