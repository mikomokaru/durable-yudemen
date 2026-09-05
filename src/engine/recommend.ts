// engine/recommend.ts — 確定計画から開始推奨（Cook_Recommendation）を導出する唯一の関数。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// **この関数が Effect を返さないことが「推奨は Alarm を張らない」の構造的な保証である**（AC 8.2 / 11.4）。
// 推奨開始時刻の到来で Timer を自動開始しないという要件は、時刻起動の機構を「使わない」と決めることでは
// 守れない——書けてしまう場所があれば、いつか書かれる。返り値の型に Effect が無ければ、Alarm を張る
// 経路はここに存在し得ない。Alarm を決めるのは alarm.ts の nextAlarmEffect ただ一つで、その入力は
// 走行中 Timer の集合だけである（推奨も Pending_Order もその入力に現れない・検証は Property 13）。
//
// 導出値ゆえ永続しない。正本は採用済み PlanSlice 列と現在の Pending_Order / Timer 集合であり、
// 推奨はそこから committedSchedule を経て毎回導かれる（状態に昇格させれば計画と推奨の二つの真実が生まれる）。

import type { CookRecommendation } from "../domain/messages";
import type { NoodlePreset } from "../domain/store";
import type { PendingOrder } from "../domain/order";
import type { ScheduleParams } from "./objective";
import { tableMembers } from "./project";
import { boilMillisOf, joinedAnchor, refersTo, type CookSchedule } from "./schedule";
import type { Timer } from "./timer";
import type { EpochMillis } from "./types";

/**
 * recommend — 確定計画から「次に開始すべき品目・slot・開始タイミング」を導出する（AC 8.1）。
 *
 * **確定計画に現れる全品目の推奨を返す。** 絞り込みは client が担う（design の client 節）。3 つの記述が
 * この解釈を一意に定めている。
 *   - 「`recommendations` を担当スロット範囲で絞って提示する」 — 絞るのは client であり、サーバは全量を配る。
 *     端末ごとに違う内容を配れば、全端末で同一の推奨を反映するという AC 8.5 が破れる。
 *   - 「計画対象外（65 件目以降）も表示するが推奨は付かない」 — 計画対象の境界は committedSchedule が
 *     既に引いている（planTargets）。ここで件数を絞り直せば、上限の定義が二箇所になる。
 *   - 「過ぎた `startAt` は次回再評価まで過去時刻のまま表示される」 — 過去の推奨を落とさない。
 *
 * **`now` を引数に取らない（design の署名からの変更点）。** design は `(committed, now)` だが、上の 3 つ目が
 * now による絞り込みも startAt の clamp も禁じており、他に now の使い道が無い。使わない引数は「時刻に
 * 依存する」という嘘をつく。過去の startAt は「人が推奨時刻に開始しなかった」という事実で、その扱いは
 * commit.ts の陳腐化判定（hasLapsedStart）が既に持っている——時刻の関心事は次の状態変化で一度だけ働く。
 *
 * **計画順を保つ。** slices の並びは Acceptance_Gate が接頭辞を切る順序＝計画上の優先順であり、
 * startAt からは復元できない（釜の空きによって後方の一片が先に始まることは起こり得る）。startAt 昇順で
 * 並べ直せばその情報が失われる一方、client は startAt を受け取っているので時刻順の並べ替えは自分でできる。
 * 復元できない順序を捨てない。
 *
 * **群と合流の状態をここで決める（判断 19）。** 一片の中で、走行中の仲間 A から h_i 以内（|serveAt − A| ≤ h_i・前後どちらでも）の配置は
 * 「合流」で、同じ A に続くものが一つの群（`anchor = A`）。それ以外は serveAt の等しい配置ごとに一つの群
 * （`anchor = null`）。卓を
 * 持たない品目は一片が 1 品なので 1 品 1 群になる。識別子は snapshot 内で閉じ、永続的な履歴を持たない。
 * client はこれを読むだけで、卓・serveAt・許容幅のいずれからも群を逆算しない（`lift-group-display` 判断 20）。
 *
 * **射影をここに閉じる。** engine の `Placement`（ブランド型・NonEmptyArray）からワイヤの
 * `CookRecommendation`（生プリミティブ）への変換はこの関数の本体そのものである。project.ts の
 * 「射影はここ一箇所に集約する」は同じ射影が二度書かれることを禁じる規律で、そこに集約された
 * `toWireTimer` は実効 endTime という**導出値の算出**を含むため二度書けば二つの真実になった。
 * こちらは導出を一切含まないブランドの落としだけで、しかも CookRecommendation を作る場所は
 * この関数以外に無い。一度しか現れない射影を別ファイルへ切り出せば、「推奨とは何か」が二箇所に散る。
 */
export function recommend(
  committed: CookSchedule,
  pending: readonly PendingOrder[],
  running: readonly Timer[],
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): readonly CookRecommendation[] {
  // 群と合流は確定計画（自前解・採用済み外部解とも）から決める（lift-group-planning 判断 19・ADR-0008）。
  // 走行中の錨は配置・合成・ゲートと同じ成員表から引く。
  const members = tableMembers(running);
  return committed.slices.flatMap((slice, index) => {
    const siblings = members.get(slice.tableKey);
    return slice.placements.map((placement) => {
      const order = pending.find((candidate) => refersTo(placement, candidate));
      const boilMillis = order === undefined ? null : boilMillisOf(order, presets);
      const anchor: EpochMillis | null =
        siblings === undefined || boilMillis === null
          ? null
          : joinedAnchor(placement, siblings, boilMillis, params);
      return {
        externalOrderId: placement.externalOrderId,
        itemIndex: placement.itemIndex,
        // ブランド型（SlotId / EpochMillis）を生プリミティブへ落とすだけ。非空の保証は JSON を跨げないため
        // 型からも落ちる（受け手が境界で isNonEmpty を通して再確立する・domain/messages.ts の規律）。
        slotIds: placement.slotIds,
        startAt: placement.startAt,
        // 群の識別は snapshot 内で閉じる：一片の位置と、合流なら「錨」、それ以外は serveAt の等しい batch。
        group: anchor !== null ? `${index}:anchor:${anchor}` : `${index}:${placement.serveAt}`,
        anchor,
      };
    });
  });
}
