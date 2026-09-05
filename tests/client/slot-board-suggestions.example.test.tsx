// tests/client/slot-board-suggestions.example.test.tsx — 盤面の本物の語と配線（lift-group-display）。
//
// **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.14, 3.1, 3.4, 3.6, 3.7, 6.4, 6.6, 6.9**
//
// `slot-card.example` はカード単体を描き、テスト自身が書いた resolver の文字列を検査する——SlotBoard の
// `suggestionOf` に `in` / `+` / mm:ss を足しても、aria-label の相の語を可視の語と食い違わせても落ちない。
// ここは SlotBoard を丸ごと実描画し、本物の `suggestionOf` が組んだ語（ラベル・aria-label・塗り）と、
// `display.next` → `SlotCard` → `connection.startOrderItem(slotIds, { externalOrderId, itemIndex })` の配線を
// DOM から観測する。design Testing Strategy の 6.4「`suggestionOf` のラベルの末尾は空か `now`」
// （Correctness Property 4）はこのファイルが固定する。濃く押せるのが店舗全体で先頭 `arms` 本に限られること
// （判断 21・AC 2.4 / 6.9）も、丸ボタンの数を盤面で数えて固定する。
//
// happy-dom + Testing Library で描く（`render` プロジェクト）。`useSyncExternalStore` は client 描画で本物が
// 動くため差し替えない。接続は `getView` が固定のビューを返す作り物で、送信の口だけ `vi.fn` にする。
// `SlotBoard.tsx` は `Date.now()` を直接読むため、相（薄 / 濃）を問うには spy が要る。
//
// 塗りだけは DOM から読めない——happy-dom は `oklch(…)` のインラインスタイルを捨てる（属性ごと消える）。
// ゆえに `SlotCard` を実物へ委譲したまま props を控え（`audioWiring.example` と同じ形）、resolver の返す
// `tint` を麺色の resolver と突き合わせる。控えは塗りにだけ使い、語と配線は DOM で問う。薄さは class
// （`opacity-60`）の有無で問う。
//
// 場面はレビューの再現（茹で 510 / 360 / 330 秒の同卓 3 品・`liftGroups.example` と同じ）に、2 釜の推奨と
// 2 ユニットを足したもの。510 秒の品目は釜 0・1 を要り、360 秒は釜 2、330 秒は釜 6（ユニット 1）。arms は
// 既定の 2——180 秒には 3 品とも startAt が過ぎ、濃いのは先頭 2 本で 330 秒の品目は薄いまま（判断 21）。
// 押下が推奨の slotIds 全体（2 釜）で要求されること（AC 3.1）と、担当ユニットの違いが共通の釜の見え方を
// 変えないこと（AC 1.6 / 2.12）を同じ盤面で問う。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SlotBoard } from "../../src/client/components/SlotBoard";
import type { SlotCard } from "../../src/client/components/SlotCard";
import { FIRMNESS_LABEL } from "../../src/client/components/firmness";
import { noodleColors } from "../../src/client/components/noodleColor";
import { EMPTY_VIEW, type ClientView, type TimerConnection } from "../../src/client/connection";
import type { CookRecommendation } from "../../src/domain/messages";
import type { PendingOrder } from "../../src/domain/order";
import { defaultUnitOrigins, type NoodlePreset } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import { nonEmpty } from "../nonEmpty";

type SlotCardProps = Parameters<typeof SlotCard>[0];

/** 実描画で SlotCard へ渡った props の控え（塗りの検査にだけ使う）。差し替えの工場が参照するため hoisted。 */
const capture = vi.hoisted(() => ({ slotCards: [] as SlotCardProps[] }));

vi.mock("../../src/client/components/SlotCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/components/SlotCard")>();
  const { createElement } = await import("react");
  return {
    SlotCard: (props: SlotCardProps) => {
      capture.slotCards.push(props);
      return createElement(actual.SlotCard, props);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  capture.slotCards.length = 0;
});

const T0 = 1_700_000_000_000;
const SECOND = 1000;

/** 茹で 510 / 360 / 330 秒の 3 麺種（レビューの再現・観測事実 14）。 */
const PRESETS: NonEmptyArray<NoodlePreset> = [
  { noodleType: "Long", boilSeconds: { extraHard: 510, hard: 510, normal: 510, soft: 510 } },
  { noodleType: "Mid", boilSeconds: { extraHard: 360, hard: 360, normal: 360, soft: 360 } },
  { noodleType: "Short", boilSeconds: { extraHard: 330, hard: 330, normal: 330, soft: 330 } },
];
/** 麺色の resolver は盤面と同じ工場で組む（塗りの期待値を盤面の実装から独立に引くため）。 */
const colorOf = noodleColors(PRESETS.map((preset) => preset.noodleType));

function order(overrides: Partial<PendingOrder> & { externalOrderId: string }): PendingOrder {
  return {
    itemIndex: 0,
    noodleType: "Long",
    firmness: "normal",
    tableId: "t-1",
    arrivalTime: T0 - 60 * SECOND,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    ...overrides,
  };
}

/** 推奨。群の所属と錨は engine が付ける値をそのまま書く（既定は一つの群 `g1`・合流していない）。 */
function recommendation(
  order: PendingOrder,
  slotIds: readonly string[],
  startAt: number,
  {
    group = "g1",
    anchor = null,
  }: { readonly group?: string; readonly anchor?: number | null } = {},
): CookRecommendation {
  return {
    externalOrderId: order.externalOrderId,
    itemIndex: order.itemIndex,
    slotIds: nonEmpty(slotIds),
    startAt,
    group,
    anchor,
  };
}

/**
 * 先頭の品目。鍵が (externalOrderId, itemIndex) で運ばれることを見るため itemIndex は 0 でない値にする。麺量を持つ
 * のは、可視のラベルと aria-label が同じ `displayName`（名 麺量）で品目を呼ぶことを末尾まで固定するため——麺量の
 * 違う同名の品目は別の品目であり、支援技術にも同じ語で告げる。
 */
const LONG = order({
  externalOrderId: "long",
  itemIndex: 2,
  slotSpan: 2,
  itemName: "Salt",
  sizeName: "L",
});
const MID = order({ externalOrderId: "mid", noodleType: "Mid" });
const SHORT = order({ externalOrderId: "short", noodleType: "Short" });

/** 同卓 3 品（開始予定 0 / 150 / 180 秒・serveAt は 510 秒で揃う）。先頭は釜 0・1 の 2 釜を要る。arms は既定の 2。 */
const VIEW: ClientView = {
  ...EMPTY_VIEW,
  connectivity: "up",
  sync: "synced",
  unitCount: 2,
  unitOrigins: defaultUnitOrigins(2),
  noodlePresets: PRESETS,
  pendingOrders: [LONG, MID, SHORT],
  recommendations: [
    recommendation(LONG, ["0", "1"], T0),
    recommendation(MID, ["2"], T0 + 150 * SECOND),
    recommendation(SHORT, ["6"], T0 + 180 * SECOND),
  ],
};

/** 上限の場面：同卓 3 品（各 1 釜・釜 0・2・4）がすべて 0 秒に置かれた盤面（実機の差し戻しの縮図・判断 21）。 */
const A = order({ externalOrderId: "a", itemName: "A" });
const B = order({ externalOrderId: "b", itemName: "B" });
const C = order({ externalOrderId: "c", itemName: "C" });
const CROWDED: ClientView = {
  ...VIEW,
  pendingOrders: [A, B, C],
  recommendations: [
    recommendation(A, ["0"], T0),
    recommendation(B, ["2"], T0),
    recommendation(C, ["4"], T0),
  ],
};

const FIRMNESS = FIRMNESS_LABEL.normal;

/** 盤面を実描画する。送信の口はすべて作り物で、押下がどこへ何を運んだかを問える。 */
function renderBoard(units: readonly number[], now: number, view: ClientView = VIEW) {
  vi.spyOn(Date, "now").mockReturnValue(now);
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
  const playTouchCue = vi.fn();
  render(<SlotBoard connection={connection} units={units} playTouchCue={playTouchCue} />);
  return { connection, playTouchCue };
}

/** 釜カード（`article` の名は `Slot n`）。 */
function card(slot: number): HTMLElement {
  return screen.getByRole("article", { name: `Slot ${slot}` });
}

/** 釜カードの提案（提案 1 件＝group 1 つ）。 */
function suggestionsOn(slot: number): readonly HTMLElement[] {
  return within(card(slot)).queryAllByRole("group");
}

/** 提案の見え方を DOM から引く：aria-label・可視のラベル・押す口の有無・役・薄さ。 */
function shownOn(slot: number) {
  return suggestionsOn(slot).map((group) => ({
    ariaLabel: group.getAttribute("aria-label"),
    label: group.textContent ?? "",
    pressable: within(group).queryAllByRole("button").length,
    role: group.dataset["role"],
    faint: group.classList.contains("opacity-60"),
  }));
}

/** 盤面全体の提案の丸ボタン（名が `Suggested —` で始まるボタン）。Start は含まない。 */
function suggestionButtons(): readonly HTMLElement[] {
  return screen.queryAllByRole("button", { name: /^Suggested — / });
}

describe("本物の suggestionOf の語（R2.2・R2.3・R2.5・R3.4・R3.7・R6.4）", () => {
  it("180 秒：先頭 arms 2 本（Salt L・Mid）は now（可視・aria-label とも）で濃く、Short は startAt が過ぎていても語なしで queued・薄い。塗りは麺種の色", () => {
    renderBoard([0, 1], T0 + 180 * SECOND);

    // 先頭（釜 0・1）。可視の語は末尾の now だけで、aria-label の相も now（食い違わない）。
    const head = {
      ariaLabel: "Suggested — Salt L · Slot 0 · now",
      label: `Salt L · ${FIRMNESS} · Table t-1 · now`,
      pressable: 1,
      role: "head",
      faint: false,
    };
    expect(shownOn(0)).toEqual([head]);
    // 1 件の推奨は含まれる各釜に同じ提案として現れる（AC 2.14）。釜の番号だけが違う。
    expect(shownOn(1)).toEqual([{ ...head, ariaLabel: "Suggested — Salt L · Slot 1 · now" }]);
    // 2 本目の先頭（釜 2）。商品名が無ければ麺種の名で代える。
    expect(shownOn(2)).toEqual([
      {
        ariaLabel: "Suggested — Mid · Slot 2 · now",
        label: `Mid · ${FIRMNESS} · Table t-1 · now`,
        pressable: 1,
        role: "head",
        faint: false,
      },
    ]);
    // 後続（釜 6）。startAt（180 秒）が来ていても arms 2 の枠が埋まっており、語は無く aria-label は queued（AC 2.3）。
    expect(shownOn(6)).toEqual([
      {
        ariaLabel: "Suggested — Short · Slot 6 · queued",
        label: `Short · ${FIRMNESS} · Table t-1`,
        pressable: 0,
        role: "member",
        faint: true,
      },
    ]);
    // 塗りは麺種の色（identity の既存規約）で、同じ群を色で示さない（AC 3.2）——同じ群でも Long と Mid で
    // 色が違う。DOM は oklch を捨てるため、控えた props の resolver で問う。
    const tintOn = (slot: number) => {
      const props = capture.slotCards.findLast((p) => p.display.slot === slot);
      if (props?.display.kind !== "idle") throw new Error(`釜 ${slot} は idle のはず`);
      return props.display.next.map((suggestion) => props.suggestionOf(suggestion).tint);
    };
    expect(tintOn(0)).toEqual([colorOf("Long")]);
    expect(tintOn(2)).toEqual([colorOf("Mid")]);
    expect(colorOf("Long")).not.toBe(colorOf("Mid"));
  });

  it("startAt の 30 秒前：最早の品目も薄く、語は無く、aria-label は queued で、押す口が無い。仲間はまだ現れない", () => {
    renderBoard([0, 1], T0 - 30 * SECOND);

    // 薄いものは準備の合図であり押せない（判断 5 は撤回・判断 21）。
    expect(shownOn(0)).toEqual([
      {
        ariaLabel: "Suggested — Salt L · Slot 0 · queued",
        label: `Salt L · ${FIRMNESS} · Table t-1`,
        pressable: 0,
        role: "member",
        faint: true,
      },
    ]);
    for (const slot of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) expect(suggestionsOn(slot)).toEqual([]);
  });

  it("どの相でもラベルの末尾は卓か now だけで、時刻の語（in / + / mm:ss）を持たない（Property 4）", () => {
    for (const now of [T0 - 30 * SECOND, T0, T0 + 150 * SECOND, T0 + 600 * SECOND]) {
      renderBoard([0, 1], now);
      const groups = screen.getAllByRole("group");
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        const label = group.textContent ?? "";
        const tail = label.split(" · ").at(-1);
        expect(tail === "now" || tail === "Table t-1").toBe(true);
        // 部分一致で問うと麺種名に紛れる（`Thin` は `in` を含む）ため、語の境界で問う。
        expect(label).not.toMatch(/\bin\b/);
        expect(label).not.toMatch(/\+\d/);
        expect(label).not.toMatch(/\d{1,2}:\d{2}/);
        // 可視の now と aria-label の now は同じ一語から組まれる（AC 3.4「食い違わない」）。
        const phrase = group.getAttribute("aria-label")?.split(" · ").at(-1);
        expect(phrase === "now").toBe(tail === "now");
        expect(["now", "queued"]).toContain(phrase);
        // 語と押す口と薄さは一つの判別から出る——now なら丸ボタンがあり濃く、queued なら無く薄い。
        expect(within(group).queryAllByRole("button")).toHaveLength(phrase === "now" ? 1 : 0);
        expect(group.classList.contains("opacity-60")).toBe(phrase === "queued");
      }
      cleanup();
    }
  });
});

describe("濃く押せるのは店舗全体で先頭 arms 本（R2.4・R6.9）", () => {
  it("同じ startAt の 3 品が 3 釜に在り arms 2 なら、丸ボタンは店舗全体で 2 つ。3 件とも表示はされる（R2.11）", () => {
    renderBoard([0], T0, CROWDED);

    expect(screen.getAllByRole("group")).toHaveLength(3);
    expect(suggestionButtons()).toHaveLength(2);
    // 先頭は並び（同じ startAt・到着順・同時刻は注文 id の正準順序）の先頭 2 本 A・B。C は後続。
    expect(shownOn(0)[0]).toMatchObject({
      ariaLabel: "Suggested — A · Slot 0 · now",
      pressable: 1,
      role: "head",
      faint: false,
    });
    expect(shownOn(2)[0]).toMatchObject({
      ariaLabel: "Suggested — B · Slot 2 · now",
      pressable: 1,
      role: "head",
      faint: false,
    });
    expect(shownOn(4)[0]).toMatchObject({
      ariaLabel: "Suggested — C · Slot 4 · queued",
      pressable: 0,
      role: "member",
      faint: true,
    });
  });

  it("arms 1 なら丸ボタンは 1 つ、arms 3 なら 3 つ。表示の数は変わらない", () => {
    renderBoard([0], T0, { ...CROWDED, arms: 1 });
    expect(screen.getAllByRole("group")).toHaveLength(3);
    expect(suggestionButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Suggested — A · Slot 0 · now",
    ]);
    cleanup();

    renderBoard([0], T0, { ...CROWDED, arms: 3 });
    expect(screen.getAllByRole("group")).toHaveLength(3);
    expect(suggestionButtons()).toHaveLength(3);
  });

  it("放置して時間が経っても丸ボタンは arms 本のまま（後続は startAt が過ぎても濃くならない）", () => {
    renderBoard([0], T0 + 600 * SECOND, CROWDED);
    expect(suggestionButtons()).toHaveLength(2);
    expect(shownOn(4)[0]).toMatchObject({ pressable: 0, role: "member", faint: true });
  });
});

describe("提案の押下は品目の鍵と推奨の slotIds 全体で startOrderItem を要求する（R3.1・R3.6）", () => {
  it("釜 0 の先頭を押すと、釜 0・1 と (long, 2) で 1 回要求し、Touch_Cue が鳴り、アドホック開始は呼ばれない", () => {
    const { connection, playTouchCue } = renderBoard([0], T0 + 150 * SECOND);

    fireEvent.click(
      within(card(0)).getByRole("button", { name: "Suggested — Salt L · Slot 0 · now" }),
    );

    expect(connection.startOrderItem).toHaveBeenCalledTimes(1);
    expect(connection.startOrderItem).toHaveBeenCalledWith(["0", "1"], {
      externalOrderId: "long",
      itemIndex: 2,
    });
    expect(playTouchCue).toHaveBeenCalledTimes(1);
    expect(connection.start).not.toHaveBeenCalled();
  });

  it("startAt 前の最早の品目は薄く、押す口が無い——ラベルを押しても何も送られない（判断 5 撤回）", () => {
    const { connection, playTouchCue } = renderBoard([0], T0 - 30 * SECOND);

    expect(within(card(1)).queryByRole("button", { name: /^Suggested — / })).toBeNull();
    fireEvent.click(within(card(1)).getByText(`Salt L · ${FIRMNESS} · Table t-1`));

    expect(connection.startOrderItem).not.toHaveBeenCalled();
    expect(playTouchCue).not.toHaveBeenCalled();
  });

  it("後続のラベルを押しても何も送られない（押す口が構造から無い・startAt が過ぎていても）", () => {
    const { connection, playTouchCue } = renderBoard([0, 1], T0 + 180 * SECOND);

    fireEvent.click(within(card(6)).getByText(`Short · ${FIRMNESS} · Table t-1`));

    expect(connection.startOrderItem).not.toHaveBeenCalled();
    expect(playTouchCue).not.toHaveBeenCalled();
  });
});

describe("担当ユニットの違いは共通の釜の見え方を変えない（R1.6・R2.12・R6.6）", () => {
  it("units [0] と [0, 1] で釜 0〜5 の提案（ラベル・aria-label・押す口）が一致し、釜 6 は [0, 1] にだけ在る", () => {
    renderBoard([0], T0 + 150 * SECOND);
    const alone = [0, 1, 2, 3, 4, 5].map(shownOn);
    expect(screen.queryByRole("article", { name: "Slot 6" })).toBeNull();
    cleanup();

    renderBoard([0, 1], T0 + 150 * SECOND);
    expect([0, 1, 2, 3, 4, 5].map(shownOn)).toEqual(alone);
    expect(shownOn(6)).toHaveLength(1);
  });

  it("表示できる群の品目が担当範囲の釜に無ければ、提案は一切出ない（担当外の空白）", () => {
    // 30 秒前に見えるのは最早の品目（釜 0・1）だけ。ユニット 1 だけの端末には何も出ない——群の判定は店舗全体で
    // 行われ、担当範囲で絞るのは表示だけである。
    renderBoard([1], T0 - 30 * SECOND);
    expect(screen.queryAllByRole("group")).toEqual([]);
    cleanup();
    // 対照：150 秒には釜 6 の後続がユニット 1 に在り、それだけが見える（先頭の釜 0・1・2 は担当外）。
    // 先頭の数は店舗全体で数える——担当外の先頭 2 本が枠を埋め、担当内の後続は薄いまま（AC 1.6 / 2.4）。
    renderBoard([1], T0 + 150 * SECOND);
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(shownOn(6)[0]).toMatchObject({ pressable: 0, role: "member", faint: true });
  });
});
