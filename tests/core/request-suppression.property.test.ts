// tests/core/request-suppression.property.test.ts — Property 9（要求の抑制は指紋の一致と厳密に対応する）。
//
// 主張は**同値（iff）**である。「指紋が食い違い、計画対象が在るなら要求が出る」と「要求が出るならそうである」
// の両方を見る。片側だけを検査すると、要求を一切出さない実装（前者を落とす）と常に出す実装（後者を落とす）の
// どちらかが黙って通る——抑制という機構は、出る条件と出ない条件が対で決まって初めて意味を持つ。
//
// **同値の右辺に「計画対象が非空」が入る**（AC 5.6 の追加節）。計画する対象が無い要求は改善しうるものが
// 存在しないため出さない。ゆえに「指紋が食い違うのに要求が出ない」場面が正当に存在し、その場面を
// 生成器が実際に踏んでいることを件数で確かめる（踏まなければ追加節は空虚に通る）。
//
// **主張の範囲は「状態変化」である**（design の Property 9 の文言どおり）。確定結果が直前と変わらない遷移
// （no-op）は状態変化ではなく、Effect 列そのものが空ゆえ要求も出ない。指紋だけが食い違う no-op で要求を出すには
// 新しい指紋の永続が要り、それは AC 7.6（確定結果が不変なら put も broadcast もしない）に反する。ゆえに
// no-op は対象外とし、取り逃した機会は次の確定変化が回収する（そのとき指紋はまだ食い違っている）。
//
// **同値の両向きを settle の直下で見る。** `decide` 経由では `mayRequestPlan` を振れない（イベント種別が
// 決める値であり、`false` を渡す遷移＝計画受領はタスク 18.3 までまだ無い）。AC 5.7「計画受領は要求の契機に
// しない」を検査できるのは settle の引数を直に振る形だけである。加えて「指紋が一致する」場面は
// `requestedDigest` に現在の指紋そのものを置いて初めて作れるので、状態をここで組む——共有生成器
// （genScheduledScene）は他の property が使っており、この property だけが要る指紋の振り方を持ち込まない。
//
// そのうえで `decide` 経由の配線も見る。既存 5 遷移＋新 2 遷移がすべて `mayRequestPlan = true` を渡している
// ことは、engine の内側では settle の署名が保証してくれない（渡し忘れは型ではなく値の誤りである）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { digestInput } from "../../src/engine/digest";
import type { Effect } from "../../src/engine/effect";
import { planTargets } from "../../src/engine/schedule";
import { settle } from "../../src/engine/settle";
import type { TimerState } from "../../src/engine/state";
import { genScheduledScene, type ScheduledScene } from "./schedulingScenes";

/** 列に現れる RequestPlan（高々 1 件。位置＝末尾の主張は Property 12 の担当）。 */
function requestOf(effects: readonly Effect[]): Extract<Effect, { readonly type: "RequestPlan" }> | null {
  const requests = effects.filter((effect) => effect.type === "RequestPlan");
  expect(requests.length).toBeLessThanOrEqual(1);
  return requests[0] ?? null;
}

/** Persist が運ぶ指紋。要求を出した遷移では新しい指紋が永続されねばならない（AC 5.4）。 */
function persistedDigest(effects: readonly Effect[]): number | null {
  const persist = effects.find((effect) => effect.type === "Persist");
  expect(persist).toBeDefined();
  return persist?.type === "Persist" ? persist.snapshot.requestedDigest : null;
}

describe("engine/settle — 要求の抑制", () => {
  // Feature: online-cook-scheduling, Property: 9 — 要求の抑制は指紋の一致と厳密に対応する
  // **Validates: Requirements 5.6, 5.7**
  it("Property 9: RequestPlan が現れることは「指紋が食い違い、計画受領でなく、計画対象が非空」と同値である", () => {
    // 追加節（計画対象が非空）の両側を実際に踏んだかを数える。片側しか踏まなければ主張は空虚になる。
    let withTargets = 0;
    let withoutTargets = 0;

    fc.assert(
      fc.property(genScheduledScene, (scene: ScheduledScene) => {
        // 待ち行列と採用済み計画が現れる遷移を素材にする（Timer 集合は両世界で同一ゆえ、確定結果の変化は
        // 待ち行列・採用済み計画の出現そのものである）。
        const prev: TimerState = scene.bare;
        const moved: TimerState = scene.state;

        // 受領の遷移（mayRequestPlan = false）。ここで確定後の状態と現在の指紋も得る。
        const received = settle(prev, moved, scene.params, scene.now, false);
        expect(received.ok).toBe(true);
        if (!received.ok) return;
        // 確定変化が無い場面（待ち行列も採用済み計画も空）は「状態変化」ではないため主張の対象外。
        if (received.effects.length === 0) {
          expect(requestOf(received.effects)).toBeNull();
          return;
        }

        const digest = digestInput(received.state.pendingOrders, received.state.timers, scene.params);
        // 「計画対象」の判定は planTargets ただ一つ（settle と同じ定義を見る・同じ規則を二度書かない）。
        const hasTargets = planTargets(received.state.pendingOrders).length > 0;
        if (hasTargets) withTargets++;
        else withoutTargets++;

        // (1) 計画受領の遷移は要求を出さない（AC 5.7）。指紋が食い違って（null ≠ digest）いても出ない。
        expect(moved.requestedDigest).toBeNull();
        expect(requestOf(received.effects)).toBeNull();
        expect(received.state.requestedDigest).toBeNull();

        // (2) 指紋が食い違うとき、要求が出るのは計画対象が非空のときに限る（AC 5.6）。
        const requesting = settle(prev, moved, scene.params, scene.now, true);
        expect(requesting.ok).toBe(true);
        if (!requesting.ok) return;
        const request = requestOf(requesting.effects);
        expect(request !== null).toBe(hasTargets);
        if (hasTargets) {
          // 運ぶ指紋・永続する指紋・状態の指紋のすべてが現在の指紋になる（AC 5.4）。
          expect(request?.digest).toBe(digest);
          expect(requesting.state.requestedDigest).toBe(digest);
          expect(persistedDigest(requesting.effects)).toBe(digest);
          // 要求が運ぶ入力は、指紋を取った入力そのものである（受領時に入力を同定する手がかり・AC 5.3）。
          expect(request === null ? null : digestInput(request.pending, request.running, scene.params)).toBe(digest);
        } else {
          // 対象が無い遷移では新しい指紋を永続しない。次に対象が現れた遷移で指紋はまだ食い違っており、
          // 要求はそこで出る（機会を落とさない）。
          expect(requesting.state.requestedDigest).toBeNull();
          expect(persistedDigest(requesting.effects)).toBeNull();
        }

        // (3) 指紋が一致するなら要求は出ない（AC 5.6）。確定変化の Effect 列は出るが末尾が増えない。
        const suppressed = settle(
          prev,
          { ...moved, requestedDigest: digest },
          scene.params,
          scene.now,
          true,
        );
        expect(suppressed.ok).toBe(true);
        if (!suppressed.ok) return;
        expect(requestOf(suppressed.effects)).toBeNull();
        expect(suppressed.effects.length).toBe(received.effects.length);
        expect(suppressed.state.requestedDigest).toBe(digest);

        // (4) decide の配線。既存 5 遷移＋新 2 遷移はすべて要求してよい遷移であり、確定変化を生むなら
        //     指紋の食い違い（生成器の状態は未要求＝null）と計画対象の非空に応じて要求が出る。
        const outcome = decide(scene.state, scene.event, scene.params);
        if (!outcome.ok || outcome.effects.length === 0) return;
        const expected = digestInput(outcome.state.pendingOrders, outcome.state.timers, scene.params);
        const differs = expected !== scene.state.requestedDigest;
        const requestable = differs && planTargets(outcome.state.pendingOrders).length > 0;
        expect(requestOf(outcome.effects) !== null).toBe(requestable);
        expect(outcome.state.requestedDigest).toBe(requestable ? expected : scene.state.requestedDigest);
      }),
      { numRuns: 300 },
    );

    // 追加節の両側を踏んだこと（空の待ち行列で確定変化が起きる場面は、Timer 側だけが動く遷移で現れる）。
    expect(withTargets).toBeGreaterThan(0);
    expect(withoutTargets).toBeGreaterThan(0);
  });
});
