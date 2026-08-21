// tests/core/receive.property.test.ts — 受領遷移（engine/receive の arriveRecords）の 4 つの Property。
//
// 対象は純粋関数ゆえ workerd に依らず既定 pool で走る。ここで見るのは engine の内側だけである——
// 同じ Property を DO 越し（put が 1 回・broadcast が 1 回）で見る側は shell のテストの担当。
//
// 生成器の方針：sequence number は実データと同じ桁数（56 桁）へ揃えた数値文字列にする。桁数が揃っていれば
// 辞書順が数値順に一致するという前提（isNewerSequence）を生成器自身が尊重し、順序が入り混じった受領列
// （新しい・同値・古いが混在する）を高い頻度で踏ませる。待ち行列は 3 つの注文の在/不在で振り、判定材料は
// 端末ごとに「未知・古い・新しい」を跨ぐ値を振る。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import type { Event, ReceivedOrder } from "../../src/engine/event";
import { EMPTY_STATE, isNewerSequence, type TimerState } from "../../src/engine/state";
import type { Effect } from "../../src/engine/effect";
import type { EpochMillis } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import { settleParams } from "../settleParams";

const PARAMS = settleParams({ arms: 2, toleranceRatio: 0.1 });
const NOW = 1_700_000_000_000 as EpochMillis;
const ARRIVAL = NOW - 30_000;

const ORDER_IDS = ["o-1", "o-2", "o-3"] as const;
const TERMINAL_IDS = ["t-1", "t-2"] as const;

/** 実データと同じ 56 桁へ揃える（桁数が同じなら辞書順が数値順に一致する）。 */
const toSequenceNumber = (n: number): string => String(n).padStart(56, "0");

function item(externalOrderId: string, itemIndex: number): PendingOrder {
  return {
    externalOrderId,
    itemIndex,
    noodleType: "Thin",
    firmness: "normal",
    tableId: null,
    arrivalTime: ARRIVAL,
    slotSpan: 1,
  };
}

/** 品目 0 件も作る（キャンセル・麺を含まない注文）。 */
const itemsOf = (externalOrderId: string, count: number): readonly PendingOrder[] =>
  Array.from({ length: count }, (_unused, itemIndex) => item(externalOrderId, itemIndex));

const genReceived: fc.Arbitrary<ReceivedOrder> = fc
  .record({
    externalOrderId: fc.constantFrom(...ORDER_IDS),
    terminalId: fc.constantFrom(...TERMINAL_IDS),
    sequence: fc.integer({ min: 0, max: 12 }),
    itemCount: fc.integer({ min: 0, max: 3 }),
  })
  .map(({ externalOrderId, terminalId, sequence, itemCount }) => ({
    externalOrderId,
    terminalId,
    sequenceNumber: toSequenceNumber(sequence),
    items: itemsOf(externalOrderId, itemCount),
  }));

/** 受領列（空・単独・複数端末混在・同一端末の連続をすべて踏む）。 */
const genReceivedList: fc.Arbitrary<readonly ReceivedOrder[]> = fc.array(genReceived, { maxLength: 6 });

/** 遷移前の状態。待ち行列は注文の在/不在、判定材料は端末ごとに未知・古い・新しいを跨ぐ。 */
const genState: fc.Arbitrary<TimerState> = fc
  .record({
    present: fc.subarray([...ORDER_IDS]),
    materials: fc.tuple(
      fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
      fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
    ),
  })
  .map(({ present, materials }) => {
    const pendingOrders = present.flatMap((externalOrderId) => itemsOf(externalOrderId, 2));
    const lastSequenceByTerminal: Record<string, string> = {};
    TERMINAL_IDS.forEach((terminalId, index) => {
      const sequence = materials[index];
      if (sequence !== undefined) lastSequenceByTerminal[terminalId] = toSequenceNumber(sequence);
    });
    return { ...EMPTY_STATE, pendingOrders, lastSequenceByTerminal };
  });

const genScene = fc.record({ state: genState, received: genReceivedList });

const eventOf = (received: readonly ReceivedOrder[]): Event => ({ type: "RecordsReceived", received, now: NOW });

const effectsOfType = (effects: readonly Effect[], type: Effect["type"]): readonly Effect[] =>
  effects.filter((effect) => effect.type === type);

/**
 * 受領列のうち受理される（重複でない）ものを、テスト側で独立に畳む。
 *
 * 実装と同じ述語（isNewerSequence）を使うのは、新旧の基準が 1 つであること自体が仕様だからである
 * （基準を書き写せば「テストの基準」という二つ目の真実が生まれる）。ここで独立に確かめるのは
 * 「畳んだ途中の値と突き合わせているか」という畳み方の側である。
 */
function foldAccepted(state: TimerState, received: readonly ReceivedOrder[]) {
  const material: Record<string, string> = { ...state.lastSequenceByTerminal };
  const accepted: ReceivedOrder[] = [];
  for (const one of received) {
    if (!isNewerSequence(one.sequenceNumber, material[one.terminalId])) continue;
    material[one.terminalId] = one.sequenceNumber;
    accepted.push(one);
  }
  return { material, accepted };
}

/** 受理された受領のうち、各注文について最後に効いたもの（集合の最終形を決める一件）。 */
function lastAcceptedByOrder(accepted: readonly ReceivedOrder[]): ReadonlyMap<string, ReceivedOrder> {
  const last = new Map<string, ReceivedOrder>();
  for (const one of accepted) last.set(one.externalOrderId, one);
  return last;
}

describe("engine/receive — 受領の畳み込み", () => {
  // Feature: pos-order-ingress, Property 20: 1 受領は 1 遷移・1 put である
  // **Validates: Requirements 5.5, 6.8, 10.7**
  //
  // Record 件数に比例して Persist が増えないことが主張の芯である。ループの中で settle を呼べば
  // ここが件数分になる。確定変化が無い受領（全件重複）では Effect が 1 つも出ないことも同時に見る。
  it("Property 20: Record 件数を問わず Persist は多くとも 1 つで、列の先頭に立つ", () => {
    fc.assert(
      fc.property(genScene, ({ state, received }) => {
        const outcome = decide(state, eventOf(received), PARAMS);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;

        if (outcome.state === state) {
          // 確定結果が変わらないなら put も broadcast もしない（既存の no-op 規律）。
          expect(outcome.effects).toEqual([]);
          return;
        }
        expect(effectsOfType(outcome.effects, "Persist")).toHaveLength(1);
        expect(outcome.effects[0]?.type).toBe("Persist");
        expect(effectsOfType(outcome.effects, "Broadcast")).toHaveLength(1);
      }),
      { numRuns: 300 },
    );
  });

  it("Property 20: 10 件の受領でも Persist は 1 回（件数に比例しない）", () => {
    const received = Array.from({ length: 10 }, (_unused, index) => ({
      externalOrderId: `o-${index}`,
      terminalId: "t-1",
      sequenceNumber: toSequenceNumber(index + 1),
      items: itemsOf(`o-${index}`, 1),
    }));

    const outcome = decide(EMPTY_STATE, eventOf(received), PARAMS);

    expect(outcome.ok && effectsOfType(outcome.effects, "Persist")).toHaveLength(1);
    expect(outcome.ok && effectsOfType(outcome.effects, "Broadcast")).toHaveLength(1);
    expect(outcome.ok && outcome.state.pendingOrders).toHaveLength(10);
    expect(outcome.ok && outcome.state.lastSequenceByTerminal).toEqual({ "t-1": toSequenceNumber(10) });
  });

  // Feature: pos-order-ingress, Property 14: 判定材料と状態は同時に確定する
  // **Validates: Requirements 10.7, 5.5**
  //
  // 判定材料が進んだ受領では、材料の更新と Pending_Order 集合の更新が同一の Persist に含まれる。
  // 「材料だけが進んだ状態」も「集合だけが進んだ状態」も生じない。
  //
  // Persist が運ぶ snapshot に材料が載るのはスキーマ v8 からである（別タスク）。ゆえにここが見るのは
  // 「確定が 1 回であること」と「その 1 回で両方が確定した状態が返ること」の 2 つである。
  it("Property 14: 材料の更新と集合の更新は同一の Persist に載る", () => {
    fc.assert(
      fc.property(genScene, ({ state, received }) => {
        const outcome = decide(state, eventOf(received), PARAMS);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;

        const { material, accepted } = foldAccepted(state, received);
        expect(outcome.state.lastSequenceByTerminal).toEqual(material);

        // 何も受理しなければ状態は 1 つも動かない（重複だけの受領）。
        if (accepted.length === 0) {
          expect(outcome.state).toBe(state);
          expect(outcome.effects).toEqual([]);
          return;
        }

        // 受理があれば確定は 1 回。その状態が集合の最終形も持つ（品目群は最後に効いた受領のもの）。
        expect(effectsOfType(outcome.effects, "Persist")).toHaveLength(1);
        for (const [externalOrderId, last] of lastAcceptedByOrder(accepted)) {
          const settled = outcome.state.pendingOrders.filter((o) => o.externalOrderId === externalOrderId);
          expect(settled.map((o) => o.itemIndex)).toEqual(last.items.map((o) => o.itemIndex));
        }
        // 受領が触れていない注文は巻き込まれない。
        const touched = new Set(accepted.map((one) => one.externalOrderId));
        expect(outcome.state.pendingOrders.filter((o) => !touched.has(o.externalOrderId))).toEqual(
          state.pendingOrders.filter((o) => !touched.has(o.externalOrderId)),
        );
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pos-order-ingress, Property 9: 冪等は収束する
  // **Validates: Requirements 10.2, 10.7, 9.9**
  //
  // 同一の受領を二度畳んでも確定状態は一致し、2 回目は集合も判定材料も動かない（Effect が 1 つも出ない）。
  // 上流の retry と bisect による重複がそのまま届く前提ゆえ、これが取り込みの芯である。
  it("Property 9: 同一受領の再適用は状態を変えず Effect を出さない", () => {
    fc.assert(
      fc.property(genScene, ({ state, received }) => {
        const first = decide(state, eventOf(received), PARAMS);
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const again = decide(first.state, eventOf(received), PARAMS);
        expect(again.ok).toBe(true);
        if (!again.ok) return;

        // 2 回目は同一インスタンスが返る（no-op が呼び出し側から === で見える）。
        expect(again.state).toBe(first.state);
        expect(again.effects).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pos-order-ingress, Property 16: 翻訳結果 0 件は除去または無変更に写る
  // **Validates: Requirements 6.11, 6.12**
  //
  // 既存があれば除去、無ければ集合は不変。**いずれの場合も判定材料は進む**——進めなければ同じ注文が
  // 再送のたびに翻訳をやり直される。
  it("Property 16: 0 件は既存ありで除去・既存なしで無変更、材料はいずれも進む", () => {
    fc.assert(
      fc.property(
        fc.record({
          state: genState,
          externalOrderId: fc.constantFrom(...ORDER_IDS),
          terminalId: fc.constantFrom(...TERMINAL_IDS),
          // 判定材料より必ず新しい値（0 件の写り方だけを見るため、重複の分岐を混ぜない）。
          sequence: fc.integer({ min: 13, max: 20 }),
        }),
        ({ state, externalOrderId, terminalId, sequence }) => {
          const sequenceNumber = toSequenceNumber(sequence);
          const outcome = decide(
            state,
            eventOf([{ externalOrderId, terminalId, sequenceNumber, items: [] }]),
            PARAMS,
          );
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;

          const existed = state.pendingOrders.some((o) => o.externalOrderId === externalOrderId);
          if (existed) {
            expect(outcome.state.pendingOrders).toEqual(
              state.pendingOrders.filter((o) => o.externalOrderId !== externalOrderId),
            );
          } else {
            // 集合は同一インスタンス（他の注文を巻き込まない）。
            expect(outcome.state.pendingOrders).toBe(state.pendingOrders);
          }
          // どちらの側でも材料は進み、その確定は 1 回の Persist に載る。
          expect(outcome.state.lastSequenceByTerminal[terminalId]).toBe(sequenceNumber);
          expect(effectsOfType(outcome.effects, "Persist")).toHaveLength(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
