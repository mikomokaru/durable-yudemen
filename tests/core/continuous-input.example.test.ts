// tests/core/continuous-input.example.test.ts — 連続投入の不変（lift-group-planning Requirement 7.6・判断 18）。
//
// Feature: lift-group-planning, Property 7.6 — 連続投入の不変
// **Validates: Requirements 1.9, 1.12, 1.13, 5.7, 5.8, 7.6**
//
// 実機の差し戻しの再現を engine の実走で固定する。同じ卓の同じ茹で時間の品目 8 本が「now」で並ぶ状態から、
// 現場が 1 本ずつ数秒間隔で順に投入し続ける。各投入の直後の確定計画で、空いている釜に入る残りの品目はすべて
// 走行中に合流し（`anchor` 非 null・`startAt ≤ now`）、走行中の釜が空くまで押し出されない。arms と投入間隔を
// 振っても成り立つ——2 本目だけ直っても、3 本目や arms の変更で提案が消えるなら現場の問題は解決していない。

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Event } from "../../src/engine/event";
import type { SettleParams } from "../../src/engine/settle";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { CookRecommendation, ServerMessage } from "../../src/domain/messages";
import type { PendingOrder } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS, slotOf } from "../../src/domain/store";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const T0 = 1_700_000_000_000;
const at = (seconds: number) => (T0 + seconds * 1000) as EpochMillis;
type Snapshot = Extract<ServerMessage, { readonly type: "snapshot" }>;

function step(state: TimerState, event: Event, params: SettleParams) {
  const outcome = decide(state, event, params);
  if (!outcome.ok) throw new Error(`rejected ${event.type}: ${outcome.rejection.code}`);
  const broadcast = outcome.effects.find((effect) => effect.type === "Broadcast");
  if (broadcast?.type !== "Broadcast" || broadcast.message.type !== "snapshot") {
    throw new Error(`no snapshot after ${event.type}`);
  }
  return { state: outcome.state, snapshot: broadcast.message as Snapshot };
}

/** 同じ卓の Thin（60 秒）8 品。 */
const ORDERS: readonly PendingOrder[] = Array.from({ length: 8 }, (_unused, index) => ({
  externalOrderId: `o${index}`,
  itemIndex: 0,
  noodleType: "Thin",
  firmness: "normal",
  tableId: "t-1",
  arrivalTime: at(index),
  slotSpan: 1,
  itemName: null,
  sizeName: null,
}));

/** 走行中（boiled を含む）が占める釜。 */
function occupied(snapshot: Snapshot): ReadonlySet<number> {
  return new Set(snapshot.timers.flatMap((timer) => timer.slotIds.map(slotOf)));
}

/** いま押せる推奨——startAt が now 以下で、釜がすべて空いているもの。 */
function startable(snapshot: Snapshot, now: EpochMillis): readonly CookRecommendation[] {
  const busy = occupied(snapshot);
  return snapshot.recommendations.filter(
    (rec) => rec.startAt <= now && rec.slotIds.every((s) => !busy.has(slotOf(s))),
  );
}

/**
 * 押し出し——いま押せる推奨が使わない空き釜に置かれているのに、now より後ろに置かれた推奨。
 * 合流分がこれから使う釜は「空いている」に数えない（その釜は今この瞬間に埋まる）。
 */
function pushedOut(snapshot: Snapshot, now: EpochMillis): readonly CookRecommendation[] {
  const busy = new Set(occupied(snapshot));
  for (const rec of startable(snapshot, now)) for (const s of rec.slotIds) busy.add(slotOf(s));
  return snapshot.recommendations.filter(
    (rec) => rec.startAt > now && rec.slotIds.every((s) => !busy.has(slotOf(s))),
  );
}

describe("連続投入の不変 — 同じ卓の同じ茹で時間の品目を 1 本ずつ順に投入し続ける", () => {
  for (const arms of [1, 2, 3]) {
    for (const gapSeconds of [0, 1, 3, 5]) {
      it(`arms ${arms}・間隔 ${gapSeconds} 秒：各投入の直後、空いている釜の残りはすべて合流して now のまま`, () => {
        const params: SettleParams = {
          ...settleParams({ arms, toleranceRatio: 10 }, 1),
          noodlePresets: DEFAULT_NOODLE_PRESETS,
        };
        let now = 10;
        let current = step(
          EMPTY_STATE,
          { type: "OrderArrived", arrival: nonEmpty([...ORDERS]), now: at(now) },
          params,
        );
        // 到着直後：6 釜すべてに now の推奨（残り 2 本は釜が空く 60 秒後）。
        expect(startable(current.snapshot, at(now))).toHaveLength(6);

        for (let started = 1; started <= 6; started++) {
          // 現場は、いま押せる推奨のうち最早の 1 本を押す。
          const head = [...startable(current.snapshot, at(now))].sort(
            (a, b) => a.startAt - b.startAt,
          )[0];
          expect(head, `投入 ${started} 本目の前に押せる推奨が無い`).toBeDefined();
          now += gapSeconds;
          current = step(
            current.state,
            {
              type: "StartOrderItem",
              slotIds: [...head!.slotIds],
              externalOrderId: head!.externalOrderId,
              itemIndex: head!.itemIndex,
              newTimerId: `t-${head!.externalOrderId}` as TimerId,
              now: at(now),
            },
            params,
          );
          // 空いている釜（6 − started）の分だけ残りが今始められ、空いている釜に置かれて後ろへ押し出された品目は無い。
          const free = startable(current.snapshot, at(now));
          expect(free, `投入 ${started} 本目の直後`).toHaveLength(
            Math.min(6 - started, 8 - started),
          );
          expect(
            pushedOut(current.snapshot, at(now)),
            `投入 ${started} 本目の直後の押し出し`,
          ).toEqual([]);
          for (const rec of free) {
            expect(rec.anchor, `${rec.externalOrderId} は合流していない`).not.toBeNull();
          }
          // 合流した残りは一つの群（同じ投入作業の続き）。
          expect(new Set(free.map((rec) => rec.group)).size).toBeLessThanOrEqual(1);
        }
      });
    }
  }
});
