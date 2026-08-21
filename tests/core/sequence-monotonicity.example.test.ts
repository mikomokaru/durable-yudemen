// tests/core/sequence-monotonicity.example.test.ts — 取り込みの冪等が拠る単調性の比較（pos-order-ingress AC 10.8）。
//
// 検査するのは 3 つ。実データの形（56 桁）で辞書順が数値順に一致すること、桁数が違えば短い方が小さいこと、
// 未知の端末と同値がそれぞれ「受理」「重複」に落ちること。

import { describe, expect, it } from "vitest";
import { EMPTY_STATE, isNewerSequence } from "../../src/engine/state";

/** KDS が採番する実際の形（56 桁の数値文字列）。 */
const SEQ = "49590338271490256608027716141221070800233838749102571522";
const NEXT = "49590338271490256608027716141221070800233838749102571523";
const PREVIOUS = "49590338271490256608027716141221070800233838749102571521";

describe("engine/state — sequence number の単調性", () => {
  it("桁数が同じなら辞書順が数値順に一致する（56 桁の実データ形）", () => {
    expect(SEQ).toHaveLength(56);
    expect(isNewerSequence(NEXT, SEQ)).toBe(true);
    expect(isNewerSequence(PREVIOUS, SEQ)).toBe(false);
    // 同値は重複——単調に「新しい」ものだけを受理する（再送で同じ注文が二度入らない）。
    expect(isNewerSequence(SEQ, SEQ)).toBe(false);
  });

  it("桁数が違えば短い方が小さい（辞書順そのままでは逆になる組で確かめる）", () => {
    // 素の文字列比較では "100" < "99" になる。桁数を先に見なければ、繰り上がりの瞬間に届いた注文が
    // すべて重複として弾かれる。
    expect("100" < "99").toBe(true);
    expect(isNewerSequence("100", "99")).toBe(true);
    expect(isNewerSequence("99", "100")).toBe(false);
  });

  it("未知の端末は常に受理する（空から始めれば最初の Record が必ず通る）", () => {
    expect(EMPTY_STATE.lastSequenceByTerminal).toEqual({});
    expect(isNewerSequence(SEQ, EMPTY_STATE.lastSequenceByTerminal["terminal-1"])).toBe(true);
  });
});
