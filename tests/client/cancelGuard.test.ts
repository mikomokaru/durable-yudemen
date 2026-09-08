// 停止ボタンの純粋決定ロジック（cancelGuard）の単体・PBT——早め上げ（complete）と Cancel 誤タップ保険。
// 対話 UI（SlotCard）から切り出した決定関数なので、時刻・残り時間・armedAt を引数で与えて決定的に検証する。
//
// order-lifecycle（判断 4・Requirement 5.1・性質 7.4）：残り < しきいの 1 タップは「早め上げ」＝complete で、
// 残り ≥ しきいの 2 段タップは「中断」＝cancel。しきいを跨いで操作の意味が変わる（送る種別が違う）。

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  CANCEL_GUARD_THRESHOLD_MS,
  CANCEL_ARMED_WINDOW_MS,
  CANCEL_ARMED_BOUNCE_MS,
  decideCancelTap,
  isCancelArmed,
} from "../../src/client/components/cancelGuard";

const NOW = 1_000_000; // 任意の基準絶対時刻。

describe("decideCancelTap — 残り時間による二分と armed 遷移", () => {
  it("残り < しきい: armed でなくても 1 タップで即 complete（早め上げ帯は摩擦なし・完了として記録・性質 7.4）", () => {
    expect(
      decideCancelTap({ remainingMs: CANCEL_GUARD_THRESHOLD_MS - 1, armedAt: null, now: NOW }),
    ).toEqual({
      kind: "complete",
    });
  });

  it("残り < しきい: armed 中でも即 complete（しきいを割った時点で保険は無効・cancel にはならない）", () => {
    expect(
      decideCancelTap({
        remainingMs: CANCEL_GUARD_THRESHOLD_MS - 1,
        armedAt: NOW - 1_000,
        now: NOW,
      }),
    ).toEqual({ kind: "complete" });
  });

  it("残り 0 でも complete（茹で上がり直前の停止は完了）。ちょうどしきいは arm（cancel の側）", () => {
    expect(decideCancelTap({ remainingMs: 0, armedAt: null, now: NOW })).toEqual({
      kind: "complete",
    });
    expect(
      decideCancelTap({ remainingMs: CANCEL_GUARD_THRESHOLD_MS, armedAt: null, now: NOW }).kind,
    ).toBe("arm");
  });

  it("残り ≥ しきい・未 armed: 1 タップ目は送信せず arm（now を armedAt に）", () => {
    expect(
      decideCancelTap({ remainingMs: CANCEL_GUARD_THRESHOLD_MS, armedAt: null, now: NOW }),
    ).toEqual({
      kind: "arm",
      at: NOW,
    });
  });

  it("armed 直後 300ms 未満: バウンス無視（ignore）", () => {
    expect(
      decideCancelTap({
        remainingMs: 120_000,
        armedAt: NOW - (CANCEL_ARMED_BOUNCE_MS - 1),
        now: NOW,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("armed 窓内（300ms 以上・3s 未満）の 2 タップ目: 確定 cancel", () => {
    expect(
      decideCancelTap({ remainingMs: 120_000, armedAt: NOW - CANCEL_ARMED_BOUNCE_MS, now: NOW }),
    ).toEqual({
      kind: "cancel",
    });
    expect(
      decideCancelTap({
        remainingMs: 120_000,
        armedAt: NOW - (CANCEL_ARMED_WINDOW_MS - 1),
        now: NOW,
      }),
    ).toEqual({ kind: "cancel" });
  });

  it("armed 窓超過（3s 以上）: 改めて 1 タップ目扱いで再 arm", () => {
    expect(
      decideCancelTap({ remainingMs: 120_000, armedAt: NOW - CANCEL_ARMED_WINDOW_MS, now: NOW }),
    ).toEqual({
      kind: "arm",
      at: NOW,
    });
  });
});

describe("isCancelArmed — armed 表示の導出", () => {
  it("残り ≥ しきい・armedAt が窓内: true", () => {
    expect(isCancelArmed({ remainingMs: 120_000, armedAt: NOW - 1_000, now: NOW })).toBe(true);
  });
  it("未 armed: false", () => {
    expect(isCancelArmed({ remainingMs: 120_000, armedAt: null, now: NOW })).toBe(false);
  });
  it("窓超過: false（黙って解除と同じ導出）", () => {
    expect(
      isCancelArmed({ remainingMs: 120_000, armedAt: NOW - CANCEL_ARMED_WINDOW_MS, now: NOW }),
    ).toBe(false);
  });
  it("残り < しきい: armedAt が窓内でも false（しきいを割れば保険無効）", () => {
    expect(
      isCancelArmed({ remainingMs: CANCEL_GUARD_THRESHOLD_MS - 1, armedAt: NOW - 100, now: NOW }),
    ).toBe(false);
  });
});

// ── PBT: 不変条件 ──────────────────────────────────────────────────────────────────────────────

const genNow = fc.integer({ min: 0, max: 10_000_000 });
const genRemaining = fc.integer({ min: 0, max: 1_800_000 });
// 経過は非負（now ≥ armedAt）。armedAt は now - elapsed で与える。
const genElapsed = fc.integer({ min: 0, max: 10_000 });

describe("decideCancelTap — Property", () => {
  it("残り < しきい では now/armedAt によらず必ず complete（早め上げ帯に保険を掛けず、完了として送る・性質 7.4）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: CANCEL_GUARD_THRESHOLD_MS - 1 }),
        genNow,
        genElapsed,
        (remainingMs, now, elapsed) => {
          for (const armedAt of [null, now - elapsed]) {
            expect(decideCancelTap({ remainingMs, armedAt, now }).kind).toBe("complete");
          }
        },
      ),
    );
  });

  it("complete を返すのは残り < しきい のときだけ（残り ≥ しきい では complete は決して出ない）", () => {
    fc.assert(
      fc.property(genRemaining, genNow, genElapsed, (remainingMs, now, elapsed) => {
        for (const armedAt of [null, now - elapsed]) {
          const decision = decideCancelTap({ remainingMs, armedAt, now });
          expect(decision.kind === "complete").toBe(remainingMs < CANCEL_GUARD_THRESHOLD_MS);
        }
      }),
    );
  });

  it("残り ≥ しきい・armed 直後 <300ms は必ず ignore（バウンス貫通しない）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: CANCEL_GUARD_THRESHOLD_MS, max: 1_800_000 }),
        genNow,
        fc.integer({ min: 0, max: CANCEL_ARMED_BOUNCE_MS - 1 }),
        (remainingMs, now, elapsed) => {
          expect(decideCancelTap({ remainingMs, armedAt: now - elapsed, now }).kind).toBe("ignore");
        },
      ),
    );
  });

  it("残り ≥ しきい・armed [300ms, 3s) は必ず cancel（確定帯）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: CANCEL_GUARD_THRESHOLD_MS, max: 1_800_000 }),
        genNow,
        fc.integer({ min: CANCEL_ARMED_BOUNCE_MS, max: CANCEL_ARMED_WINDOW_MS - 1 }),
        (remainingMs, now, elapsed) => {
          expect(decideCancelTap({ remainingMs, armedAt: now - elapsed, now }).kind).toBe("cancel");
        },
      ),
    );
  });

  it("cancel を返すのは残り ≥ しきい かつ armed 中で elapsed ∈ [300ms, 3s) のときだけ（1 タップで cancel は出ない）", () => {
    fc.assert(
      fc.property(genRemaining, genNow, genElapsed, (remainingMs, now, elapsed) => {
        expect(decideCancelTap({ remainingMs, armedAt: null, now }).kind).not.toBe("cancel");
        const decision = decideCancelTap({ remainingMs, armedAt: now - elapsed, now });
        const inCommitWindow =
          elapsed >= CANCEL_ARMED_BOUNCE_MS && elapsed < CANCEL_ARMED_WINDOW_MS;
        expect(decision.kind === "cancel").toBe(
          remainingMs >= CANCEL_GUARD_THRESHOLD_MS && inCommitWindow,
        );
      }),
    );
  });
});
