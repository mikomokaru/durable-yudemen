// tests/client/suggestionTiming.property.test.ts — 提案の時期の導出（lapsed-suggestion-timing Property 5.1〜5.6）。
//
// **Validates: Requirements 5.1, 5.2, 5.3, 5.5, 5.6**
//
// 時期は状態ではない。計画の間隔（サーバの事実からの導出）と補正後現在時刻からの導出値であり、
// 受け取った `startAt` を書き換えない。ここで問うのは、その導出が満たすべき 5 つの不変である。
//
// **絶対の表示時刻を 1 つの式で書く。** `kind === "now"` なら現在、それ以外は `現在 + ms`。
// 性質はすべてこの式で述べられる——相を跨いで同じ量を比べられることが、3 相に分けても
// 「1 つの時刻を答えている」ことの証拠である。
//
// 性質 5.4（端末間の一致）はここでは問えない。`suggestionTiming` は担当範囲を知らず錨を引数で
// 受けるだけなので自明に真になる。中身は `SlotBoard` の錨の導出に住むため、実描画テストが受ける
// （`tests/client/lapsedSuggestion.example.test.tsx`）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { suggestionTiming, type SuggestionTiming } from "../../src/client/components/queueDisplay";

/** 絶対の表示時刻。相を跨いで比べられる唯一の量。 */
function shownAt(timing: SuggestionTiming, corrected: number): number {
  return timing.kind === "now" ? corrected : corrected + timing.ms;
}

const genTime = fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 });
/** 計画内オフセット（1 本目からの間隔）。錨が最小ゆえ非負である。 */
const genOffset = fc.integer({ min: 0, max: 3_600_000 });

describe("Feature: lapsed-suggestion-timing, Property 5.1: 単調性", () => {
  it("現在時刻が進んでも表示時刻は後退しない", () => {
    fc.assert(
      fc.property(
        genTime,
        genOffset,
        genTime,
        fc.nat({ max: 3_600_000 }),
        (anchor, offset, corrected, step) => {
          const startAt = anchor + offset;
          const before = shownAt(suggestionTiming(startAt, anchor, corrected), corrected);
          const after = shownAt(
            suggestionTiming(startAt, anchor, corrected + step),
            corrected + step,
          );
          // 表示が前に戻れば「始める時刻が早まった」と嘘をつくことになる。
          expect(after).toBeGreaterThanOrEqual(before);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("Feature: lapsed-suggestion-timing, Property 5.2: 実行可能性", () => {
  it("表示時刻は受け取った startAt 以上である", () => {
    fc.assert(
      fc.property(genTime, genOffset, genTime, (anchor, offset, corrected) => {
        const startAt = anchor + offset;
        // 後ろへしか動かないため、釜の解放制約（元の startAt が既に満たしている）を破らない。
        expect(
          shownAt(suggestionTiming(startAt, anchor, corrected), corrected),
        ).toBeGreaterThanOrEqual(startAt);
      }),
      { numRuns: 300 },
    );
  });
});

describe("Feature: lapsed-suggestion-timing, Property 5.3: 同期の保存", () => {
  it("任意の 2 提案の表示時刻の差は startAt の差に等しい", () => {
    fc.assert(
      fc.property(genTime, genOffset, genOffset, genTime, (anchor, offsetA, offsetB, corrected) => {
        const a = anchor + offsetA;
        const b = anchor + offsetB;
        const shownA = shownAt(suggestionTiming(a, anchor, corrected), corrected);
        const shownB = shownAt(suggestionTiming(b, anchor, corrected), corrected);
        // 差が保たれることは提供時刻の同期が保たれることそのものである
        // （serveAt = startAt + 茹で時間 ゆえ、全員が同じ量だけ後ろへ動けば serveAt の差も不変）。
        expect(shownA - shownB).toBe(a - b);
      }),
      { numRuns: 300 },
    );
  });
});

describe("Feature: lapsed-suggestion-timing, Property 5.5: 秒読みとの連続性", () => {
  it("錨が未来の間、表示時刻は受け取った startAt そのものである", () => {
    fc.assert(
      fc.property(
        genTime,
        genOffset,
        fc.integer({ min: 1, max: 3_600_000 }),
        (anchor, offset, lead) => {
          const corrected = anchor - lead; // 錨は未来
          const timing = suggestionTiming(anchor + offset, anchor, corrected);
          expect(timing.kind).toBe("countdown");
          // 変更前の表示（startAt − 現在）と一致する。既存の秒読みの検査が通り続ける根拠である。
          if (timing.kind !== "countdown") return;
          expect(timing.ms).toBe(anchor + offset - corrected);
          expect(shownAt(timing, corrected)).toBe(anchor + offset);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("Feature: lapsed-suggestion-timing, Property 5.6: 収束の消滅", () => {
  it("now になるのは計画内オフセットが 0 のときだけである", () => {
    fc.assert(
      fc.property(genTime, genOffset, genTime, (anchor, offset, corrected) => {
        const timing = suggestionTiming(anchor + offset, anchor, corrected);
        // 放置しても「全部 now」へ崩れない。崩れれば順序と間隔が画面から消える。
        expect(timing.kind === "now").toBe(offset === 0 && anchor <= corrected);
      }),
      { numRuns: 300 },
    );
  });

  it("錨が過ぎたあと、オフセットが正の提案は offset 相に入り ms が間隔そのものになる", () => {
    fc.assert(
      fc.property(
        genTime,
        fc.integer({ min: 1, max: 3_600_000 }),
        fc.nat({ max: 3_600_000 }),
        (anchor, offset, over) => {
          const corrected = anchor + over; // 錨は過ぎている
          const timing = suggestionTiming(anchor + offset, anchor, corrected);
          expect(timing.kind).toBe("offset");
          if (timing.kind !== "offset") return;
          // ms は 1 本目からの間隔。現在時刻に依らない（ゆえに状態変化まで静止する）。
          expect(timing.ms).toBe(offset);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("Feature: lapsed-suggestion-timing — 相の網羅と now の情報量", () => {
  it("3 相のいずれかに必ず入り、now は ms を持たない", () => {
    fc.assert(
      fc.property(genTime, genOffset, genTime, (anchor, offset, corrected) => {
        const timing = suggestionTiming(anchor + offset, anchor, corrected);
        expect(["countdown", "now", "offset"]).toContain(timing.kind);
        // 常に 0 である項目は情報を持たない（型からも落ちていることを値の形で確かめる）。
        if (timing.kind === "now") expect(Object.keys(timing)).toEqual(["kind"]);
      }),
      { numRuns: 300 },
    );
  });
});
