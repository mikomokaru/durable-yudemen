// tests/client/slot-card.example.test.tsx — 釜カードの提案の実描画テスト（lift-group-display）。
//
// **Validates: Requirements 2.2, 2.3, 2.4, 2.11, 3.1, 3.3〜3.7**
//
// 描くのは SlotCard 単体である。表示語彙（商品名の代替・NFKC・`now` / `queued`）は SlotBoard が組んで resolver で
// 渡す設計ゆえ、ここでは渡した文字列がそのまま名として出ることと、導出の `role` で分岐した形——`head` にだけ
// 丸ボタン・濃い塗り、`member` は薄いラベルだけ——を問う。本物の `suggestionOf` の語と `startOrderItem` への配線、
// 店舗全体で先頭 arms 本の上限は `slot-board-suggestions.example.test.tsx` が SlotBoard を実描画して固定する
// （時刻の語の不在・Requirement 6.4 もそちら）。
//
// 「member にボタンが無い」「member が濃くない」は型が強制しない（JSX の分岐は型の外にある）。見え方の
// `SuggestionView` は判別を持たず（文字列と色だけ）、分岐は導出の `SlotSuggestion` からしか取れないが、描画側の
// 分岐が崩れれば「押せないのに押せる」経路が生まれる。ゆえに AC 3.6 は型とこの Example の両方で担う
// （design Component 5・実装注記）。
//
// **レイアウトの実効は問えない。** render プロジェクトは happy-dom（`vitest.config.ts`）で CSS を計算せず、
// `flex-wrap` が実際に折り返すかは観測できない。問えるのは DOM 順（`[提案…, Start]`）と親のクラス
// （`flex-wrap` / `justify-end` / `absolute right/bottom`）までである。折り返しの実際と可触寸法は静的検査と
// 実機確認が受ける。薄さも同じく class（`opacity-60`）の有無で問う。

import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SlotCard, type SuggestionView } from "../../src/client/components/SlotCard";
import type { GroupItem, SlotSuggestion } from "../../src/client/components/liftGroups";
import type { SlotDisplay } from "../../src/client/components/slotDisplay";
import { noodleColors } from "../../src/client/components/noodleColor";
import type { PendingOrder } from "../../src/domain/order";
import { nonEmpty } from "../nonEmpty";

afterEach(cleanup);

const noodleColor = noodleColors(["Thin", "Medium", "Thick"]);
const T0 = 1_700_000_000_000;

function item(externalOrderId: string, overrides: Partial<PendingOrder> = {}): GroupItem {
  return {
    order: {
      externalOrderId,
      itemIndex: 0,
      noodleType: "Thin",
      firmness: "hard",
      tableId: "12",
      arrivalTime: T0 - 60_000,
      slotSpan: 1,
      itemName: "プレ塩",
      sizeName: "中盛",
      ...overrides,
    },
    suggestion: { slotIds: nonEmpty(["0"]), startAt: T0, boilSeconds: 60, serveAt: T0 + 60_000 },
  };
}

/** 導出の 2 形（先頭・後続）。先頭は常に濃く押せ、後続は常に薄く押せない（判断 21）。 */
const HEAD: SlotSuggestion = { role: "head", item: item("head") };
const MEMBER: SlotSuggestion = { role: "member", item: item("member") };
/** 2 本目の先頭（arms 2 で並ぶ形）。 */
const SECOND_HEAD: SlotSuggestion = { role: "head", item: item("second") };

const TINT = "oklch(0.7 0.1 40)";

/**
 * 見え方の resolver。SlotBoard が組む形（ラベル・aria-label・塗り）をテストから直接与える。語は SlotBoard の
 * 語彙をなぞる——可視の語は空か `now`、aria-label の末尾だけが `now` / `queued`。判別は返せない
 * （`SuggestionView` に無い）。
 */
function suggestionOf(suggestion: SlotSuggestion): SuggestionView {
  const name = suggestion.item.order.externalOrderId;
  if (suggestion.role === "member") {
    return {
      label: `${name} 中盛 · かため · Table 12`,
      ariaLabel: `Suggested — ${name} · Slot 0 · queued`,
      tint: TINT,
    };
  }
  return {
    label: `${name} 中盛 · かため · Table 12 · now`,
    ariaLabel: `Suggested — ${name} · Slot 0 · now`,
    tint: TINT,
  };
}

function idle(next: readonly SlotSuggestion[]): SlotDisplay {
  return { kind: "idle", slot: 0, next };
}

function cardElement(
  display: SlotDisplay,
  handlers: {
    // 型は実装の prop から引く（テスト側で関数型を書き直せば、署名が変わっても追随しない）。
    readonly onStart?: Mock<ComponentProps<typeof SlotCard>["onStart"]>;
    readonly onStartSuggested?: Mock<ComponentProps<typeof SlotCard>["onStartSuggested"]>;
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
      suggestionOf={suggestionOf}
      onStartSuggested={handlers.onStartSuggested ?? vi.fn()}
    />
  );
}

/** 提案の操作スタック（提案 1 件＝group 1 つ・`data-role` を持つ）。Start のスタックは持たない。 */
function suggestionStacks(): readonly HTMLElement[] {
  return screen.queryAllByRole("group");
}

/** スタックの役と薄さ（`data-role` と `opacity-60` の有無）。 */
function shapeOf(stack: HTMLElement) {
  return { role: stack.dataset["role"], faint: stack.classList.contains("opacity-60") };
}

describe("head は丸ボタンを持ち濃く、語と aria-label が now を語る（R2.2・R3.4・R3.7）", () => {
  it("先頭：丸ボタンがあり、語は now、aria-label も now（可視の語と食い違わない）、薄くない", () => {
    render(cardElement(idle([HEAD])));

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Suggested — head · Slot 0 · now");
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Slot 0 — Start");
    expect(screen.getByText("head 中盛 · かため · Table 12 · now")).toBeDefined();
    // 提案 1 件は group 1 つ。ボタンと同じ名を持ち、ボタンはその中に在る。
    const group = screen.getByRole("group", { name: "Suggested — head · Slot 0 · now" });
    expect(group.contains(buttons[0]!)).toBe(true);
    expect(suggestionStacks().map(shapeOf)).toEqual([{ role: "head", faint: false }]);
  });

  it("aria-label は提案であることを先に語り、命令形と自動開始の示唆を持たない（R3.3）", () => {
    render(cardElement(idle([HEAD, SECOND_HEAD])));

    for (const button of screen.getAllByRole("button").slice(0, 2)) {
      const name = button.getAttribute("aria-label") ?? "";
      expect(name).toContain("Suggested");
      expect(name).not.toMatch(/\bgo\b/i);
      expect(name).not.toMatch(/automatic/i);
      expect(name).toContain("Slot 0");
    }
  });
});

describe("member はラベルだけで、ボタンを持たず、薄く、濃くならない（R2.3・R2.4・R3.6）", () => {
  it("member だけの idle：ボタンは Start の 1 つ、ラベルと aria-label（queued）は出て、薄い", () => {
    render(cardElement(idle([MEMBER])));

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Slot 0 — Start");
    expect(screen.getByText("member 中盛 · かため · Table 12")).toBeDefined();
    // aria-label は role を持つ要素（group）に置く。素の span に置けば generic role で支援技術が無視する。
    expect(
      screen.getByRole("group", { name: "Suggested — member · Slot 0 · queued" }),
    ).toBeDefined();
    // 濃くない（startAt が過ぎていても導出が member なら薄いまま・AC 2.3）。
    expect(suggestionStacks().map(shapeOf)).toEqual([{ role: "member", faint: true }]);
  });

  it("見え方の resolver は押せる・濃いを決められない（判別は導出にだけ在る）", () => {
    // resolver が member に head の語（`now`）を返しても、ボタンは現れず薄いまま——見え方は文字列と色だけで、
    // 分岐は導出の role からしか取れない（二つ目の真実を持たない）。
    render(
      <SlotCard
        display={idle([MEMBER])}
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onComplete={vi.fn()}
        onAdjust={vi.fn()}
        noodleColor={noodleColor}
        suggestionOf={() => ({
          label: "member · now",
          ariaLabel: "Suggested — member · now",
          tint: TINT,
        })}
        onStartSuggested={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(shapeOf(screen.getByRole("group", { name: "Suggested — member · now" }))).toEqual({
      role: "member",
      faint: true,
    });
  });

  it("head と member が並ぶとき、押せるのは head だけで、member のスタックにボタンが無い", () => {
    const onStartSuggested = vi.fn<ComponentProps<typeof SlotCard>["onStartSuggested"]>();
    render(cardElement(idle([HEAD, MEMBER]), { onStartSuggested }));

    const stacks = suggestionStacks();
    expect(stacks).toHaveLength(2);
    expect(stacks[0]?.querySelectorAll("button")).toHaveLength(1);
    expect(stacks[1]?.querySelectorAll("button")).toHaveLength(0);
    expect(stacks.map(shapeOf)).toEqual([
      { role: "head", faint: false },
      { role: "member", faint: true },
    ]);
    // member のラベルを押しても何も起きない（押す口が構造から無い）。
    fireEvent.click(screen.getByText("member 中盛 · かため · Table 12"));
    expect(onStartSuggested).not.toHaveBeenCalled();
  });
});

describe("提案の押下（R3.1）", () => {
  it("先頭を押すと品目（GroupItem）が渡り、ラジアル（onStart）は開かない", () => {
    const onStart = vi.fn<ComponentProps<typeof SlotCard>["onStart"]>();
    const onStartSuggested = vi.fn<ComponentProps<typeof SlotCard>["onStartSuggested"]>();
    render(cardElement(idle([HEAD]), { onStart, onStartSuggested }));

    fireEvent.click(screen.getAllByRole("button")[0]!);

    // 品目を指して開始する。推奨の slotIds 全体は item.suggestion が運ぶ（釜ごとに切り出さない）。
    // 同一性で問う——SlotBoard は order から鍵を取り suggestion.slotIds を送るため、別物を渡せば経路が壊れる。
    expect(onStartSuggested).toHaveBeenCalledTimes(1);
    expect(onStartSuggested.mock.calls[0]?.[0]).toBe(HEAD.item);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("Start を押すとラジアルが開き、提案は送られない", () => {
    const onStart = vi.fn<ComponentProps<typeof SlotCard>["onStart"]>();
    const onStartSuggested = vi.fn<ComponentProps<typeof SlotCard>["onStartSuggested"]>();
    render(cardElement(idle([HEAD]), { onStart, onStartSuggested }));

    fireEvent.click(screen.getByLabelText("Slot 0 — Start"));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStartSuggested).not.toHaveBeenCalled();
  });
});

describe("複数の提案と Start の配置（R2.11・R3.5）", () => {
  it("提案が無いと Start だけが残る（位置の基準が変わらない）", () => {
    render(cardElement(idle([])));

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Slot 0 — Start");
    expect(suggestionStacks()).toHaveLength(0);
  });

  it("提案が複数並んでも DOM 順は [提案…, Start] で、親は下端固定・折り返し・右寄せのまま", () => {
    render(cardElement(idle([HEAD, MEMBER, SECOND_HEAD])));

    const start = screen.getByLabelText("Slot 0 — Start");
    const row = start.closest(".flex-wrap");
    expect(row).not.toBeNull();
    // 折り返したとき上の行が提案・下の行が Start になるのは、DOM 順と下端固定の組み合わせによる。
    const children = [...row!.children];
    expect(children).toHaveLength(4);
    expect(children.slice(0, 3).every((child) => child.hasAttribute("data-role"))).toBe(true);
    expect(children[3]?.contains(start)).toBe(true);
    for (const cls of ["flex-wrap", "justify-end", "items-end", "absolute"]) {
      expect(row!.classList.contains(cls)).toBe(true);
    }
    expect([...row!.classList].some((cls) => cls.startsWith("right-["))).toBe(true);
    expect([...row!.classList].some((cls) => cls.startsWith("bottom-["))).toBe(true);
  });
});

describe("提案と直前結果は同居する（slot-suggested-start design Component 2）", () => {
  it("直前結果のバッジと提案が同時に出る（場所を取り合わない）", () => {
    render(
      <SlotCard
        display={idle([HEAD])}
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onComplete={vi.fn()}
        onAdjust={vi.fn()}
        noodleColor={noodleColor}
        lastResultNoodle="Medium"
        suggestionOf={suggestionOf}
        onStartSuggested={vi.fn()}
      />,
    );

    // バッジはカード上部、提案は下部。優先も排他も要らない。
    expect(screen.getByText("Medium")).toBeDefined();
    expect(screen.getByText("head 中盛 · かため · Table 12 · now")).toBeDefined();
  });
});
