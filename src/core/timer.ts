// core/timer.ts — 不正状態を構築不能にする Timer 型と smart constructor。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import type { EpochMillis, SlotId, NoodleType, TimerId } from "./types";

/**
 * Timer — アクティブな茹でタイマー一件。
 *
 * 全フィールドが必須・readonly。endTime を持たない Timer や slotId を持たない Timer は
 * 型として存在しえない（バリデーションで弾く前に、構築不能にする）。
 * 残り秒は状態として持たない。保持するのは絶対終了時刻 endTime という「事実」だけ。
 */
export interface Timer {
  /** 安定した一意識別子。キャンセルとブロードキャストの宛先。 */
  readonly id: TimerId;
  /** 所属するスロット（釜）。Slot に属さない Timer は作れない。 */
  readonly slotId: SlotId;
  /** 麺の種類。 */
  readonly noodleType: NoodleType;
  /** 絶対終了時刻（事実）。これを欠いた Timer は型として存在しない。 */
  readonly endTime: EpochMillis;
  /** 登録順。同一 endTime のタイブレーク（要件3.2 / 2系）。 */
  readonly seq: number;
}

/**
 * Timer を構築できる唯一の経路。検証に通った入力（ブランド型）からのみ Timer が生まれる。
 *
 * 入力はすべてブランド型なので、ここに到達する時点で各値は検証済みであることが型で保証される。
 * 構築の一点に生成を集約し、構築後は常に正当であることを型が担保する。
 */
export function createTimer(input: {
  id: TimerId;
  slotId: SlotId;
  noodleType: NoodleType;
  endTime: EpochMillis;
  seq: number;
}): Timer {
  return {
    id: input.id,
    slotId: input.slotId,
    noodleType: input.noodleType,
    endTime: input.endTime,
    seq: input.seq,
  };
}
