// engine/boil.ts — 茹で時間と合流の窓 h_i の導出。cloudflare:workers にも storage にも触れない純粋モジュール。
//
// schedule.ts から切り出したのは、自前解（schedule.ts）が変更費用（stability.ts）を局所比較に読み、変更費用が
// 茹で時間と窓を読むためである（plan-stability Component 5）。両方を schedule.ts に置いたままでは import が
// 循環する。ここに置くのは「品目の茹で時間はどこから引くか」と「合流の窓はどう決まるか」の 2 つの導出だけで、
// 配置・採点・推奨はそれぞれの場所に残る。schedule.ts は同名で再輸出し、読む側の入口は変えない。

import type { OrderItem } from "../domain/order";
import type { NoodlePreset } from "../domain/store";
import type { ScheduleParams } from "./objective";

/**
 * 品目の茹で時間（ミリ秒）。麺種がプリセットに無ければ null。
 *
 * 茹で時間は OrderItem が持たない導出値（noodleType × firmness）。配置・ゲート・推奨の射影・変更費用が同じ引き方を
 * 読む唯一の場所（二度書けば二つの真実になる）。
 */
export function boilMillisOf(order: OrderItem, presets: readonly NoodlePreset[]): number | null {
  const preset = presets.find((candidate) => candidate.noodleType === order.noodleType);
  if (preset === undefined) return null;
  return preset.boilSeconds[order.firmness] * 1000;
}

/**
 * 合流の窓 h_i（ミリ秒）——茹で時間 × toleranceRatio / 100（lift-group-planning 判断 18・ADR-0008）。
 *
 * 走行中の錨に `earliest ≤ 錨 + h_i` で届く品目を「同じ投入作業として続ける」と見なす。Boil_Sync の許容調整
 * 割合と同じ既存の品質許容幅であって新しい設定ではないが、**Boil_Sync が同時に揃える保証ではない**——あちらは
 * 個々の基底 endTime から窓を作り、共通部分と arms のセット分割を見る。計画の群と Sync_Set は別の概念である。
 * 変更費用（stability.ts）は同じ窓の内側の時刻の移動を数えない（plan-stability 判断 2 (c)）。
 */
export function joinWindowMillis(boilMillis: number, params: ScheduleParams): number {
  return Math.floor((boilMillis * params.toleranceRatio) / 100);
}
