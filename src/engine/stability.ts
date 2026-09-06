// engine/stability.ts — 前回配信対象として確定した提案（Shown_Plan）の形と、確定計画からの組み立て。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// **Shown_Plan は導出値ではなく履歴の事実である（plan-stability 判断 1）。** state.ts は「導出値を状態に昇格させない」
// と定めるが、それは現在の状態から毎回導ける値についての規律である。前回 `Persist` に載せた提案は、時刻が進み
// 走行中が変われば現在の状態からはもう導けない——過去の出力であって、いま計算し直した確定計画のキャッシュではない。
// ゆえに `TimerState.shownPlan` に残し、次の計画がそれと比べる（Change_Cost・task 3）ときの相手にだけ使う。
// 確定計画そのものは引き続き毎回導く（AC 1.2）。
//
// 定義は「配信対象として永続確定した提案」であって「現場に見せた」ではない。Persist の後に Broadcast が続くが、
// 送信失敗や接続端末ゼロでも永続は成立するので、見せたことは保証できない（判断 1 のレビュー指摘）。

import type { CookRecommendation } from "../domain/messages";
import { itemKeyOf, type ItemKey } from "../domain/order";
import type { NonEmptyArray } from "../domain/timer";
import type { CookSchedule } from "./schedule";
import type { EpochMillis, SlotId } from "./types";

/**
 * ShownItem — 前回配信対象として確定した提案の 1 品目。
 *
 * 持つのは `Placement` の配置（`slotIds` / `startAt` / `serveAt` / `anchor`）と、群の所属だけである。
 *
 * **群の識別子（`CookRecommendation.group`）は持たない。** 識別子は snapshot 内で閉じ（lift-group-planning 判断 19）、
 * snapshot を跨いで文字列を比べる意味が無い。まとまりは「同じ群に在った相手の鍵」（`mates`）で持ち、次の計画で
 * 同じ 2 品目が別の群になったかを鍵の対応で読む（AC 1.5）。代表品目の鍵ではなく相手の鍵の列にするのは、代表が
 * 開始済みになると所属が壊れるためである（design 未決 1 の決定）。
 *
 * **Head の旗も持たない。** Head は時刻と走行中に依存するので、比較の時点で旧 Shown_Plan からも新しい計画からも
 * 同じ now・同じ Timer 集合で導く（判断 8）。ここに残すのは配置という履歴であり、いま守る対象はそこから導く。
 */
export interface ShownItem {
  /** POS 側の識別子。itemIndex との組で 1 品目を指す（Placement / PendingOrder と同じ鍵）。 */
  readonly externalOrderId: string;
  /** 同一オーダー内の品目連番。 */
  readonly itemIndex: number;
  /** 提案した釜（Placement.slotIds）。 */
  readonly slotIds: NonEmptyArray<SlotId>;
  /** 提案した開始時刻（Placement.startAt）。 */
  readonly startAt: EpochMillis;
  /** 提案した提供時刻（Placement.serveAt・上げ窓による延期後の値。錨とは違う）。 */
  readonly serveAt: EpochMillis;
  /** 合流先の走行中の実効 endTime（Placement.anchor）。合流でなければ null。 */
  readonly anchor: EpochMillis | null;
  /** 同じ群に在った品目の鍵（externalOrderId + itemIndex）。自分は含まない。対称に持つ。 */
  readonly mates: readonly ItemKey[];
}

/** Shown_Plan — 前回配信対象として確定した提案の全品目。空は「比較の相手なし」（Change_Cost 0）。 */
export type ShownPlan = readonly ShownItem[];

/** 比較の相手が無い Shown_Plan（初期状態・v11 以前からの移行）。 */
export const EMPTY_SHOWN_PLAN: ShownPlan = [];

/**
 * shownPlanOf — 確定計画と、それに対する `recommend` の出力から Shown_Plan を組む。
 *
 * **両方を取るのは、どちらか一方では埋まらない項目があるためである。** `serveAt` と `anchor` は配置（`Placement`）が持ち、
 * ワイヤの `CookRecommendation` は `serveAt` を運ばない。群の所属は `recommend` が付ける `group` にだけ在り、配置から
 * 群を引き直せば群の識別が二箇所に書かれる。`settle` は `committedSchedule` の結果と `recommend(committed)` の両方を
 * 持っているので、そこで組む（design Data Models の入力契約）。
 *
 * `mates` は同じ `group` の他の品目の鍵を、推奨の並び（計画順）で持つ。自分は含まない。順は決定的で、同じ入力から
 * 同じ Shown_Plan が出る（永続の往復と no-op の判定に揺れを持ち込まない）。
 *
 * 推奨は確定計画の全配置に付く（recommend.ts）ので、推奨を持たない配置は起きない。起きても落とさず、まとまりの
 * 無い単独の品目として残す——履歴の欠けは費用 0 に倒れるだけで、品目を失わせる理由にならない。
 */
export function shownPlanOf(
  schedule: CookSchedule,
  recommendations: readonly CookRecommendation[],
): ShownPlan {
  const groupByKey = new Map<ItemKey, string>();
  const membersByGroup = new Map<string, ItemKey[]>();
  for (const recommendation of recommendations) {
    const key = itemKeyOf(recommendation);
    groupByKey.set(key, recommendation.group);
    const members = membersByGroup.get(recommendation.group);
    if (members === undefined) membersByGroup.set(recommendation.group, [key]);
    else members.push(key);
  }
  return schedule.slices.flatMap((slice) =>
    slice.placements.map((placement) => {
      const key = itemKeyOf(placement);
      const group = groupByKey.get(key);
      const members = group === undefined ? [] : (membersByGroup.get(group) ?? []);
      return {
        externalOrderId: placement.externalOrderId,
        itemIndex: placement.itemIndex,
        slotIds: placement.slotIds,
        startAt: placement.startAt,
        serveAt: placement.serveAt,
        anchor: placement.anchor,
        mates: members.filter((mate) => mate !== key),
      };
    }),
  );
}
