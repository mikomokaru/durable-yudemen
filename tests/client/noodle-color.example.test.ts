// tests/client/noodle-color.example.test.ts — 麺色の導出（noodleColor.ts）。残滓用の彩度落とし（fadedTint）。
//
// 残滓（idle スロットの直前結果）は過去の best-effort 情報で、稼働中のピルと同じ彩度で塗ると遠目に見分けが
// つかない（厨房での実感・2026-09-07）。色相＝麺種の identity は保ち、彩度をモノクロにほんのり色が残る程度まで
// 落とし、明度も一段下げる。

import { describe, expect, it } from "vitest";
import { fadedTint, noodleColors } from "../../src/client/components/noodleColor";

const parse = (color: string) => {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  if (match === null) throw new Error(`oklch でない: ${color}`);
  return { l: Number(match[1]), c: Number(match[2]), h: match[3]! };
};

describe("fadedTint — 残滓の彩度落とし", () => {
  const menu = ["Thin", "Medium", "Thick", "Udon", "Soba"];
  const noodleColor = noodleColors(menu);

  it("色相は保ち、彩度はパレットの 1/3 未満、明度は一段暗い（全麺種）", () => {
    for (const noodleType of menu) {
      const running = parse(noodleColor(noodleType));
      const faded = parse(fadedTint(noodleColor(noodleType)));
      expect(faded.h).toBe(running.h);
      expect(faded.c).toBeLessThan(running.c / 3);
      expect(faded.l).toBeLessThan(running.l);
      expect(fadedTint(noodleColor(noodleType))).not.toBe(noodleColor(noodleType));
    }
  });

  it("残滓どうしは色相で弁別できる（彩度を落としても麺種の identity は残る）", () => {
    const hues = new Set(menu.map((noodleType) => parse(fadedTint(noodleColor(noodleType))).h));
    expect(hues.size).toBe(menu.length);
  });

  it("oklch でない色はそのまま返す（新しい状態を持たない）", () => {
    expect(fadedTint("#ffffff")).toBe("#ffffff");
    expect(fadedTint("var(--color-danger)")).toBe("var(--color-danger)");
  });
});
