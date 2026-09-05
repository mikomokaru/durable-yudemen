// tests/client/lapsedSuggestion.example.test.tsx — 過ぎた提案の語・静止・端末間の一致
// （lapsed-suggestion-timing task 7）。
//
// **Validates: Requirements 1.6, 3.2, 3.3, 5.4**
//
// 盤面を実描画し、カードへ渡った時期の語を観測する。`SlotCard` を差し替えて props を捕らえるのは
// `tests/client/audioWiring.example.test.ts:45-70` の前例に倣う——HTML から文字列を拾うより、
// 「何を渡したか」を直接見る方が主張が短い。
//
// **性質 5.4（端末間の一致）はここでしか問えない。** `suggestionTiming` は担当範囲を知らず錨を引数で
// 受けるだけなので、その PBT では自明に真になる。中身は `SlotBoard` の錨の導出——受信した推奨の全量から
// 取ること——に住む。ゆえに担当範囲の違う盤面を 2 枚描いて比べる。
//
// `Date.now` を固定する。`SlotBoard.tsx:69` が直接読むため、時刻を進めて静止を問うには spy が要る。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlotCard } from "../../src/client/components/SlotCard";
import { SlotBoard } from "../../src/client/components/SlotBoard";
import { EMPTY_VIEW, type ClientView, type TimerConnection } from "../../src/client/connection";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import type { PendingOrder } from "../../src/domain/order";
import type { CookRecommendation } from "../../src/domain/messages";
import { isNonEmpty, type NonEmptyArray } from "../../src/domain/timer";

type SlotCardProps = Parameters<typeof SlotCard>[0];

const capture = vi.hoisted(() => ({ slotCards: [] as SlotCardProps[] }));

// SlotBoard は useSyncExternalStore を 2 引数で呼ぶ。サーバ描画は getServerSnapshot を要求して落ちるため、
// 初回描画の意味（getSnapshot() の値を返す）と同形へ置き換える（audioWiring と同じ理由・同じ形）。
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T): T => getSnapshot(),
  };
});

vi.mock("../../src/client/components/SlotCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/components/SlotCard")>();
  const { createElement: element } = await import("react");
  return {
    SlotCard: (props: SlotCardProps) => {
      capture.slotCards.push(props);
      return element(actual.SlotCard, props);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = 1_700_000_000_000;
const NOODLE = DEFAULT_NOODLE_PRESETS[0].noodleType;

function nonEmpty<T>(values: readonly T[]): NonEmptyArray<T> {
  if (!isNonEmpty(values)) throw new Error("テストの前提違反：非空のはず");
  return values;
}

function order(externalOrderId: string): PendingOrder {
  return {
    externalOrderId,
    itemIndex: 0,
    noodleType: NOODLE,
    firmness: "normal",
    tableId: "5",
    arrivalTime: NOW - 60_000,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
  };
}

function recommendation(
  externalOrderId: string,
  slot: number,
  startAt: number,
): CookRecommendation {
  return {
    externalOrderId,
    itemIndex: 0,
    slotIds: nonEmpty([String(slot)]),
    startAt,
    group: "g",
    anchor: null,
  };
}

/** 待ち行列と推奨だけを差し替えた同期済みビュー。走行中 Timer は置かない（全釜が idle）。 */
function boardView(
  pendingOrders: readonly PendingOrder[],
  recommendations: readonly CookRecommendation[],
): ClientView {
  return {
    ...EMPTY_VIEW,
    sync: "synced",
    connectivity: "up",
    unitCount: 2,
    noodlePresets: DEFAULT_NOODLE_PRESETS,
    pendingOrders,
    recommendations,
  };
}

/**
 * ラベルの末尾の区画（時期）だけを取り出す。
 *
 * ラベルは `商品名 · 茹で加減 · 卓 · 時期` を ` · ` で継いだ形で、時期は常に末尾に来る。部分一致で
 * 問うと麺種名に紛れる——`Thin ` は `in ` を含む。区画で切れば主張が時期だけを指す。
 */
function timingOf(label: string | undefined): string | undefined {
  return label?.split(" · ").at(-1);
}

/** 盤面を実描画し、スロットごとの提案の見え方を引ける形で返す。 */
function renderBoard(view: ClientView, units: readonly number[]) {
  capture.slotCards.length = 0;
  const connection: TimerConnection = {
    getView: () => view,
    subscribe: () => () => {},
    start: vi.fn<TimerConnection["start"]>(),
    startOrderItem: vi.fn<TimerConnection["startOrderItem"]>(),
    cancel: vi.fn<TimerConnection["cancel"]>(),
    complete: vi.fn<TimerConnection["complete"]>(),
    adjust: vi.fn<TimerConnection["adjust"]>(),
    close: () => {},
  };
  renderToStaticMarkup(createElement(SlotBoard, { connection, units, playTouchCue: () => {} }));
  const cards = [...capture.slotCards];
  return {
    suggestion: (slot: number) => cards.find((props) => props.display.slot === slot)?.suggestionOf,
  };
}

describe("時期の語は 3 相に分かれる（R1.2 / R1.3 / R1.4）", () => {
  it("錨が未来なら in mm:ss（サーバの時刻への秒読み）", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    // 錨は 90 秒先。分も 2 桁ゼロ詰めゆえ 01:30 になる（m:ss ではない）。
    const view = boardView([order("o-1")], [recommendation("o-1", 0, NOW + 90_000)]);

    expect(timingOf(renderBoard(view, [0]).suggestion(0)?.label)).toBe("in 01:30");
  });

  it("錨が過ぎ、間隔 0 の提案は now", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const view = boardView([order("o-1")], [recommendation("o-1", 0, NOW - 10_000)]);

    expect(timingOf(renderBoard(view, [0]).suggestion(0)?.label)).toBe("now");
  });

  it("錨が過ぎ、間隔が正の提案は +mm:ss（1 本目からの間隔）", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const view = boardView(
      [order("o-1"), order("o-2")],
      [
        recommendation("o-1", 0, NOW - 10_000), // 錨（1 本目）
        recommendation("o-2", 1, NOW + 110_000), // 錨から 120 秒後
      ],
    );

    const board = renderBoard(view, [0]);
    expect(timingOf(board.suggestion(0)?.label)).toBe("now");
    // 現在からの残り（110 秒＝01:50）ではなく 1 本目からの間隔（120 秒＝02:00）を描く。
    expect(timingOf(board.suggestion(1)?.label)).toBe("+02:00");
  });
});

describe("aria-label は可視ラベルと同じ時期の語を持つ（R1.6）", () => {
  it("3 相のいずれでも語が一致する", () => {
    for (const [startAt, expected] of [
      [NOW + 90_000, "in 01:30"],
      [NOW - 10_000, "now"],
    ] as const) {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const view = boardView([order("o-1")], [recommendation("o-1", 0, startAt)]);
      const shown = renderBoard(view, [0]).suggestion(0);
      // 時期の語彙を二箇所に作らない（片方だけ直す余地を残さない）。
      expect(timingOf(shown?.label)).toBe(expected);
      expect(timingOf(shown?.ariaLabel)).toBe(expected);
    }
  });
});

describe("過ぎた計画の表示は静止する（R3.3）", () => {
  it("状態変化なしに時刻だけ進めても語が変わらない", () => {
    const view = boardView(
      [order("o-1"), order("o-2")],
      [recommendation("o-1", 0, NOW), recommendation("o-2", 1, NOW + 120_000)],
    );

    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const first = renderBoard(view, [0]);
    const labels = [first.suggestion(0)?.label, first.suggestion(1)?.label];
    expect(timingOf(labels[0])).toBe("now");
    expect(timingOf(labels[1])).toBe("+02:00");

    // 10 分進める。同じビュー（状態変化なし）で描き直す。
    vi.spyOn(Date, "now").mockReturnValue(NOW + 600_000);
    const later = renderBoard(view, [0]);

    // 変更前は両方が now へ崩れた。いまは順序と間隔が残る。
    expect(later.suggestion(0)?.label).toBe(labels[0]);
    expect(later.suggestion(1)?.label).toBe(labels[1]);
  });
});

describe("Property 5.4: 端末間の一致", () => {
  it("担当範囲が違っても、同じ釜の提案の時期は同じである", () => {
    // 錨（最も早い提案）をユニット 1 の釜（slot 6）に置く。ユニット 0 だけを担当する端末には見えない。
    const view = boardView(
      [order("o-early"), order("o-late")],
      [recommendation("o-early", 6, NOW - 10_000), recommendation("o-late", 2, NOW + 110_000)],
    );

    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const narrow = renderBoard(view, [0]).suggestion(2);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const wide = renderBoard(view, [0, 1]).suggestion(2);

    // 錨を担当範囲から取っていれば narrow は now（自分の中で最も早い）になり食い違う。
    expect(narrow?.label).toBe(wide?.label);
    expect(narrow?.ariaLabel).toBe(wide?.ariaLabel);
    expect(timingOf(narrow?.label)).toBe("+02:00");
  });

  it("担当外の釜の提案は描かれない（絞り込みは錨の取り方と独立である）", () => {
    const view = boardView([order("o-early")], [recommendation("o-early", 6, NOW - 10_000)]);

    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(renderBoard(view, [0]).suggestion(6)).toBeUndefined();
  });
});
