// engine/timer.ts — 不正状態を構築不能にする Timer 型と smart constructor。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import type { EpochMillis, SlotId, NoodleType, TimerId } from "./types";
import type { TimerFact, NonEmptyArray } from "../domain/timer";

/**
 * Sequenced — engine だけが持つ登録順の事実（ワイヤには出ない）。
 *
 * seq は同一 endTime のときのタイブレークに用いる全順序の根拠（要件3.2）。engine の
 * earliestEndTime / byEndTimeThenSeq だけが読み、shell もクライアントも参照しない。
 * engine 専用の基底ゆえ定義も engine に置く（共有契約 domain には置かない・audience に従う）。
 */
export interface Sequenced {
  /** 登録順。同一 endTime のタイブレーク（要件3.2 / 2系）。 */
  readonly seq: number;
}

/**
 * Timer — アクティブな茹でタイマー一件。事実の芯（ブランド化）＋ engine 専用の連番。
 *
 * 共有契約の芯 TimerFact（domain/timer.ts）をブランド型で具体化し、engine 専用の Sequenced を
 * 多重継承で合成する。endTime を持たない Timer や slotId を持たない Timer は型として存在しえない
 * （ブランド型と smart constructor が担保）。
 * 残り秒は状態として持たない。保持するのは絶対終了時刻 endTime という「事実」だけ。
 */
export interface Timer extends TimerFact<TimerId, SlotId, NoodleType, EpochMillis>, Sequenced {}

/**
 * Timer を構築できる唯一の経路。検証に通った入力（ブランド型）からのみ Timer が生まれる。
 *
 * 入力はすべてブランド型なので、ここに到達する時点で各値は検証済みであることが型で保証される。
 * 構築の一点に生成を集約し、構築後は常に正当であることを型が担保する。
 */
export function createTimer(input: {
  id: TimerId;
  slotIds: NonEmptyArray<SlotId>;
  noodleType: NoodleType;
  endTime: EpochMillis;
  seq: number;
}): Timer {
  return {
    id: input.id,
    slotIds: input.slotIds,
    noodleType: input.noodleType,
    endTime: input.endTime,
    seq: input.seq,
  };
}
