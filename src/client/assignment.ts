// client/assignment.ts — 担当スコープの純粋導出。WS も DOM も触れない、ただの関数群。
// 担当範囲（ユニット集合）は「これ以上分解できない事実＝設定」であり、表示集合は
// そこからの純粋なフィルタ導出にすぎない。受信した全量 Timer を間引いて保持するのではなく、
// 保持は全量・表示は導出とする（要件12.2）。これは core の思想「導出値を状態に昇格させない」を
// クライアントへそのまま延長したものである。

import type { TimerFact } from "../domain/timer";

// ユニット 1 つが担当する連続スロット数。unit u は slot 6u..6u+5（要件12.5）。
const SLOTS_PER_UNIT = 6;

/**
 * slotId をスロット番号へ写す恒等対応。
 *
 * 本パイロットでは slotId をそのまま 0 始まりのスロット番号として解釈する（要件12.5）。
 * slotId が連番文字列でない運用へ将来移行する場合のみ写像を差し込むが、現時点では恒等で足りる。
 */
export function slotOf(slotId: string): number {
  return Number(slotId);
}

/** 担当ユニット集合 → 担当スロット番号の集合。unit u は slot 6u..6u+5。 */
export function slotsOfUnits(units: readonly number[]): Set<number> {
  const slots = new Set<number>();
  for (const unit of units) {
    const base = unit * SLOTS_PER_UNIT;
    for (let offset = 0; offset < SLOTS_PER_UNIT; offset++) {
      slots.add(base + offset);
    }
  }
  return slots;
}

/** あるスロットが担当範囲に含まれるか。slot ∈ slotsOfUnits(units) と一致する。 */
export function isAssigned(slot: number, units: readonly number[]): boolean {
  return slotsOfUnits(units).has(slot);
}

/**
 * 表示ユニット数の切り替えに伴う担当ユニット範囲の遷移（純粋関数）。
 *
 * 担当範囲は「長さ k の連続窓」 [b, b+k-1]（b＝左アンカー / k＝表示ユニット数）として捉える。viewport の
 * 縦横比が k を決め（1=縦長 / 2=横長）、本関数は左アンカーを「長さ k の窓が総数 N に収まる」可行区間
 * [0, N-k] へ射影し、そこから k 個の連番を返すだけ:
 *
 *     anchor = clamp(現在の左, 0, N - k)        窓 = [anchor, anchor+1, …, anchor+k-1]
 *
 * 展開（k:1→2）・収束（k:2→1）・右端クランプは、すべてこの一式から導かれる（特例分岐は無い）。
 * 例（総数 3・A=0/B=1/C=2）: A→AB, B→BC, C→BC（右端で anchor が N-k=1 に頭打ち）, AB→A, BC→B。
 * 総数より長い窓は k' = min(k, N) で畳むため、総数 1 でも 2 ユニット要求は自然に 1 ユニットへ縮む。同数は冪等。
 */
export function unitsForCount(
  current: readonly number[],
  count: 1 | 2,
  totalUnits: number,
): readonly number[] {
  const total = Math.max(1, totalUnits);
  // 表示できる窓長（総数を超えない）。
  const length = Math.min(count, total);
  // 現在の左アンカー（空なら 0 起点）。
  const left = current.length > 0 ? Math.min(...current) : 0;
  // 左アンカーを可行区間 [0, total - length] へ射影する（右端クランプはこの頭打ちに含まれる）。
  const anchor = Math.min(Math.max(left, 0), total - length);
  // そこから length 個の連番が担当窓。
  return Array.from({ length }, (_, offset) => anchor + offset);
}

/**
 * 受信した全量 Timer から担当スロットに属するものだけを射影する（表示用導出）。
 *
 * TimerFact を芯に持つ要素型 T を保ったまま絞り込む。ClientTimer（= TimerFact & { origin }）を
 * 渡せば origin タグを失わずに射影でき、呼び出し側が起源（未確定か否か）を導出できる。
 * 1 Timer は複数スロットを駆動しうるため、いずれか 1 つでも担当範囲に入れば担当対象とする（any-overlap）。
 */
export function assignedTimers<T extends TimerFact>(
  allTimers: readonly T[],
  units: readonly number[],
): readonly T[] {
  const assigned = slotsOfUnits(units);
  return allTimers.filter((timer) => timer.slotIds.some((slotId) => assigned.has(slotOf(slotId))));
}
