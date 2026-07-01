// core/start.ts — タイマー開始の純粋変換（検証・容量検査・endTime 算出・Timer 追加）。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// crypto.randomUUID() という非決定を core に持ち込まない。新しい TimerId は Start イベントの
// 入力（newTimerId）として shell から渡され、core はそれをそのまま用いる。

import { BOIL_SECONDS_MIN, BOIL_SECONDS_MAX, MAX_TIMERS } from "../engine/types";
import type { SlotId, NoodleType, EpochMillis } from "../engine/types";
import type { TimerState } from "./state";
import { createTimer } from "./timer";
import type { Event } from "./event";
import type { Outcome } from "./effect";
import type { Rejection } from "./rejection";
import { settle } from "./settle";
import type { SyncParams } from "./sync";
import type { NonEmptyArray } from "../domain/timer";
import { isNonEmpty } from "../domain/timer";
import { DEFAULT_FIRMNESS } from "../domain/firmness";

/** Start イベントの本体。startTimer はこの形だけを受け取る（event.ts の唯一の出所を再利用）。 */
type StartEvent = Extract<Event, { type: "Start" }>;

/**
 * 開始入力を検証し、通った値だけをブランド型へ昇格する（要件1.5）。
 *
 * 検証を構築の一点に集約する。茹で時間が 1〜1800 秒の範囲外なら InvalidBoilSeconds、
 * slotId / noodleType が未定義（空）なら InvalidSlotOrNoodle を拒否として返す。
 * 拒否は例外ではなく戻り値で表し、握り潰された失敗を残さない。
 */
export function validateStart(input: {
  readonly slotIds: readonly string[];
  readonly noodleType: string;
  readonly boilSeconds: number;
}):
  | { readonly ok: true; readonly slotIds: NonEmptyArray<SlotId>; readonly noodleType: NoodleType; readonly boilSeconds: number }
  | { readonly ok: false; readonly rejection: Rejection } {
  // NaN / Infinity は比較が常に false で範囲検査をすり抜けるため、有限値であることを先に要求する。
  if (
    !Number.isFinite(input.boilSeconds) ||
    input.boilSeconds < BOIL_SECONDS_MIN ||
    input.boilSeconds > BOIL_SECONDS_MAX
  ) {
    return {
      ok: false,
      rejection: {
        code: "InvalidBoilSeconds",
        message: `茹で時間は ${BOIL_SECONDS_MIN}〜${BOIL_SECONDS_MAX} 秒の範囲で指定する`,
      },
    };
  }
  // 1 Timer は最低 1 スロットを駆動する（非空）。各スロット・noodleType の空文字も未定義とみなす。
  // isNonEmpty を通すことで、以降 input.slotIds は NonEmptyArray<string> として扱える（非空を型へ確立）。
  if (
    !isNonEmpty(input.slotIds) ||
    input.slotIds.some((slotId) => slotId.length === 0) ||
    input.noodleType.length === 0
  ) {
    return {
      ok: false,
      rejection: {
        code: "InvalidSlotOrNoodle",
        message: "slotIds は 1 件以上の非空スロットを要し、noodleType は未定義にできない",
      },
    };
  }
  return {
    ok: true,
    slotIds: input.slotIds as NonEmptyArray<SlotId>,
    noodleType: input.noodleType as NoodleType,
    boilSeconds: input.boilSeconds,
  };
}

/**
 * タイマー開始の状態遷移。検証 → 容量検査 → endTime 算出 → Timer 追加 → 全体再同期（要件1.1 / 1.2 / 3.1 / 3.8・本機能の要件7.1）。
 *
 * 追加後の running 集合全体を settle が synchronize で再同期し、Effect 列を組む。成功時の Effect 列は
 * [Persist, SetAlarm, Broadcast(snapshot)]（snapshot は他 Timer の調整変化も含む全量・実効 endTime を載せる
 * 唯一の権威表現）。Persist を先頭に置くのは SSOT 規律の表明。
 * 拒否時（InvalidBoilSeconds / InvalidSlotOrNoodle / CapacityExceeded）は状態を一切変更せず Rejection を返す。
 */
export function startTimer(state: TimerState, args: StartEvent, params: SyncParams): Outcome {
  const validated = validateStart(args);
  if (!validated.ok) {
    return { ok: false, rejection: validated.rejection };
  }
  // 走行中が上限に達していればこれ以上増やさない（要件3.8）。拒否時は状態不変。
  if (state.timers.length >= MAX_TIMERS) {
    return {
      ok: false,
      rejection: {
        code: "CapacityExceeded",
        message: `走行中の Timer は最大 ${MAX_TIMERS} 件`,
      },
    };
  }
  // endTime は「操作受信時刻 + 茹で時間」の絶対エポックミリ秒（要件1.2）。startTime は操作受信時刻（事実）。
  // 残り秒・進捗・総時間は持たず、この2つの時刻事実から導出する。
  const endTime = (args.now + validated.boilSeconds * 1000) as EpochMillis;
  const timer = createTimer({
    id: args.newTimerId,
    slotIds: validated.slotIds,
    noodleType: validated.noodleType,
    firmness: DEFAULT_FIRMNESS,
    startTime: args.now,
    endTime,
    seq: state.nextSeq,
  });
  // 基底の集合変更（Timer を adjustment=0 で追加）。同期・no-op 検出・Effect 列組み立ては settle に委ねる。
  const moved: TimerState = {
    timers: [...state.timers, timer],
    nextSeq: state.nextSeq + 1,
  };
  return settle(state, moved, params, args.now);
}
