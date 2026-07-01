// engine/timer.ts — 不正状態を構築不能にする Timer 型と smart constructor。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import type { EpochMillis, SlotId, NoodleType, TimerId } from "./types";
import type { TimerFact, NonEmptyArray } from "../domain/timer";
import type { Firmness } from "../domain/firmness";

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
 * Boilable — engine だけが持つ「発火を記録した事実」（ワイヤには出ない）。
 *
 * boiledAt は Alarm 発火で running → boiled へ遷移した時刻。null は走行中（running）を表す。
 * boiled な Timer は除去されず、ユーザーの明示完了（Complete）まで残る。Alarm の張り直しは
 * running（boiledAt === null）の最早だけを対象にし、過去時刻 Alarm の無限再発火を構造的に断つ。
 * クライアントは boiled を endTime ≤ now から導出するため、この事実はワイヤに乗せず engine 内部に閉じる
 * （timer-model.md: 片側専用の関心事は共有契約 domain に混ぜない）。
 */
export interface Boilable {
  /** 発火時刻。null は running（未発火）。非 null は boiled（明示完了待ち）。 */
  readonly boiledAt: EpochMillis | null;
}

/**
 * Adjusted — engine だけが持つ「同期のための符号付き調整」（ワイヤには出ない）。
 *
 * adjustment はオリジナル endTime に対するミリ秒オフセット（初期値 0・負=早める / 正=遅らせる）。
 * 近接した複数の茹で上がりを共通時刻へそろえる Boil_Sync（synchronize）が、この値を全体置換で書き込む。
 * 実効茹で上がり時刻 Adjusted_Boil_Time = endTime + adjustment は射影（project.ts）でのみ現れ、
 * オリジナル endTime（不変アンカー）自体は書き換えない。|adjustment| ≤ h_i を synchronize が保証する。
 * seq / boiledAt と同じく engine 専用の関心事ゆえ domain には置かない（共有契約 TimerFact を god type にしない）。
 */
export interface Adjusted {
  /** オリジナル endTime に対する符号付きミリ秒オフセット。初期値 0。 */
  readonly adjustment: number;
}

/**
 * Timer — アクティブな茹でタイマー一件。事実の芯（ブランド化）＋ engine 専用の連番・発火事実・調整。
 *
 * 共有契約の芯 TimerFact（domain/timer.ts）をブランド型で具体化し、engine 専用の Sequenced /
 * Boilable / Adjusted を多重継承で合成する。endTime を持たない Timer や slotId を持たない Timer は型として
 * 存在しえない（ブランド型と smart constructor が担保）。
 * 残り秒は状態として持たない。保持するのは絶対終了時刻 endTime という「事実」だけ。
 */
export interface Timer extends TimerFact<TimerId, SlotId, NoodleType, EpochMillis>, Sequenced, Boilable, Adjusted {}

/**
 * Timer を構築できる唯一の経路。検証に通った入力（ブランド型）からのみ Timer が生まれる。
 *
 * 入力はすべてブランド型なので、ここに到達する時点で各値は検証済みであることが型で保証される。
 * 構築の一点に生成を集約し、構築後は常に正当であることを型が担保する。
 * boiledAt は省略時 null（走行中で生まれる）。発火時に fireDueTimers が非 null へ写す。
 * adjustment は省略時 0（未調整で生まれる）。synchronize が全体置換で書き換える。
 */
export function createTimer(input: {
  id: TimerId;
  slotIds: NonEmptyArray<SlotId>;
  noodleType: NoodleType;
  firmness: Firmness;
  startTime: EpochMillis;
  endTime: EpochMillis;
  seq: number;
  boiledAt?: EpochMillis | null;
  adjustment?: number;
}): Timer {
  return {
    id: input.id,
    slotIds: input.slotIds,
    noodleType: input.noodleType,
    firmness: input.firmness,
    startTime: input.startTime,
    endTime: input.endTime,
    seq: input.seq,
    boiledAt: input.boiledAt ?? null,
    adjustment: input.adjustment ?? 0,
  };
}
