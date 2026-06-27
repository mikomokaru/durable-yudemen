// core/start.ts — タイマー開始の純粋変換（検証・容量検査・endTime 算出・Timer 追加）。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// crypto.randomUUID() という非決定を core に持ち込まない。新しい TimerId は Start イベントの
// 入力（newTimerId）として shell から渡され、core はそれをそのまま用いる。

import { BOIL_SECONDS_MIN, BOIL_SECONDS_MAX, MAX_TIMERS } from "./types";
import type { SlotId, NoodleType, EpochMillis } from "./types";
import type { TimerState } from "./state";
import type { Timer } from "./timer";
import { createTimer } from "./timer";
import type { Event } from "./event";
import type { Outcome, Effect } from "./effect";
import type { Rejection } from "./rejection";
import { toSnapshot } from "./snapshot";
import { nextAlarmEffect } from "./alarm";
import type { ServerMessage, WireTimer } from "../shared/messages";

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
  readonly slotId: string;
  readonly noodleType: string;
  readonly boilSeconds: number;
}):
  | { readonly ok: true; readonly slotId: SlotId; readonly noodleType: NoodleType; readonly boilSeconds: number }
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
  // 空文字を「未定義の値」とみなす。slotId / noodleType を欠いた Timer は構築させない。
  if (input.slotId.length === 0 || input.noodleType.length === 0) {
    return {
      ok: false,
      rejection: {
        code: "InvalidSlotOrNoodle",
        message: "slotId と noodleType は未定義にできない",
      },
    };
  }
  return {
    ok: true,
    slotId: input.slotId as SlotId,
    noodleType: input.noodleType as NoodleType,
    boilSeconds: input.boilSeconds,
  };
}

/** Timer を WS のワイヤ表現へ射影する。残り秒は含めず endTime（事実）を運ぶ（要件10.2）。 */
function toWireTimer(timer: Timer): WireTimer {
  return {
    id: timer.id,
    slotId: timer.slotId,
    noodleType: timer.noodleType,
    endTime: timer.endTime,
  };
}

/**
 * タイマー開始の状態遷移。検証 → 容量検査 → endTime 算出 → Timer 追加（要件1.1 / 1.2 / 3.1 / 3.8）。
 *
 * 成功時の Effect 列は [Persist, SetAlarm, Broadcast(started), Reply(started)]。Persist を先頭に
 * 置くのは SSOT 規律の表明であり、shell は put 成功の上にのみ Alarm / Broadcast を立てる。
 * 拒否時は状態を一切変更せず Rejection を返す。
 */
export function startTimer(state: TimerState, args: StartEvent): Outcome {
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
  // endTime は「操作受信時刻 + 茹で時間」の絶対エポックミリ秒（要件1.2）。残り秒は持たない。
  const endTime = (args.now + validated.boilSeconds * 1000) as EpochMillis;
  const timer = createTimer({
    id: args.newTimerId,
    slotId: validated.slotId,
    noodleType: validated.noodleType,
    endTime,
    seq: state.nextSeq,
  });
  const nextState: TimerState = {
    timers: [...state.timers, timer],
    nextSeq: state.nextSeq + 1,
  };
  // started は要求元への Reply と全 WS への Broadcast で同一内容を運ぶ（serverTime = now）。
  const started: ServerMessage = {
    type: "started",
    serverTime: args.now,
    timer: toWireTimer(timer),
  };
  // 最早 Alarm の算出は必ず nextAlarmEffect を通す（最早算出の重複を根絶）。
  const effects: readonly Effect[] = [
    { type: "Persist", snapshot: toSnapshot(nextState) },
    nextAlarmEffect(nextState.timers),
    { type: "Broadcast", message: started },
    { type: "Reply", message: started },
  ];
  return { ok: true, state: nextState, effects };
}
