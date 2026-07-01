// tests/client/convergence.property.test.ts — Property 2（bug#1 の消滅・収束一致）と bug#1 回帰 example。
//
// engine（startTimer → settle → Broadcast(snapshot)）と client（decideView の snapshot 適用）を結線し、
// 「要求元 client と非要求元 client が同一の broadcast(snapshot) 列を適用すると同一集合へ収束する」ことを検証する。
// snapshot 単一表現化により Reply 経路が消えたため、要求元だけが未同期 endTime でズレる経路が構造的に存在しない。
//
// engine（純粋変換）と client（純粋 decideView）はどちらも workerd に依存しないため、既定 pool で走らせる。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { startTimer } from "../../src/engine/start";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Event } from "../../src/engine/event";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { SyncParams } from "../../src/engine/sync";
import type { Effect } from "../../src/engine/effect";
import { DEFAULT_ARMS, DEFAULT_TOLERANCE_RATIO } from "../../src/domain/store";
import { decideView, EMPTY_VIEW, type ClientView } from "../../src/client/connection";
import type { ServerMessage } from "../../src/domain/messages";

/** 実運用の既定同期パラメータ（arms=2 / toleranceRatio=10%）。近接 start が synchronize で調整される。 */
const PARAMS: SyncParams = { arms: DEFAULT_ARMS, toleranceRatio: DEFAULT_TOLERANCE_RATIO };

type SnapshotMessage = Extract<ServerMessage, { type: "snapshot" }>;
type StartEvent = Extract<Event, { type: "Start" }>;

/** Effect 列から権威 snapshot（唯一の Broadcast）を取り出す。確定変化なら必ず 1 個含まれる。 */
function snapshotOf(effects: readonly Effect[]): SnapshotMessage | null {
  for (const effect of effects) {
    if (effect.type === "Broadcast" && effect.message.type === "snapshot") {
      return effect.message;
    }
  }
  return null;
}

/** client の server-confirmed 集合を id/slotIds/noodleType/endTime の比較可能な形へ射影し id 昇順で並べる。 */
function serverConfirmed(view: ClientView): readonly TimerProjection[] {
  return view.timers
    .filter((timer) => timer.origin === "server")
    .map(project)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** snapshot.timers（TimerFact 列）を同じ射影で並べる（両者の比較基準を一致させる）。 */
function snapshotProjection(snapshot: SnapshotMessage): readonly TimerProjection[] {
  return snapshot.timers.map(project).sort((a, b) => a.id.localeCompare(b.id));
}

interface TimerProjection {
  readonly id: string;
  readonly slotIds: readonly string[];
  readonly noodleType: string;
  readonly endTime: number;
}

function project(timer: {
  readonly id: string;
  readonly slotIds: readonly string[];
  readonly noodleType: string;
  readonly endTime: number;
}): TimerProjection {
  return { id: timer.id, slotIds: [...timer.slotIds], noodleType: timer.noodleType, endTime: timer.endTime };
}

/** Start イベントを組み立てる（startTimer は Start 種別だけを受け取る）。 */
function startEvent(input: {
  readonly slotIds: readonly string[];
  readonly noodleType: string;
  readonly boilSeconds: number;
  readonly newTimerId: string;
  readonly now: number;
}): StartEvent {
  return {
    type: "Start",
    slotIds: input.slotIds,
    noodleType: input.noodleType,
    boilSeconds: input.boilSeconds,
    newTimerId: input.newTimerId as TimerId,
    now: input.now as EpochMillis,
  };
}

// ── Property 2 の生成器 ──────────────────────────────────────────────────────────────────────────

const SLOT_POOL = ["0", "1", "2", "3", "4", "5"] as const;
const NOODLE_POOL = ["Thin", "Medium", "Thick"] as const;

/** 一件の start 仕様。boilSeconds は現実域、gap は直前 start からの受信間隔（近接 start を誘発）。 */
interface StartSpec {
  readonly slotIds: readonly string[];
  readonly noodleType: string;
  readonly boilSeconds: number;
  readonly gapMs: number;
}

const genStartSpec: fc.Arbitrary<StartSpec> = fc.record({
  slotIds: fc.subarray([...SLOT_POOL], { minLength: 1, maxLength: 2 }),
  noodleType: fc.constantFrom(...NOODLE_POOL),
  // 近接した endTime を誘発するため茹で時間は狭い域に寄せる（synchronize の調整を踏む）。
  boilSeconds: fc.integer({ min: 55, max: 65 }),
  // 直前 start からの間隔。0〜数千 ms で endTime を近接クラスタ化する。
  gapMs: fc.integer({ min: 0, max: 4000 }),
});

/** MAX_TIMERS を十分下回る 1〜20 件の start 列。空列は収束検証の意味がないため最低 1 件。 */
const genStartSequence: fc.Arbitrary<readonly StartSpec[]> = fc.array(genStartSpec, { minLength: 1, maxLength: 20 });

describe("client/convergence — snapshot 単一表現による収束一致", () => {
  // Feature: snapshot-broadcast, Property 2: bug#1 の消滅（収束一致）
  // 任意の start 列を engine で確定し、各 start が生む単一 snapshot を要求元 client と非要求元 client の
  // 双方へ同一順序で適用する。各 start 直後に、両 client の server-confirmed 集合が当該 snapshot.timers に
  // 完全一致（id / slotIds / noodleType / endTime）し、かつ両者が相互に同一であることを検証する。
  // Reply 経路が撤去されたため、要求元だけが未同期 endTime でズレる経路は存在しない。
  it("Property 2: 要求元と非要求元が同一 snapshot 列で snapshot.timers へ収束し相互に一致する", () => {
    fc.assert(
      fc.property(genStartSequence, fc.integer({ min: 0, max: 5_000_000 }), (specs, baseNow) => {
        let state: TimerState = EMPTY_STATE;
        let requester: ClientView = EMPTY_VIEW;
        let nonRequester: ClientView = EMPTY_VIEW;
        let now = baseNow;

        specs.forEach((spec, index) => {
          now += spec.gapMs;
          const outcome = startTimer(
            state,
            startEvent({ ...spec, newTimerId: `timer-${index}`, now }),
            PARAMS,
          );
          // 有効な start（範囲内 boilSeconds・非空 slot/noodle・容量内）は必ず確定変化を生む。
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          state = outcome.state;

          const snapshot = snapshotOf(outcome.effects);
          // 確定変化ごとに単一の権威 snapshot が Broadcast される。
          expect(snapshot).not.toBeNull();
          if (snapshot === null) return;

          // 要求元・非要求元の双方が同一 snapshot を同一順序で適用する（Reply は存在しない）。
          requester = decideView(requester, { kind: "Server", message: snapshot, receivedAt: now });
          nonRequester = decideView(nonRequester, { kind: "Server", message: snapshot, receivedAt: now + 1 });

          const expected = snapshotProjection(snapshot);
          // (a) 要求元の server-confirmed 集合は snapshot.timers に完全一致する。
          expect(serverConfirmed(requester)).toEqual(expected);
          // (b) 非要求元の server-confirmed 集合も snapshot.timers に完全一致する。
          expect(serverConfirmed(nonRequester)).toEqual(expected);
          // (c) 要求元と非要求元は相互に同一（要求元だけがズレる経路が存在しない）。
          expect(serverConfirmed(requester)).toEqual(serverConfirmed(nonRequester));
        });
      }),
      { numRuns: 200 },
    );
  });

  // Feature: snapshot-broadcast, Property 2: bug#1 の消滅（収束一致）— 回帰 example
  // 「2 本同期茹での 2 本目 start」を engine + client で再現する。2 本の近接 start は synchronize で
  // 共通の実効 endTime へ調整され、その同期済み endTime が snapshot に載る。要求元 client（2 本目を開始した側）が
  // 受ける Timer の endTime は snapshot（同期済み・実効値）と一致し、未同期 endTime（now + boilSeconds*1000）とは
  // 異なる。変更前は Reply（未同期 endTime）が snapshot より後着し、要求元だけがズレていた。
  it("bug#1 回帰: 2 本目 start の要求元 endTime は同期済み snapshot と一致し未同期値と異なる", () => {
    const T = 1_000_000;

    // 1 本目（timer-A）: 非要求元が観測する既存の茹で。endTime_A = T + 60_000。
    const outcomeA = startTimer(
      EMPTY_STATE,
      startEvent({ slotIds: ["0"], noodleType: "Medium", boilSeconds: 60, newTimerId: "timer-A", now: T }),
      PARAMS,
    );
    expect(outcomeA.ok).toBe(true);
    if (!outcomeA.ok) return;
    const snapshotA = snapshotOf(outcomeA.effects);
    expect(snapshotA).not.toBeNull();
    if (snapshotA === null) return;

    // 両 client が 1 本目の snapshot を適用する。
    let requester: ClientView = decideView(EMPTY_VIEW, { kind: "Server", message: snapshotA, receivedAt: T });
    let nonRequester: ClientView = decideView(EMPTY_VIEW, { kind: "Server", message: snapshotA, receivedAt: T });

    // 2 本目（timer-B）: 要求元が 2_000ms 後に開始する。未同期 endTime_B = 1_062_000。窓が 1 本目と重なり synchronize が走る。
    const nowB = T + 2_000;
    const unsyncedEndTimeB = nowB + 60 * 1000; // 変更前の Reply が運んでいた未同期 endTime。
    const outcomeB = startTimer(
      outcomeA.state,
      startEvent({ slotIds: ["1"], noodleType: "Medium", boilSeconds: 60, newTimerId: "timer-B", now: nowB }),
      PARAMS,
    );
    expect(outcomeB.ok).toBe(true);
    if (!outcomeB.ok) return;
    const snapshotB = snapshotOf(outcomeB.effects);
    expect(snapshotB).not.toBeNull();
    if (snapshotB === null) return;

    // 要求元（2 本目を開始した側）と非要求元が同一の 2 本目 snapshot を適用する。
    requester = decideView(requester, { kind: "Server", message: snapshotB, receivedAt: nowB });
    nonRequester = decideView(nonRequester, { kind: "Server", message: snapshotB, receivedAt: nowB });

    // snapshot が運ぶ timer-B の実効 endTime（同期済み）。
    const snapshotTimerB = snapshotB.timers.find((timer) => timer.id === "timer-B");
    expect(snapshotTimerB).toBeDefined();
    if (snapshotTimerB === undefined) return;

    // synchronize が働き、実効 endTime は未同期値からずれている（＝調整が実在する）。
    expect(snapshotTimerB.endTime).not.toBe(unsyncedEndTimeB);

    // 2 本は同一の実効 endTime（共通の Sync_Target）へそろう。
    const snapshotTimerA = snapshotB.timers.find((timer) => timer.id === "timer-A");
    expect(snapshotTimerA).toBeDefined();
    if (snapshotTimerA === undefined) return;
    expect(snapshotTimerA.endTime).toBe(snapshotTimerB.endTime);

    // 要求元 client が受ける timer-B の endTime は snapshot（同期済み）と一致する（未同期値で上書きされない）。
    const requesterTimerB = requester.timers.find((timer) => timer.id === "timer-B");
    expect(requesterTimerB).toBeDefined();
    if (requesterTimerB === undefined) return;
    expect(requesterTimerB.origin).toBe("server");
    expect(requesterTimerB.endTime).toBe(snapshotTimerB.endTime);
    expect(requesterTimerB.endTime).not.toBe(unsyncedEndTimeB);

    // 要求元と非要求元の server-confirmed 集合は一致する。
    expect(serverConfirmed(requester)).toEqual(serverConfirmed(nonRequester));
    expect(serverConfirmed(requester)).toEqual(snapshotProjection(snapshotB));
  });
});
