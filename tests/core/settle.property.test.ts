// tests/core/settle.property.test.ts — Property 1（単一表現＝SSOT）・Property 8（snapshot サイズ有界）。
//
// snapshot-broadcast の引き算リファクタが確定変化ごとに組む Effect 列を検証する。確定変化を生む任意の遷移で
// broadcast は snapshot ただ一つ（唯一の権威表現）であり、Reply は一切生成されない。Persist が先頭に立つ
// （SSOT 規律＝broadcast は put 成功の上にのみ立つ）。加えて、非圧縮 JSON の snapshot サイズが TimerFact
// 件数に対し単調非減少で MAX_TIMERS を上限として超えないこと（有界サイズ）を検証する。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import type { Event } from "../../src/engine/event";
import type { SyncParams } from "../../src/engine/sync";
import { MAX_TIMERS } from "../../src/engine/types";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { ServerMessage } from "../../src/domain/messages";
import type { TimerFact } from "../../src/domain/timer";
import type { Firmness } from "../../src/domain/firmness";
import { genState, nowArbFor } from "./generators";
import type { TimerState } from "../../src/engine/state";
import { nonEmpty } from "../nonEmpty";

/** 固定の同期パラメータ（既定域内・arms=2 / toleranceRatio=10%）。settle が残り running を再同期する。 */
const PARAMS: SyncParams = { arms: 2, toleranceRatio: 10 };

/** 全 Firmness（茹で加減の安定 id）。 */
const FIRMNESS: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

// ── Property 1 用：状態に対する 6 系統のイベント生成器（decide の全分岐を踏む） ──────────────────────

/**
 * 状態と now に対する Event を生成する。Start は有効域（boilSeconds 1..1800・非空 slotIds/noodleType）で
 * 確定変化を誘発し、Cancel / Complete / Adjust は既存 id を優先して除去・再同期を踏む。AlarmFired / Reconcile
 * も含め、decide の 6 分岐すべてをサンプリングする。now はイベントが運ぶ値と decide へ渡す値で一致させる。
 */
function genEventFor(state: TimerState, now: EpochMillis): fc.Arbitrary<Event> {
  const existingIds = state.timers.map((t) => t.id as string);
  const targetId: fc.Arbitrary<string> =
    existingIds.length > 0
      ? fc.oneof(fc.constantFrom(...existingIds), fc.constantFrom("absent-1", "absent-2"))
      : fc.constantFrom("absent-1", "absent-2");
  const slotIds = fc.array(fc.string({ minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 3 });
  const noodleType = fc.constantFrom("thin", "thick", "ramen", "soba", "udon");
  const validBoil = fc.integer({ min: 1, max: 1800 });
  const firmness = fc.constantFrom<Firmness>(...FIRMNESS);

  const start = fc.record({
    type: fc.constant("Start" as const),
    slotIds: slotIds as fc.Arbitrary<readonly string[]>,
    noodleType,
    boilSeconds: validBoil,
    newTimerId: fc.constantFrom("new-a", "new-b", "new-c").map((s) => s as TimerId),
    now: fc.constant(now),
  });
  const cancel = fc.record({ type: fc.constant("Cancel" as const), timerId: targetId, now: fc.constant(now) });
  const complete = fc.record({ type: fc.constant("Complete" as const), timerId: targetId, now: fc.constant(now) });
  const adjust = fc.record({
    type: fc.constant("Adjust" as const),
    timerId: targetId,
    firmness,
    boilSeconds: validBoil,
    now: fc.constant(now),
  });
  const alarm = fc.record({ type: fc.constant("AlarmFired" as const), now: fc.constant(now) });
  const reconcile = fc.record({ type: fc.constant("Reconcile" as const), now: fc.constant(now) });

  return fc.oneof(start, cancel, complete, adjust, alarm, reconcile);
}

/** 状態・イベントの組（イベントの now は状態の endTime 群に対し境界を踏む）。 */
const genStateAndEvent: fc.Arbitrary<{ state: TimerState; event: Event }> = genState.chain((state) =>
  nowArbFor(state).chain((now) => genEventFor(state, now).map((event) => ({ state, event }))),
);

// ── Property 8 用：フィールドサイズ有界の TimerFact 生成器 ─────────────────────────────────────────

/**
 * バイト数を有界に保つ TimerFact。各文字列長・slotIds 件数・時刻整数を上限付きで生成することで、
 * 1 タイマーのシリアライズ長に一定の上限を与える（Property 8 の「各 TimerFact の長さが有界」を満たす）。
 */
const genBoundedWireTimer: fc.Arbitrary<TimerFact> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }),
  slotIds: fc
    .array(fc.string({ minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 8 })
    .map((slots) => nonEmpty(slots)),
  noodleType: fc.string({ minLength: 1, maxLength: 24 }),
  firmness: fc.constantFrom<Firmness>(...FIRMNESS),
  startTime: fc.integer({ min: 0, max: 9_999_999_999_999 }),
  endTime: fc.integer({ min: 0, max: 9_999_999_999_999 }),
});

/** snapshot メッセージの UTF-8 バイト長（文字数ではなくエンコード後のバイト数で測る）。 */
function snapshotByteLength(serverTime: number, timers: readonly TimerFact[]): number {
  const message: ServerMessage = { type: "snapshot", serverTime, timers };
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

describe("engine/settle", () => {
  // Feature: snapshot-broadcast, Property 1: 単一表現（SSOT）
  // 確定変化を生む任意の遷移で、Broadcast はちょうど 1 個かつ message.type === "snapshot"、Reply は皆無、Persist が先頭。
  it("Property 1: 単一表現（SSOT） — 確定変化の Broadcast は snapshot 単一・Reply 皆無・Persist 先頭", () => {
    fc.assert(
      fc.property(genStateAndEvent, ({ state, event }) => {
        const outcome = decide(state, event, PARAMS);
        // 拒否（Rejection）は Effect 列を生まない。確定変化のみを検証対象にする。
        if (!outcome.ok) return;
        // no-op（確定結果が prev と同一）は Effect 空。単一表現の主張は確定変化に対してのみ立てる。
        if (outcome.effects.length === 0) return;

        // Broadcast はちょうど 1 個で、その message は snapshot（唯一の権威表現）。
        const broadcasts = outcome.effects.filter((e) => e.type === "Broadcast");
        expect(broadcasts.length).toBe(1);
        const broadcast = broadcasts[0]!;
        expect(broadcast.type).toBe("Broadcast");
        if (broadcast.type === "Broadcast") {
          expect(broadcast.message.type).toBe("snapshot");
        }

        // Reply 作用は一切含まれない（Reply 種別そのものが撤去済み・実行時にも現れないことを確認）。
        const effectTypes = outcome.effects.map((e) => String(e.type));
        expect(effectTypes).not.toContain("Reply");

        // Persist が先頭に立つ（SSOT 規律＝broadcast は put 成功の上にのみ立つ）。
        expect(outcome.effects[0]!.type).toBe("Persist");
      }),
      { numRuns: 200 },
    );
  });

  // Feature: snapshot-broadcast, Property 8: サイズ有界
  // |JSON(snapshot)| は TimerFact 件数（0〜MAX_TIMERS）に対し単調非減少で、MAX_TIMERS 時を上限として超えない。
  it("Property 8: サイズ有界 — snapshot の UTF-8 バイト長は件数に単調非減少で MAX_TIMERS を上限に超えない", () => {
    fc.assert(
      fc.property(
        fc.array(genBoundedWireTimer, { minLength: MAX_TIMERS, maxLength: MAX_TIMERS }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (timers, serverTime) => {
          // MAX_TIMERS 件（全量）のサイズが上限。0〜MAX_TIMERS 件のいずれもこれを超えない。
          const upperBound = snapshotByteLength(serverTime, timers);
          let previous = -1;
          for (let n = 0; n <= MAX_TIMERS; n++) {
            const length = snapshotByteLength(serverTime, timers.slice(0, n));
            // 件数に対し単調非減少（Timer を 1 件足すとバイト長は減らない）。
            expect(length).toBeGreaterThanOrEqual(previous);
            // MAX_TIMERS 時を上限として超えない。
            expect(length).toBeLessThanOrEqual(upperBound);
            previous = length;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
