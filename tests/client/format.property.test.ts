// tests/client/format.property.test.ts — formatRemaining の MM:SS 整形 property テスト。
// 任意の非負ミリ秒で MM:SS 形式・最小単位 1 秒・負を出さないことを検証する（要件5.4 / 5.6）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatRemaining } from "../../src/client/format";

describe("client/format", () => {
  // 任意の非負ミリ秒について、出力は MM:SS 形式で秒は 0〜59、最小単位 1 秒、負は決して出さない。
  it("任意の非負ミリ秒を MM:SS（秒は0〜59・最小単位1秒・負なし）へ整形する", () => {
    fc.assert(
      fc.property(
        // 非負の整数ミリ秒。大入力では分が 99 を超え桁が伸びるため上限を広く取る。
        fc.integer({ min: 0, max: 100 * 60 * 60 * 1000 }),
        (remainingMs) => {
          const out = formatRemaining(remainingMs);

          // MM:SS 形式（分は 2 桁を下限とし大入力で桁が伸びうる、秒は常に 2 桁）。
          expect(out).toMatch(/^\d{2,}:\d{2}$/);

          // 負の値・符号を決して含まない（要件5.6）。
          expect(out).not.toContain("-");

          const [minutesPart, secondsPart] = out.split(":");
          const minutes = Number(minutesPart);
          const seconds = Number(secondsPart);

          // 秒成分は 0〜59 に収まる。
          expect(seconds).toBeGreaterThanOrEqual(0);
          expect(seconds).toBeLessThanOrEqual(59);

          // 最小単位 1 秒（切り捨て）。total = floor(ms/1000) を分・秒へ分解した値に一致する。
          const totalSeconds = Math.floor(remainingMs / 1000);
          expect(minutes).toBe(Math.floor(totalSeconds / 60));
          expect(seconds).toBe(totalSeconds % 60);
        },
      ),
      { numRuns: 200 },
    );
  });
});
