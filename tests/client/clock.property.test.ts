// tests/client/clock.property.test.ts — 残り時間導出のクランプ性質（タスク16.2）。
// 残り秒は状態ではなく endTime（事実）と補正後現在時刻からの導出値であり、決して負を出さない。
// offset は serverTime と localReceipt から導出するため、ここでは clockOffset → remainingMs の
// 連鎖全体を任意の絶対時刻で検証する（要件4.3 / 4.4 / 5.1 / 5.6 / 10.3 / 10.4）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clockOffset, correctedNow, remainingMs } from "../../src/client/clock";

// エポックミリ秒の絶対時刻として現実的な範囲（負・大値も含めてクランプ性を崩さないことを見る）。
const genEpochMillis = fc.integer({ min: -8_640_000_000_000, max: 8_640_000_000_000 });

describe("client/clock 残りのクランプ", () => {
  // 任意の endTime / serverTime / localReceipt / 現在時刻について、導出した残りは常に 0 以上。
  it("残り時間は決して負にならない", () => {
    fc.assert(
      fc.property(genEpochMillis, genEpochMillis, genEpochMillis, genEpochMillis, (endTime, serverTime, localReceipt, now) => {
        const offset = clockOffset(serverTime, localReceipt);
        const remaining = remainingMs(endTime, offset, now);
        expect(remaining).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  // 補正後現在時刻が endTime 以上のとき、残りは厳密に 0 になる。
  it("補正後現在時刻 ≥ endTime のとき残りは 0", () => {
    fc.assert(
      fc.property(genEpochMillis, genEpochMillis, genEpochMillis, genEpochMillis, (endTime, serverTime, localReceipt, now) => {
        const offset = clockOffset(serverTime, localReceipt);
        // 補正後現在時刻が endTime 以上である入力に絞ってからクランプ結果を確認する。
        fc.pre(correctedNow(offset, now) >= endTime);
        expect(remainingMs(endTime, offset, now)).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});
