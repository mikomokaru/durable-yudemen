// tests/client/slot-card.example.test.tsx — 釜カードの提案操作の実描画テスト（slot-suggested-start 8.8）。
//
// **Validates: Requirements 2.1, 2.6, 2.7, 2.9, 2.10**
//
// 描くのは SlotCard 単体である。SlotBoard を丸ごと描けば WS 接続の作り物が要るが、ここで立てる主張は
// カードの DOM にしかない。表示語彙（商品名の代替・NFKC・時期の整形）は SlotBoard が組んで prop で渡す
// 設計ゆえ、ここでは渡した文字列がそのまま名として出ることを問う。
//
// **レイアウトの実効は問えない。** render プロジェクトは happy-dom（`vitest.config.ts:134`）で CSS を
// 計算せず、`flex-wrap` が実際に折り返すかは観測できない。問えるのは DOM 順（`[提案, Start]`）と親の
// クラス（`flex-wrap` / `justify-end` / `absolute right/bottom`）までである。折り返しの実際と可触寸法は
// 静的検査と実機確認が受ける。

import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SlotCard } from "../../src/client/components/SlotCard";
import type { QueueSuggestion } from "../../src/client/components/queueDisplay";
import type { SlotDisplay } from "../../src/client/components/slotDisplay";
import { noodleColors } from "../../src/client/components/noodleColor";
import { isNonEmpty, type NonEmptyArray } from "../../src/domain/timer";

afterEach(cleanup);

const noodleColor = noodleColors(["Thin", "Medium", "Thick"]);

function nonEmpty<T>(values: readonly T[]): NonEmptyArray<T> {
  if (!isNonEmpty(values)) throw new Error("テストの前提違反：非空のはず");
  return values;
}

function suggestion(overrides: Partial<QueueSuggestion> = {}): QueueSuggestion {
  return { slotIds: nonEmpty(["0"]), startAt: 1_700_000_000_000, boilSeconds: 60, ...overrides };
}

function idle(next: QueueSuggestion | null): SlotDisplay {
  return { kind: "idle", slot: 0, next };
}

/** 提案の見え方。SlotBoard が組む形（ラベル・aria-label・塗り）をテストから直接与える。 */
const SUGGESTION_OF = {
  label: "プレ塩 中盛 · かため · Table 12 · in 1:20",
  ariaLabel: "Suggested — プレ塩 · Slot 0 · in 1:20",
  tint: "oklch(0.7 0.1 40)",
} as const;

function cardElement(
  display: SlotDisplay,
  handlers: {
    // 型は実装の prop から引く（テスト側で関数型を書き直せば、署名が変わっても追随しない）。
    readonly onStart?: Mock<ComponentProps<typeof SlotCard>["onStart"]>;
    readonly onStartSuggested?: Mock<
      NonNullable<ComponentProps<typeof SlotCard>["onStartSuggested"]>
    >;
    readonly suggestionOf?: typeof SUGGESTION_OF | undefined;
  } = {},
) {
  return (
    <SlotCard
      display={display}
      onStart={handlers.onStart ?? vi.fn()}
      onCancel={vi.fn()}
      onComplete={vi.fn()}
      onAdjust={vi.fn()}
      noodleColor={noodleColor}
      suggestionOf={handlers.suggestionOf}
      onStartSuggested={handlers.onStartSuggested ?? vi.fn()}
    />
  );
}

describe("提案の操作が idle カードに現れる（R2.1・R2.10）", () => {
  it("提案があると 2 つのボタンが並び、DOM 順は [提案, Start] である", () => {
    render(cardElement(idle(suggestion()), { suggestionOf: SUGGESTION_OF }));

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    // 折り返したとき 1 行目（上）が提案・2 行目（下）が Start になるのは、この DOM 順と
    // 親の下端固定の組み合わせによる（要件 2.9 の根拠）。
    expect(buttons[0]?.getAttribute("aria-label")).toBe(SUGGESTION_OF.ariaLabel);
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Slot 0 — Start");
  });

  it("提案が無いと Start だけが残る（R2.9 — 位置の基準が変わらない）", () => {
    render(cardElement(idle(null)));

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Slot 0 — Start");
  });

  it("aria-label は SlotBoard が組んだ語をそのまま用い、命令形と自動開始の示唆を持たない", () => {
    render(cardElement(idle(suggestion()), { suggestionOf: SUGGESTION_OF }));

    const name = screen.getAllByRole("button")[0]?.getAttribute("aria-label") ?? "";
    // 機械は開始を指示しない（AC 8.2）。「Suggested」で提案であることを先に語る。
    expect(name).toContain("Suggested");
    expect(name).not.toMatch(/\bgo\b/i);
    expect(name).not.toMatch(/automatic/i);
    // 品目・釜・時期を含む（要件 2.10）。
    expect(name).toContain("プレ塩");
    expect(name).toContain("Slot 0");
    expect(name).toContain("in 1:20");
  });

  it("ラベルは渡された文字列をそのまま描く（表示語彙をカードで組み直さない）", () => {
    render(cardElement(idle(suggestion()), { suggestionOf: SUGGESTION_OF }));
    expect(screen.getByText(SUGGESTION_OF.label)).toBeDefined();
  });
});

describe("提案の押下（R2.6・R2.7）", () => {
  it("押すと提案そのものが渡り、ラジアル（onStart）は開かない", () => {
    const onStart = vi.fn<ComponentProps<typeof SlotCard>["onStart"]>();
    const onStartSuggested =
      vi.fn<NonNullable<ComponentProps<typeof SlotCard>["onStartSuggested"]>>();
    const next = suggestion({ slotIds: nonEmpty(["0", "2"]) });
    render(cardElement(idle(next), { onStart, onStartSuggested, suggestionOf: SUGGESTION_OF }));

    fireEvent.click(screen.getAllByRole("button")[0]!);

    // 推奨の slotIds 全体で開始する（釜ごとに切り出さない・要件 2.6）。深い等価ではなく同一性で問う
    // ——SlotBoard は参照の一致で品目の鍵を引くため、別物を渡せばその経路が壊れる。
    expect(onStartSuggested).toHaveBeenCalledTimes(1);
    expect(onStartSuggested.mock.calls[0]?.[0]).toBe(next);
    // ラジアルは開かない（押せば即開始・要件 2.7）。
    expect(onStart).not.toHaveBeenCalled();
  });

  it("Start を押すとラジアルが開き、提案は送られない", () => {
    const onStart = vi.fn<ComponentProps<typeof SlotCard>["onStart"]>();
    const onStartSuggested =
      vi.fn<NonNullable<ComponentProps<typeof SlotCard>["onStartSuggested"]>>();
    render(
      cardElement(idle(suggestion()), { onStart, onStartSuggested, suggestionOf: SUGGESTION_OF }),
    );

    fireEvent.click(screen.getAllByRole("button")[1]!);

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStartSuggested).not.toHaveBeenCalled();
  });
});

describe("提案と直前結果は同居する（design Component 2）", () => {
  it("直前結果のバッジと提案が同時に出る（場所を取り合わない）", () => {
    render(
      <SlotCard
        display={idle(suggestion())}
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onComplete={vi.fn()}
        onAdjust={vi.fn()}
        noodleColor={noodleColor}
        lastResultNoodle="Medium"
        suggestionOf={SUGGESTION_OF}
        onStartSuggested={vi.fn()}
      />,
    );

    // バッジはカード上部、提案は下部。優先も排他も要らない。
    expect(screen.getByText("Medium")).toBeDefined();
    expect(screen.getByText(SUGGESTION_OF.label)).toBeDefined();
  });
});
