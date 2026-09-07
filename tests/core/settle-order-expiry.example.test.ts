// Feature: pending-order-expiry, Component 3 — settle は生きている待ち行列を配り、要求し、文脈に渡す
// **Validates: Requirements 2.2, 2.3, 2.4, 2.6, 2.7, 5.5, 5.6, 5.7**
//
// tests/core/settle-order-expiry.example.test.ts — 期限は状態を書き換えず、読む側の入口が now で絞る。ここで固定するのは
// settle の 3 つの読み口——snapshot（確定変化の Broadcast と hydration）・外部要求（RequestPlan.pending と指紋）・変更費用の
// 文脈（deriveRecommendations）——が同じ Live_Orders を読み、正本（TimerState.pendingOrders・Persist の snapshot）は
// 触らないことである。混在の場面（期限切れの旧先頭を文脈から外す）は expiryScenes.ts を共有する。

import { describe, expect, it } from "vitest";
import { settle, toWireSnapshot } from "../../src/engine/settle";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Effect } from "../../src/engine/effect";
import type { EpochMillis } from "../../src/engine/types";
import type { ServerMessage } from "../../src/domain/messages";
import { liveOrders, ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
import { changeCostOf, EXPIRY_PARAMS, mixedScene, SECOND, startOffsets } from "./expiryScenes";

const NOW = 1_700_000_000_000 as EpochMillis;
const HOUR = 60 * 60 * 1000;

function order(externalOrderId: string, arrivalTime: number): OrderItem {
  return {
    externalOrderId,
    itemIndex: 0,
    noodleType: "Long",
    firmness: "normal",
    tableId: "t-a",
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  };
}

/** ちょうど寿命（NOW で切れる・NOW − 1 では生きている）。 */
const EXPIRED = order("o-expired", NOW - ORDER_LIFETIME_MS);
/** 3 時間前（どの now でも切れている）。 */
const STALE = order("o-stale", NOW - 3 * HOUR);
/** 1 分前（生きている）。 */
const LIVE = order("o-live", NOW - 60 * SECOND);

type Snapshot = Extract<ServerMessage, { readonly type: "snapshot" }>;

function broadcastOf(effects: readonly Effect[]): Snapshot {
  const broadcast = effects.find((effect) => effect.type === "Broadcast");
  if (broadcast?.type !== "Broadcast") throw new Error("Broadcast が無い");
  if (broadcast.message.type !== "snapshot") throw new Error("snapshot でない");
  return broadcast.message;
}

function persistOf(effects: readonly Effect[]) {
  const persist = effects[0];
  if (persist?.type !== "Persist") throw new Error("Persist が先頭に無い");
  return persist.snapshot;
}

function requestOf(effects: readonly Effect[]) {
  const request = effects.find((effect) => effect.type === "RequestPlan");
  return request?.type === "RequestPlan" ? request : null;
}

/** 待ち行列が `pending` になる確定変化（要求してよい遷移）。 */
function arrive(prev: TimerState, pending: readonly OrderItem[], now: EpochMillis) {
  const outcome = settle(prev, { ...prev, pendingOrders: pending }, EXPIRY_PARAMS, now, true);
  if (!outcome.ok) throw new Error("settle が拒否した");
  return outcome;
}

describe("snapshot の pendingOrders は Live_Orders（AC 2.2・性質 5.5）", () => {
  it("確定変化の Broadcast は liveOrders(state.pendingOrders, now) を載せ、正本の集合そのものは載せない", () => {
    const prev: TimerState = { ...EMPTY_STATE, pendingOrders: [STALE] };
    const outcome = arrive(prev, [STALE, LIVE, EXPIRED], NOW);

    const snapshot = broadcastOf(outcome.effects);
    expect(snapshot.pendingOrders).toEqual(liveOrders(outcome.state.pendingOrders, NOW));
    expect(snapshot.pendingOrders).toEqual([LIVE]);
    // 正本は全件のまま（性質 5.7）。
    expect(outcome.state.pendingOrders).toEqual([STALE, LIVE, EXPIRED]);
  });

  it("hydration（toWireSnapshot）も同じ射影を通り、now だけが違えば同じ状態から違う待ち行列が配られる", () => {
    const state: TimerState = { ...EMPTY_STATE, pendingOrders: [STALE, LIVE, EXPIRED] };

    const atNow = toWireSnapshot(state, EXPIRY_PARAMS, NOW);
    const justBefore = toWireSnapshot(state, EXPIRY_PARAMS, (NOW - 1) as EpochMillis);

    if (atNow.type !== "snapshot" || justBefore.type !== "snapshot")
      throw new Error("snapshot でない");
    expect(atNow.pendingOrders).toEqual(liveOrders(state.pendingOrders, NOW));
    expect(atNow.pendingOrders).toEqual([LIVE]);
    // 1 ms 手前では EXPIRED はまだ生きている（並びは正本のまま）。
    expect(justBefore.pendingOrders).toEqual([LIVE, EXPIRED]);
    // 期限は状態を書き換えない——同じ状態から両方を導いた。
    expect(state.pendingOrders).toEqual([STALE, LIVE, EXPIRED]);
  });

  it("全件が期限内なら snapshot の pendingOrders は状態の配列そのもの（参照同値・再描画の抑制を壊さない）", () => {
    const state: TimerState = { ...EMPTY_STATE, pendingOrders: [LIVE, EXPIRED] };
    const message = toWireSnapshot(state, EXPIRY_PARAMS, (NOW - 1) as EpochMillis);
    if (message.type !== "snapshot") throw new Error("snapshot でない");
    expect(message.pendingOrders).toBe(state.pendingOrders);
  });
});

describe("期限切れの品目は要求に乗らず、指紋にも現れない（AC 2.3 / 2.6）", () => {
  it("RequestPlan.pending は計画対象（生きている待ち行列）で、期限切れを運ばない", () => {
    const outcome = arrive(EMPTY_STATE, [STALE, LIVE, EXPIRED], NOW);
    const request = requestOf(outcome.effects);
    expect(request).not.toBeNull();
    expect(request?.pending).toEqual([LIVE]);
  });

  it("期限切れの品目の有無は指紋（要求が運ぶ digest）を変えない", () => {
    const withExpired = requestOf(arrive(EMPTY_STATE, [STALE, LIVE, EXPIRED], NOW).effects);
    const liveOnly = requestOf(arrive(EMPTY_STATE, [LIVE], NOW).effects);
    expect(withExpired?.digest).toBe(liveOnly?.digest);
  });
});

describe("性質 5.6 無害：期限切れの品目だけの待ち行列は空の待ち行列と同じ", () => {
  it("同じ推奨（無し）・同じ snapshot の pendingOrders（空）・要求しない（指紋も永続しない）", () => {
    // 空の待ち行列側の確定変化は判定材料の前進（0 品目の受領・pos-order-ingress Property 16）で起こす。
    const emptyQueue = settle(
      EMPTY_STATE,
      { ...EMPTY_STATE, lastSequenceByTerminal: { "pos-1": "1" } },
      EXPIRY_PARAMS,
      NOW,
      true,
    );
    const expiredOnly = arrive(EMPTY_STATE, [STALE, EXPIRED], NOW);
    expect(emptyQueue.ok).toBe(true);
    if (!emptyQueue.ok) return;

    expect(broadcastOf(expiredOnly.effects)).toEqual(broadcastOf(emptyQueue.effects));
    expect(broadcastOf(expiredOnly.effects).pendingOrders).toEqual([]);
    expect(broadcastOf(expiredOnly.effects).recommendations).toEqual([]);
    expect(requestOf(expiredOnly.effects)).toBeNull();
    expect(expiredOnly.state.requestedDigest).toBeNull();
    expect(expiredOnly.effects.map((effect) => effect.type)).toEqual(
      emptyQueue.effects.map((effect) => effect.type),
    );
  });

  it("hydration でも空の待ち行列と同じ snapshot（serverTime を除いて同じ内容）", () => {
    const expiredOnly = toWireSnapshot(
      { ...EMPTY_STATE, pendingOrders: [STALE, EXPIRED] },
      EXPIRY_PARAMS,
      NOW,
    );
    const empty = toWireSnapshot(EMPTY_STATE, EXPIRY_PARAMS, NOW);
    expect(expiredOnly).toEqual(empty);
  });
});

describe("性質 5.7 不変：期限切れは正本と永続 snapshot を変えない（AC 1.5 / 2.7）", () => {
  it("返る状態の pendingOrders は遷移が置いた配列そのもので、Persist の snapshot も全件を持つ", () => {
    const pending = [STALE, LIVE, EXPIRED];
    const outcome = arrive(EMPTY_STATE, pending, NOW);
    expect(outcome.state.pendingOrders).toBe(pending);
    expect(persistOf(outcome.effects).pendingOrders).toEqual([STALE, LIVE, EXPIRED]);
    // 配る値だけが絞られている。
    expect(broadcastOf(outcome.effects).pendingOrders).toEqual([LIVE]);
  });

  it("no-op 検出は正本を比べる：期限切れだけの待ち行列に同じ集合を渡せば no-op（Persist も Broadcast も出ない）", () => {
    const prev: TimerState = { ...EMPTY_STATE, pendingOrders: [STALE, EXPIRED] };
    const outcome = settle(
      prev,
      { ...prev, pendingOrders: [...prev.pendingOrders] },
      EXPIRY_PARAMS,
      NOW,
      true,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.effects).toEqual([]);
    expect(outcome.state).toBe(prev);
  });

  it("時間が進んで品目が期限を過ぎても、それ自体は遷移にならない（no-op のまま・要求も出ない）", () => {
    // LIVE が確定した状態に、寿命を跨いだ後の now で同じ集合の遷移を流す。
    const prev = arrive(EMPTY_STATE, [LIVE], NOW).state;
    const later = (NOW + 3 * HOUR) as EpochMillis;
    const outcome = settle(
      prev,
      { ...prev, pendingOrders: [...prev.pendingOrders] },
      EXPIRY_PARAMS,
      later,
      true,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.effects).toEqual([]);
    expect(outcome.state).toBe(prev);
    // 次に読む時点の now で絞られるので、正本に残っていることは観測されない。
    const hydrated = toWireSnapshot(prev, EXPIRY_PARAMS, later);
    if (hydrated.type !== "snapshot") throw new Error("snapshot でない");
    expect(hydrated.pendingOrders).toEqual([]);
    expect(hydrated.recommendations).toEqual([]);
  });
});

describe("混在（レビュー実走）：変更費用の文脈は生きている待ち行列で組む（AC 2.4）", () => {
  const scene = mixedScene(NOW);

  it("hydration：B は今のまま（旧 Head を保つ）、C は 45 秒後。期限切れの A は推奨にも待ち行列にも無い", () => {
    const message = toWireSnapshot(scene.state, EXPIRY_PARAMS, NOW);
    if (message.type !== "snapshot") throw new Error("snapshot でない");
    expect(startOffsets(message.recommendations, NOW)).toEqual([
      ["B", 0],
      ["C", 45],
    ]);
    expect(message.pendingOrders).toEqual(scene.live);
  });

  it("確定変化（settle）でも同じ推奨が確定して Shown_Plan に載り、要求は生きている品目だけを運ぶ", () => {
    const outcome = settle(
      scene.state,
      { ...scene.state, lastSequenceByTerminal: { "pos-1": "1" } },
      EXPIRY_PARAMS,
      NOW,
      true,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(startOffsets(broadcastOf(outcome.effects).recommendations, NOW)).toEqual([
      ["B", 0],
      ["C", 45],
    ]);
    expect(startOffsets(persistOf(outcome.effects).shownPlan, NOW)).toEqual([
      ["B", 0],
      ["C", 45],
    ]);
    expect(requestOf(outcome.effects)?.pending).toEqual(scene.live);
    // 正本は期限切れの A を含んだまま。
    expect(persistOf(outcome.effects).pendingOrders).toEqual(scene.pending);
  });

  it("pack（B・C を 45 秒後）の変更費用は正しい文脈で先頭の変更 2L = 90 秒、期限切れの A を文脈に残せば 0", () => {
    expect(changeCostOf(scene.pack, scene, scene.live)).toBe(2 * EXPIRY_PARAMS.liftIntervalSeconds);
    expect(changeCostOf(scene.pack, scene, scene.live)).toBe(90);
    expect(changeCostOf(scene.pack, scene, scene.pending)).toBe(0);
    // 確定した分割そのものは前回と同じ（費用 0）。
    expect(changeCostOf(scene.split, scene, scene.live)).toBe(0);
  });
});
