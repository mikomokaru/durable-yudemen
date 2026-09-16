// experiments/cpsat-workers/quality/bill-wait.ts — **伝票ごとの待ち**で計画を採点する（2026-09-13）。
//
// いまの採点（`scoreSchedule`）は 3 つの項に割れている——杯ごとの待ち・群の遅れ・注文内の同期。
// **群＝伝票になったので下の 2 つは同じことを 2 回言っており**、「伝票の待ち＝最後の 1 杯が出るまで」
// と定めれば 1 つに畳める（ユーザー提案・2026-09-13）。
//
// ここはその物差しを**測るためだけ**に置く。engine の採点は何も変えていない——**変える価値が
// あるかを先に数字で見る**ためである。
//
// 伝票の鍵は `tableKeyOf`（engine/project.ts）ただ一つを通す。卓が分かればその卓、分からなければ
// 伝票ごと——写しを作らない。

import { tableKeyOf } from "../../../src/engine/project";
import type { OrderItem } from "../../../src/domain/order";
import type { PlanSlice } from "../../../src/engine/schedule";

/** 1 伝票ぶんの観測値。 */
interface Bill {
  /** 置かれた杯数。 */
  readonly bowls: number;
  /** 待ち時間（ミリ秒）＝**最後の 1 杯の提供時刻** − 伝票の最早到着。 */
  readonly wait: number;
  /** 伝票の内側の広がり（ミリ秒）＝最遅の提供 − 最早の提供。1 杯なら 0。 */
  readonly spread: number;
  /** 最遅の提供時刻（順序の逆転を数えるため）。 */
  readonly last: number;
  /** 伝票の最早到着（同上）。 */
  readonly arrival: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function summarise(bills: readonly Bill[]) {
  const waits = bills.map((bill) => bill.wait).sort((a, z) => a - z);
  return {
    bills: bills.length,
    p50: Math.round(percentile(waits, 0.5) / 1000),
    p90: Math.round(percentile(waits, 0.9) / 1000),
  };
}

/**
 * billWait — 計画を伝票ごとの待ちで採点する。
 *
 * **2 つの数え方を両方返す。** `alpha0` は「お客 1 組は 1 回待つ」（伝票を 1 と数える）、
 * `alpha1` は杯数で重みを付ける。**伝票間の優先度を変えるのは `alpha0` のほうである**
 * ——現行の採点（杯ごとの総和）は杯数に比例しており、`alpha1` はそれと同じ重み付けになる。
 *
 * 逆転は**伝票の単位**で数える——先に注文した伝票が、後の伝票より遅く出そろう組の数。
 * 杯ごとの逆転（E7）とは別の量である。
 */
export function billWait(slices: readonly PlanSlice[], items: readonly OrderItem[]) {
  const arrivals = new Map<string, number>();
  for (const item of items) {
    const key = tableKeyOf(item);
    const at = Number(item.arrivalTime);
    const known = arrivals.get(key);
    if (known === undefined || at < known) arrivals.set(key, at);
  }
  const bills: Bill[] = [];
  for (const slice of slices) {
    if (slice.placements.length === 0) continue;
    const serves = slice.placements.map((placement) => Number(placement.serveAt));
    const arrival = arrivals.get(slice.tableKey);
    // 計画対象に無い卓は採点しない（到着時刻が引けない＝待ちが定義できない）。
    if (arrival === undefined) continue;
    const last = Math.max(...serves);
    bills.push({
      bowls: slice.placements.length,
      wait: last - arrival,
      spread: last - Math.min(...serves),
      last,
      arrival,
    });
  }
  let inversions = 0;
  for (let i = 0; i < bills.length; i += 1)
    for (let j = i + 1; j < bills.length; j += 1) {
      const a = bills[i]!;
      const z = bills[j]!;
      if (a.arrival < z.arrival && a.last > z.last) inversions += 1;
      if (z.arrival < a.arrival && z.last > a.last) inversions += 1;
    }
  const seconds = (value: number) => Math.round(value / 1000);
  // **待ちの分布を見る（2026-09-15）。** 逆転の数だけでは「1 つが多数に追い越されて置き去りに
  // なった」を捉えられない——最古の伝票が救われたかどうかは、順序の違反数ではなく待ちで見る。
  const waits = bills.map((bill) => bill.wait).sort((a, z) => a - z);
  const oldest = [...bills].sort((a, z) => a.arrival - z.arrival).slice(0, 3);
  return {
    bills: bills.length,
    bowls: bills.reduce((sum, bill) => sum + bill.bowls, 0),
    /** **最長待ち**（秒）。置き去りにされた 1 件を捉える。 */
    maxWait: waits.length === 0 ? 0 : Math.round(waits.at(-1)! / 1000),
    /** 待ちの上位分位（秒）。 */
    p90Wait: Math.round(percentile(waits, 0.9) / 1000),
    p99Wait: Math.round(percentile(waits, 0.99) / 1000),
    /** **最古の 3 伝票の待ち**（秒）。「だいぶ待たせているオーダー」がどうなったかを直接見る。 */
    oldestWaits: oldest.map((bill) => Math.round(bill.wait / 1000)),
    /** Σ 待ち（秒）。伝票を 1 と数える。 */
    alpha0: seconds(bills.reduce((sum, bill) => sum + bill.wait, 0)),
    /** Σ 杯数 × 待ち（秒）。現行の採点と同じ重み付け。 */
    alpha1: seconds(bills.reduce((sum, bill) => sum + bill.bowls * bill.wait, 0)),
    /** Σ 伝票の内側の広がり（秒）。B 案が値段を付ける対象。 */
    spread: seconds(bills.reduce((sum, bill) => sum + bill.spread, 0)),
    /** 1 杯の伝票の待ち（秒）。 */
    solo: summarise(bills.filter((bill) => bill.bowls === 1)),
    /** 2 杯以上の伝票の待ち（秒）。**グループが不利になっていないかを見る。** */
    party: summarise(bills.filter((bill) => bill.bowls >= 2)),
    /** 伝票の単位の逆転（先に注文した伝票が後から出そろった組の数）。 */
    inversions,
  };
}
