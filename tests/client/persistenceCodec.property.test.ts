// offline-degradation Property 9 の残余 — 純粋コーデック単体の往復（localStorage を介さない）。
//
// **なぜ既存と別に書くか。** persistence-scope.property.test.ts は localStorageViewStore（端）を通した
// IO 経由の往復を 3 フィールド（timers / offset / processedIds）で主張している。純粋コーデック
// （serializeView / parsePersistedView）自体の往復・version: 1 の保持・不正 / 不在ブロブの畳み込みは
// どのテストも主張していない。ここでは IO を挟まず、純粋関数の対としての往復だけを主張する。
//
// **永続しないフィールドも主張に含める。** serializeView は connectivity / sync / error / unreachableReason を
// 含めない（導出・一過性ゆえ永続しない）。往復後にこれらが EMPTY_VIEW の既定値へ戻ることを主張するのは、
// 「導出値・一過性の状態を永続に昇格させない」規律の検査であり、PersistedView の型だけでは担保されない
// （型は「含めてよい」を禁じるが、実装が余剰キーを書くことは型が止めない）。
//
// 時刻はすべて生成器が引数値として吐く（Date.now のスタブも偽時計も用いない・要件13.4）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW } from "../../src/client/connection";
import { parsePersistedView, serializeView } from "../../src/client/persistence";
import { genClientView, genInvalidPersistedBlob } from "./generators";

/** 永続ブロブが持つべきキーの全量（これ以外は書かれない＝一過性フィールドは含まれない）。 */
const PERSISTED_KEYS = ["offset", "processedIds", "timers", "version"] as const;

const NUM_RUNS = 200;

describe("client/persistence serializeView / parsePersistedView — offline-degradation Property 9 の残余", () => {
  // Feature: offline-degradation, Property 9: 永続ブロブは直列化→解析で全フィールドを保存する（round-trip）。
  // 任意の ClientView について、parsePersistedView(serializeView(view)) は、元ビューの timers（各 id / slotId /
  // noodleType / endTime / origin を含む server / local 双方）・offset・processedIds（集合の要素）をすべて保存する。
  // serializeView の出力は version = 1 を持つ単一の JSON 文字列であり、空ビュー（timers 空・processedIds 空）に
  // 対しても往復で情報が落ちない。不在（null）または不正な入力に対して parsePersistedView は EMPTY_VIEW を返し、
  // 再水和後の connectivity は "down"（＝degraded）起点となる。
  //
  // **Validates: Requirements 11.1, 11.2, 11.3**
  it("Property 9: 純粋コーデックの往復で永続対象は保存され、一過性は既定へ戻り、不正 / 不在は EMPTY_VIEW", () => {
    let sawNonEmptyTimers = false;
    let sawNonEmptyProcessed = false;
    let sawEmptyView = false;
    let sawTransientDifference = false;

    fc.assert(
      // 空ビューを常数として混ぜるのは、timers 空・processedIds 空でも情報が落ちないことを確実に踏むため。
      fc.property(fc.oneof(fc.constant(EMPTY_VIEW), genClientView), genInvalidPersistedBlob, (view, invalid) => {
        const blob = serializeView(view);
        const restored = parsePersistedView(blob);

        // 単一の JSON 文字列であり version = 1 を持つ。キーは永続対象の 4 つだけ——connectivity / sync /
        // error / unreachableReason は書かれない（一過性・導出を永続に昇格させない）。
        const raw: unknown = JSON.parse(blob);
        expect(typeof raw === "object" && raw !== null).toBe(true);
        const record = raw as Record<string, unknown>;
        expect(record.version).toBe(1);
        expect(Object.keys(record).sort()).toEqual([...PERSISTED_KEYS]);

        // 往復で保存される事実（timers は各フィールドと起源タグを含めて同一・server / local 双方）。
        expect(restored.timers).toEqual(view.timers);
        expect(restored.offset).toBe(view.offset);
        expect([...restored.processedIds].sort()).toEqual([...view.processedIds].sort());

        // 一過性フィールドは復元されず EMPTY_VIEW の既定値（down / connecting / null / offline）へ戻る。
        expect(restored.connectivity).toBe(EMPTY_VIEW.connectivity);
        expect(restored.sync).toBe(EMPTY_VIEW.sync);
        expect(restored.error).toBe(EMPTY_VIEW.error);
        expect(restored.unreachableReason).toBe(EMPTY_VIEW.unreachableReason);

        // 不正 / 不在は EMPTY_VIEW へ畳む。再水和は connectivity "down" 起点・unreachableReason "offline" 起点。
        for (const blobUnderTest of [invalid, null]) {
          const fallback = parsePersistedView(blobUnderTest);
          expect(fallback).toEqual(EMPTY_VIEW);
          expect(fallback.connectivity).toBe("down");
          expect(fallback.unreachableReason).toBe("offline");
        }

        // 空虚な緑を避けるための実測——「常に EMPTY_VIEW を返す parsePersistedView」でも不正側の主張は
        // 緑になる。上の往復の主張が実際に非空の値を復元し、かつ一過性が既定と異なる盤面を踏んでいるか。
        if (view.timers.length > 0) sawNonEmptyTimers = true;
        if (view.processedIds.size > 0) sawNonEmptyProcessed = true;
        if (view.timers.length === 0 && view.processedIds.size === 0) sawEmptyView = true;
        if (
          view.connectivity !== EMPTY_VIEW.connectivity ||
          view.sync !== EMPTY_VIEW.sync ||
          view.error !== EMPTY_VIEW.error ||
          view.unreachableReason !== EMPTY_VIEW.unreachableReason
        ) {
          sawTransientDifference = true;
        }
      }),
      { numRuns: NUM_RUNS },
    );

    expect(sawNonEmptyTimers).toBe(true);
    expect(sawNonEmptyProcessed).toBe(true);
    expect(sawEmptyView).toBe(true);
    expect(sawTransientDifference).toBe(true);
  });
});
