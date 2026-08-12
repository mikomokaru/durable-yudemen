// solver/request.ts — 往路（DO → Solver_Worker）に載る値の形。純粋な型だけを置く。
// cloudflare:workers にも storage にも触れない（このファイルに実行時のコードは無い）。
//
// **契約は受け手が定める。** shell は `RequestPlan` Effect の内容へ storeId を添えてこの形を組み、
// Solver_Worker はこの形だけを読む。送り手側（src/shell）に置けば「外へ何を送るか」が送り手の内部事情に
// 見え、受け手が何を前提にしているかがコードから読めなくなる。
//
// **engine の型をそのまま運ぶ。** `running`（engine の Timer）と `params` は engine / domain が定めた形で、
// ここで生表現へ落とし直さない——落とすには同じフィールドの列挙をもう一箇所に書くことになり、
// 「角度を変える手続き」が一つ増える。JSON を跨ぐとブランドと非空の保証は失われるが、この経路の送り手は
// 自分自身の shell であり、Service binding の外からは到達しない（`applyProjection` が「到達＝計算済みの
// 健全な投影ゆえ再検証しない」と置いているのと同じ判断）。外部が主張する値を検証するのは**復路**の側で、
// `toCookSchedule`（engine/schedule.ts）がその唯一の関門である。

import type { ScheduleParams } from "../engine/objective";
import type { Timer } from "../engine/timer";
import type { PendingOrder } from "../domain/order";
import type { NoodlePreset } from "../domain/store";

/**
 * PlanRequest — Solver_Worker へ渡す 1 回の計画要求（design「経路」の往路のボディ）。
 *
 * Effect の `RequestPlan` とは概念が別である。あちらは「要求するという意思」を engine が記述したもので、
 * こちらは往路に載る値の形である。ゆえに `storeId` を持つ——engine は storeId を知らず、shell が送出時に
 * 付ける（構造の主権）。復路の宛先はこの 1 値だけで決まる。
 */
export interface PlanRequest {
  /** 要求元の店舗。復路 `deliverPlan` の宛先（`idFromName` の引数）はこれただ一つで決まる。 */
  readonly storeId: string;
  /** 計画の対象集合（計画対象＝待ち行列の先頭 PLAN_TARGET_LIMIT 件）。 */
  readonly pending: readonly PendingOrder[];
  /** 釜を占める Timer。slot 解放表の所与（送り手と同じ集合から表を組むことが feasibility の噛み合いの根拠）。 */
  readonly running: readonly Timer[];
  /** 重み・許容幅・レイアウトの 8 値。 */
  readonly params: ScheduleParams;
  /**
   * 麺種ごとの硬さ別茹で時間。`startAt` と `serveAt` を結ぶ唯一の値ゆえ、計画を作る側は必ず要する。
   *
   * `params` に混ぜないのは engine 自身の分け方に揃えるためである（`baselineSchedule` は採点パラメータと
   * プリセットを別の引数で受ける——採点は茹で時間を要さず、算出だけが要する）。
   */
  readonly noodlePresets: readonly NoodlePreset[];
  /**
   * 要求時点の Input_Fingerprint。この要求がどの入力に対するものかの同定に用いる。
   *
   * 生の number で運ぶ（engine の `InputDigest` ブランドは JSON を跨げない）。Solver_Worker はこの値を
   * 解釈しない——採否は DO 側のゲートが決めるため、外部が指紋で何かを判断する必要がない。
   */
  readonly digest: number;
}
