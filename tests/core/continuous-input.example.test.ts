// tests/core/continuous-input.example.test.ts — 連続投入の不変（lift-group-planning Requirement 7.6・判断 18・20）。
//
// Feature: lift-group-planning, Property 7.6 — 連続投入の不変
// **Validates: Requirements 1.9, 1.12, 1.13, 5.7, 5.8, 7.6, 7.8, 9.4**
//
// 実機の差し戻しの再現を engine の実走で固定する。同じ卓の同じ茹で時間の品目 8 本が「now」で並ぶ状態から、
// 現場が 1 本ずつ数秒間隔で順に投入し続ける。各投入の直後の確定計画で、空いている釜に入る残りの品目はすべて
// 走行中に合流し（`anchor` 非 null・一つの群）、走行中の釜が空くまで押し出されない。arms と投入間隔を
// 振っても成り立つ——2 本目だけ直っても、3 本目や arms の変更で提案が消えるなら現場の問題は解決していない。
//
// **判断 20 の改訂**：合流した品目の `startAt` は「now 以下」ではなく「上げ窓を満たす最初の時刻から茹で時間を
// 引いた値」である。釜が空いていても窓が埋まっていれば startAt は未来になり（提案は薄く現れる）、どの配置を
// 含む窓の負荷も arms + HELPER_ARMS を超えない。9 本が 1 分以内に上がる「全部 now」は消える。

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { advanceLifts, initialLifts, liftCap, loadWith, type Lift } from "../../src/engine/lift";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Event } from "../../src/engine/event";
import type { SettleParams } from "../../src/engine/settle";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { CookRecommendation, ServerMessage } from "../../src/domain/messages";
import { headsOf, liftGroupsOf, visibleGroupsOf, type LiftItem } from "../../src/domain/lift-group";
import { itemKeyOf, type ItemKey, type OrderItem } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS, HELPER_ARMS, slotOf } from "../../src/domain/store";
import type { ShownItem, ShownPlan } from "../../src/engine/stability";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const T0 = 1_700_000_000_000;
const at = (seconds: number) => (T0 + seconds * 1000) as EpochMillis;
/** Thin（normal）の茹で時間。推奨は startAt しか運ばないので、上がりの時刻はこれで再計算する（client と同じ）。 */
const BOIL_MILLIS = 60_000;
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
const ORDERS: readonly OrderItem[] = Array.from({ length: 8 }, (_unused, index) => ({
  externalOrderId: `o${index}`,
  itemIndex: 0,
  noodleType: "Thin",
  firmness: "normal",
  tableId: "t-1",
  arrivalTime: at(index),
  portions: 1,
  itemName: null,
  sizeName: null,
  completedAt: null,
  interruptedAt: null,
  tableAssignedAt: null,
}));

/** 走行中（boiled を含む）が占める釜。 */
function occupied(snapshot: Snapshot): ReadonlySet<number> {
  return new Set(snapshot.timers.flatMap((timer) => timer.slotIds.map(slotOf)));
}

/** 空いている釜に置かれた推奨——釜がすべて空いているもの（走行中が空くのを待たずに始められる）。 */
function onFreeSlots(snapshot: Snapshot): readonly CookRecommendation[] {
  const busy = occupied(snapshot);
  return snapshot.recommendations.filter((rec) => rec.slotIds.every((s) => !busy.has(slotOf(s))));
}

/** いま押せる推奨——startAt が now 以下で、釜がすべて空いているもの。 */
function startable(snapshot: Snapshot, now: EpochMillis): readonly CookRecommendation[] {
  return onFreeSlots(snapshot).filter((rec) => rec.startAt <= now);
}

/** 推奨の上がり（serveAt = startAt + 茹で時間・本数は釜の数）。 */
function liftOf(rec: CookRecommendation): Lift {
  return { at: (rec.startAt + BOIL_MILLIS) as EpochMillis, span: rec.slotIds.length };
}

/**
 * どの推奨についても、それを含むすべての窓（半開・長さ L）の負荷——走行中の実効 endTime と他の推奨の上がり——が
 * arms + HELPER_ARMS を超えないこと（AC 7.8・9.4）。上限は店舗全体で数えるので走行中を表に載せる。
 */
function exceedsLiftCap(
  state: TimerState,
  recs: readonly CookRecommendation[],
  params: SettleParams,
): boolean {
  const running = initialLifts(state.timers);
  return recs.some((rec) => {
    const others = advanceLifts(running, recs.filter((other) => other !== rec).map(liftOf));
    return loadWith(others, liftOf(rec).at, rec.slotIds.length, params) > liftCap(params);
  });
}

/**
 * Shown_Plan を Head の共有導出に掛ける（stability.ts の内側と同じ形——同じ群だった品目を束ね、表示と同じ `headsOf`
 * で先頭 arms 本を引く）。ここでは 1 卓だけなので、群は `recommend` と同じ「合流なら同じ錨・それ以外は同じ提供時刻」
 * で束ねれば `mates` の成分に一致する。
 */
function headsOfShown(
  shown: ShownPlan,
  pending: readonly OrderItem[],
  state: TimerState,
  now: EpochMillis,
  arms: number,
): readonly ItemKey[] {
  const byKey = new Map(pending.map((order) => [itemKeyOf(order), order]));
  const items: LiftItem[] = [];
  for (const item of shown) {
    const order = byKey.get(itemKeyOf(item));
    if (order === undefined) continue;
    items.push({
      recommendation: {
        externalOrderId: item.externalOrderId,
        itemIndex: item.itemIndex,
        slotIds: item.slotIds,
        startAt: item.startAt,
        group: item.anchor === null ? `${item.serveAt}` : `anchor:${item.anchor}`,
        anchor: item.anchor,
      },
      order,
      boilSeconds: BOIL_MILLIS / 1000,
    });
  }
  const busy = new Set(state.timers.flatMap((timer) => timer.slotIds.map(slotOf)));
  return headsOf(visibleGroupsOf(liftGroupsOf(items, now)), busy, now, arms);
}

/** 釜の集合の正準表現。 */
function slotsOf(item: ShownItem): string {
  return [...new Set(item.slotIds.map(slotOf))].sort((a, b) => a - b).join(",");
}

describe("連続投入の不変 — 同じ卓の同じ茹で時間の品目を 1 本ずつ順に投入し続ける", () => {
  for (const arms of [1, 2, 3]) {
    for (const gapSeconds of [0, 1, 3, 5]) {
      it(`arms ${arms}・間隔 ${gapSeconds} 秒：各投入の直後、空いている釜の残りはすべて合流し、上げ窓を満たす最初の時刻に置かれる`, () => {
        const params: SettleParams = {
          ...settleParams({ arms, toleranceRatio: 10 }, 1),
          noodlePresets: DEFAULT_NOODLE_PRESETS,
        };
        const cap = arms + HELPER_ARMS;
        let now = 10;
        let current = step(
          EMPTY_STATE,
          { type: "OrderArrived", arrival: nonEmpty([...ORDERS]), now: at(now) },
          params,
        );
        // 前回の提案（直前の確定で Persist に載った Shown_Plan）と、それを見せていた時点。
        let previous = current.state.shownPlan;
        // 到着直後：8 本すべてに推奨が付くが、now に始められるのは同じ窓の上限 arms + 2 本まで。残りは次の窓から
        // 茹で時間を引いた未来の startAt で薄く現れる（「全部 now」ではない・判断 20）。
        expect(current.snapshot.recommendations).toHaveLength(8);
        expect(startable(current.snapshot, at(now))).toHaveLength(Math.min(6, cap));
        expect(exceedsLiftCap(current.state, current.snapshot.recommendations, params)).toBe(false);

        for (let started = 1; started <= 6; started++) {
          // 現場は、空いている釜に置かれた推奨のうち最早の 1 本を押す（時刻が来ていなくても始められる・AC 9.12）。
          const head = [...onFreeSlots(current.snapshot)].sort((a, b) => a.startAt - b.startAt)[0];
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
          // 空いている釜（6 − started）の分だけ残りが走行中に合流し（`anchor` 非 null）、走行中の釜が空くまで
          // 押し出されない——合流分は空いている釜に置かれ、候補（now から茹でて上がる時刻）より手前には置かれない。
          const joined = current.snapshot.recommendations.filter((rec) => rec.anchor !== null);
          expect(joined, `投入 ${started} 本目の直後`).toHaveLength(
            Math.min(6 - started, 8 - started),
          );
          const busy = occupied(current.snapshot);
          for (const rec of joined) {
            expect(rec.slotIds.every((s) => !busy.has(slotOf(s)))).toBe(true);
            expect(rec.startAt).toBeGreaterThanOrEqual(at(now));
          }
          // 合流した残りは一つの群（同じ投入作業の続き）。
          expect(new Set(joined.map((rec) => rec.group)).size).toBeLessThanOrEqual(1);
          // 合流した品目の startAt は「上げ窓を満たす最初の時刻 − 茹で時間」——走行中の上がりと同じ窓に
          // arms + 2 を超えて上がらず（判断 20）、残りが全員 now に戻ることもない。
          expect(exceedsLiftCap(current.state, current.snapshot.recommendations, params)).toBe(
            false,
          );
          expect(
            current.snapshot.recommendations.some((rec) => rec.startAt > at(now)),
            `投入 ${started} 本目の直後に「全部 now」`,
          ).toBe(true);

          // **plan-stability（Requirement 3・性質 5.6 の横断）：投入のたびに残りの釜と順は変わらない。** 残りの品目
          // （前回にも今回にも在る）について、釜は同じ集合、前回の投入の順（startAt 順）は逆転せず、前回同じ群だった組は
          // 同じ群のまま、前回の先頭（今の時点・今の走行中で導く）で残っている品目は今回も先頭。時刻の移動だけは
          // 上げ窓が押す分だけ起こりうる（走行中の上がりと同じ窓に arms + 2 本を超えて載せられない）。
          const next = current.state.shownPlan;
          const prevByKey = new Map(previous.map((item) => [itemKeyOf(item), item]));
          const kept = next.filter((item) => prevByKey.has(itemKeyOf(item)));
          expect(kept.length, `投入 ${started} 本目の直後に残りが減った`).toBe(8 - started);
          for (const item of kept) {
            const before = prevByKey.get(itemKeyOf(item))!;
            expect(slotsOf(item), `${itemKeyOf(item)} の釜が動いた（投入 ${started} 本目）`).toBe(
              slotsOf(before),
            );
            for (const other of kept) {
              const earlier = prevByKey.get(itemKeyOf(other))!;
              const wasBefore = Math.sign(before.startAt - earlier.startAt);
              const isBefore = Math.sign(item.startAt - other.startAt);
              expect(wasBefore * isBefore, `順が逆転した（投入 ${started} 本目）`).not.toBeLessThan(
                0,
              );
              if (before.mates.includes(itemKeyOf(other))) {
                expect(item.mates, `まとまりが割れた（投入 ${started} 本目）`).toContain(
                  itemKeyOf(other),
                );
              }
            }
          }
          const remaining = current.state.orderItems;
          const oldHead = headsOfShown(previous, remaining, current.state, at(now), arms);
          const newHead = headsOfShown(next, remaining, current.state, at(now), arms);
          for (const key of oldHead) {
            expect(newHead, `先頭 ${key} が外れた（投入 ${started} 本目）`).toContain(key);
          }
          previous = next;
        }
      });
    }
  }
});
