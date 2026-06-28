// client/assignment.ts — 担当スコープの純粋導出。WS も DOM も触れない、ただの関数群。
// 担当範囲（ユニット集合）は「これ以上分解できない事実＝設定」であり、表示集合は
// そこからの純粋なフィルタ導出にすぎない。受信した全量 Timer を間引いて保持するのではなく、
// 保持は全量・表示は導出とする（要件12.2）。これは core の思想「導出値を状態に昇格させない」を
// クライアントへそのまま延長したものである。

import type { WireTimer } from "../shared/messages";

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
 * 受信した全量 Timer から担当スロットに属するものだけを射影する（表示用導出）。
 *
 * WireTimer を芯に持つ要素型 T を保ったまま絞り込む。ClientTimer（= WireTimer & { origin }）を
 * 渡せば origin タグを失わずに射影でき、呼び出し側が起源（未確定か否か）を導出できる。
 */
export function assignedTimers<T extends WireTimer>(
  allTimers: readonly T[],
  units: readonly number[],
): readonly T[] {
  const assigned = slotsOfUnits(units);
  return allTimers.filter((timer) => assigned.has(slotOf(timer.slotId)));
}
