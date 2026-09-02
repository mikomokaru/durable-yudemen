// tests/client/order-rail.example.test.tsx — 待ちオーダーレールの実描画テスト
// （pending-order-list-left-rail タスク 4.1）。
//
// このプロジェクト最初の `.test.tsx` である。境界は拡張子にあり、`render` プロジェクト
// （happy-dom + @testing-library/react）が `tests/**/*.test.tsx` として拾う——vitest.config.ts への
// 追記は要らない。
//
// 描くのは OrderRail 単体である。SlotBoard を丸ごと描けば WS 接続の作り物が要るが、ここで立てる主張は
// レールの DOM にしかない。入力の QueueEntry はテスト内で直接組む——並び・待ち時間・提案の絞り込みという
// 導出の検証は既存の純粋層テスト（order-queue.example.test.ts）が持っており、ここでは組んだ入力が
// そのまま DOM へ写ることだけを問う。
//
// 問い方は支援技術が見るもの（getByRole / accessible name）に寄せる。クラス名は問わない——クラスの主張は
// 静的検査が持ち、同じ主張を両方に置かない。
//
// レイアウトの寸法はここでは測れない。happy-dom はレイアウトを計算せず実寸を 0 として返すため、
// 幅・可触領域の寸法は算術と静的検査、そして実機確認が受ける。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { OrderRail } from "../../src/client/components/OrderRail";
import type { QueueEntry, QueueSuggestion } from "../../src/client/components/queueDisplay";
import { noodleColors } from "../../src/client/components/noodleColor";
import { FIRMNESS_LABEL } from "../../src/client/components/firmness";
import { FIRMNESS_ORDER } from "../../src/domain/firmness";
import type { PendingOrder } from "../../src/domain/order";
import { isNonEmpty, type NonEmptyArray } from "../../src/domain/timer";

// globals を有効にしていないため、自動 cleanup は働かない。描画を明示的に畳む
// （screen は document.body を見るため、残せば次のテストが前のテストの DOM を拾う）。
afterEach(cleanup);

const T = 1_700_000_000_000;

/** 弁別可能な麺種の並び（互いに部分文字列にならない語を選ぶ——行のテキストから麺種を読み取るため）。 */
const NOODLE_MENU = ["Thin", "Thick", "Flat"] as const;

/** 色 resolver は本物を使う。麺種色の出所はスロットカードと共有する唯一の resolver である。 */
const noodleColor = noodleColors([...NOODLE_MENU]);

/** 1 品目の未着手オーダー。必要な事実だけを上書きする。 */
function pendingOrder(overrides: Partial<PendingOrder> = {}): PendingOrder {
  return {
    externalOrderId: "o-1",
    itemIndex: 0,
    noodleType: "Thin",
    firmness: "normal",
    tableId: "12",
    arrivalTime: T,
    slotSpan: 1,
    ...overrides,
  };
}

/** 待ち行列 1 行の表示状態。提案なし・待ち時間 0 を既定に据える。 */
function queueEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return { order: pendingOrder(), waitingMs: 0, suggestion: null, ...overrides };
}

/** 到着順に並んだ n 件（externalOrderId を振り分けて行の key を一意に保つ）。 */
function entriesOf(...noodleTypes: readonly string[]): readonly QueueEntry[] {
  return noodleTypes.map((noodleType, index) =>
    queueEntry({ order: pendingOrder({ externalOrderId: `o-${index}`, noodleType }) }),
  );
}

/** props は非空を型で要求する。テストが組んだ配列を境界で非空へ確立する（0 件のレールは構築不能）。 */
function nonEmpty(entries: readonly QueueEntry[]): NonEmptyArray<QueueEntry> {
  if (!isNonEmpty(entries)) throw new Error("OrderRail は非空の entries を要求する");
  return entries;
}

/** 描画する要素。rerender へ同じ形で渡せるよう、要素の組み立てを 1 箇所に置く。 */
function railElement(entries: readonly QueueEntry[], onStart = vi.fn()) {
  return <OrderRail entries={nonEmpty(entries)} noodleColor={noodleColor} onStart={onStart} />;
}

/** 見出しが示す件数（`Waiting orders (n)` の n）。 */
function headingCount(): number {
  const heading = screen.getByText(/^Waiting orders \(\d+\)$/);
  const shown = /\((\d+)\)/.exec(heading.textContent ?? "")?.[1];
  if (shown === undefined) throw new Error("見出しに件数が現れない");
  return Number(shown);
}

/** 行のテキストに現れる麺種（1 行に 1 つだけ現れることも同時に主張する）。 */
function noodleTypesIn(row: HTMLElement): readonly string[] {
  return NOODLE_MENU.filter((noodleType) => row.textContent?.includes(noodleType) === true);
}

describe("レールの構造・DOM 順・件数（R1〜R3）", () => {
  it("領域は Waiting orders のラベルを持ち、内側に list が 1 つと件数分の listitem がある", () => {
    // **Validates: Requirements 7.3**
    render(railElement(entriesOf("Thin", "Thick")));

    const region = screen.getByRole("region", { name: "Waiting orders" });
    expect(within(region).getAllByRole("list")).toHaveLength(1);
    expect(within(region).getAllByRole("listitem")).toHaveLength(2);
  });

  it("listitem の並びが到着順に組んだ entries の並びと一致する（可視順＝支援技術が読む順）", () => {
    // **Validates: Requirements 7.7**
    const entries = entriesOf("Thin", "Thick", "Flat");
    render(railElement(entries));

    const rows = screen.getAllByRole("listitem");
    expect(rows.map(noodleTypesIn)).toEqual(entries.map((entry) => [entry.order.noodleType]));
  });

  it("見出しの件数が listitem の件数と一致し、件数の異なる entries で再描画すると両方が追随する", () => {
    // **Validates: Requirements 3.7, 3.8**
    const { rerender } = render(railElement(entriesOf("Thin", "Thick")));
    expect(headingCount()).toBe(2);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    rerender(railElement(entriesOf("Thin", "Thick", "Flat")));
    expect(headingCount()).toBe(3);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});

/**
 * 提案の開始時刻。ローカル壁時計で 09:05 になる絶対時刻を据える——期待値をテスト側に文字列で明示でき、
 * 実装の写し（getHours / padStart）をテストで再実装せずに済む。
 */
const SUGGESTED_AT = new Date(2023, 10, 14, 9, 5).getTime();
const SUGGESTED_WALL_CLOCK = "09:05";

/**
 * 担当範囲内の提案。釜を複数据えるのが既定である——推奨が含む釜を 1 つも落とさないことが主張の要であり、
 * 単数では「全て」が問えない。番号は時刻の桁（0・9・0・5）と重ならない語を選ぶ。
 */
function queueSuggestion(overrides: Partial<QueueSuggestion> = {}): QueueSuggestion {
  return { slotIds: ["2", "4", "6"], startAt: SUGGESTED_AT, boilSeconds: 95, ...overrides };
}

/**
 * 提案の開始操作の accessible name（支援技術が読む名）。testing-library の name マッチャへ関数を渡し、
 * 計算済みの名をそのまま受け取る——名の計算をテスト側で再実装しない。
 */
function suggestedStartName(): string {
  const computed: string[] = [];
  const buttons = screen.getAllByRole("button", {
    name: (accessibleName) => {
      computed.push(accessibleName);
      return true;
    },
  });
  const [name] = computed;
  if (buttons.length !== 1 || name === undefined) {
    throw new Error(`提案のボタンは 1 つだけのはず（実際: ${buttons.length}）`);
  }
  return name;
}

/** 空白を落とした文字列。空白の入り方は名の計算に委ね、語の並びだけを比べるため。 */
function withoutSpaces(text: string): string {
  return text.replaceAll(/\s+/g, "");
}

describe("提案の accessible name と押下時の引数（R4・R8）", () => {
  it("accessible name が可視テキストそのもので、Suggested・釜の全て・HH:MM を含む", () => {
    // **Validates: Requirements 5.4, 7.4**
    const suggestion = queueSuggestion();
    render(railElement([queueEntry({ suggestion })]));

    const button = screen.getByRole("button");
    const name = suggestedStartName();

    // 名が可視テキストと同一の語であることを、同一のものであることで示す（aria-label を持たない担保）。
    // 別に手書きされた名があれば、この等号がまず破れる。
    expect(withoutSpaces(name)).toBe(withoutSpaces(button.textContent ?? ""));

    expect(name).toContain("Suggested");
    expect(name).toContain(`Slots ${suggestion.slotIds.join(", ")}`);
    for (const slotId of suggestion.slotIds) expect(name).toContain(slotId);
    expect(name).toContain(SUGGESTED_WALL_CLOCK);
  });

  it("accessible name に命令形の語と自動開始を示唆する語が現れない", () => {
    // **Validates: Requirements 5.4, 7.4**
    render(railElement([queueEntry({ suggestion: queueSuggestion() })]));

    const name = suggestedStartName();

    // 機械は開始を指示しない。名に命令形（Start / Go）も自動開始の示唆（Automatic）も置かない。
    expect(name).not.toMatch(/\b(?:start|go)\b/i);
    expect(name).not.toMatch(/automatic/i);
  });

  it("押下で onStart が 1 回呼ばれ、押した行の order と釜の全て・茹で秒を保った suggestion が渡る", () => {
    // **Validates: Requirements 5.3**
    const order = pendingOrder({ externalOrderId: "o-42", itemIndex: 2, noodleType: "Flat" });
    const suggestion = queueSuggestion();
    const onStart = vi.fn();
    // 提案なしの行を先に混ぜる。押した行の事実が渡ることを、他の行が並んでいる状態で問う。
    render(railElement([queueEntry(), queueEntry({ order, suggestion })], onStart));

    fireEvent.click(screen.getByRole("button"));

    // 深い等価で問う。麺種・externalOrderId / itemIndex・slotIds の全て・boilSeconds のいずれかが
    // 落ちるか書き換わるかすれば、この 1 つの主張が破れる。
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(order, suggestion);
  });
});
/**
 * 提案を持つ行と持たない行を混ぜた到着順の並び。麺種を行の見分けに使うため NOODLE_MENU を巡回させ、
 * externalOrderId は行の key を一意に保つために振り分ける（entriesOf と同じ規律）。
 * `true` が提案あり——提案の有無が並びにも表示可否にも効かないことを、混在の 1 本で問うため。
 */
function mixedEntries(...hasSuggestion: readonly boolean[]): readonly QueueEntry[] {
  return hasSuggestion.map((withSuggestion, index) =>
    queueEntry({
      order: pendingOrder({
        externalOrderId: `o-${index}`,
        noodleType: NOODLE_MENU[index % NOODLE_MENU.length] ?? "Thin",
      }),
      suggestion: withSuggestion ? queueSuggestion() : null,
    }),
  );
}

describe("提案なし・卓番なし・全件描画・茹で加減の語（R5〜R7・R9）", () => {
  it("提案なしの行にボタンが無く、ボタンの総数が提案を持つ行数と一致する", () => {
    // **Validates: Requirements 5.9, 6.9**
    const hasSuggestion = [false, true, false, true, false] as const;
    render(railElement(mixedEntries(...hasSuggestion)));

    // 提案の有無が行ごとにそのまま出る。理由別の表示は持たないため、問えるのは有無だけである。
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => within(row).queryAllByRole("button").length)).toEqual(
      hasSuggestion.map((withSuggestion) => (withSuggestion ? 1 : 0)),
    );
    expect(screen.queryAllByRole("button")).toHaveLength(
      hasSuggestion.filter((withSuggestion) => withSuggestion).length,
    );
  });

  it("提案なしの行も到着順の位置に残る（提案の有無を並びの判断に用いない）", () => {
    // **Validates: Requirements 4.3, 5.9**
    const entries = mixedEntries(false, true, false);
    render(railElement(entries));

    const rows = screen.getAllByRole("listitem");
    expect(rows.map(noodleTypesIn)).toEqual(entries.map((entry) => [entry.order.noodleType]));
  });

  it("卓番を持たない行に Table の語が現れず、麺種・茹で加減・待ち時間は現れる", () => {
    // **Validates: Requirements 3.3**
    const order = pendingOrder({ tableId: null, noodleType: "Flat", firmness: "hard" });
    // 01:23 に相当する待ち時間。表記は移動前の Order_Band と同一（MM:SS）である。
    render(railElement([queueEntry({ order, waitingMs: 83_000 })]));

    const [row] = screen.getAllByRole("listitem");
    const text = row?.textContent ?? "";
    expect(text).not.toContain("Table");
    expect(text).toContain("Flat");
    expect(text).toContain(FIRMNESS_LABEL.hard);
    expect(text).toContain("01:23");
  });

  it("卓番を持つ行には Table の語と卓番が現れる（省略が卓番の不在だけに由来する）", () => {
    // **Validates: Requirements 3.3**
    render(railElement([queueEntry({ order: pendingOrder({ tableId: "12" }) })]));

    const [row] = screen.getAllByRole("listitem");
    expect(row?.textContent ?? "").toContain("Table 12");
  });

  it("listitem の件数が entries の件数と等しい（提案の有無を表示可否の判断に用いない）", () => {
    // **Validates: Requirements 4.3**
    const entries = mixedEntries(true, false, false, true, false, true, false);
    render(railElement(entries));

    expect(screen.getAllByRole("listitem")).toHaveLength(entries.length);
  });

  it("各茹で加減について FIRMNESS_LABEL の語がそのまま行に現れる", () => {
    // **Validates: Requirements 3.10**
    const entries = FIRMNESS_ORDER.map((firmness, index) =>
      queueEntry({ order: pendingOrder({ externalOrderId: `o-${index}`, firmness }) }),
    );
    render(railElement(entries));

    // レール専用の別ラベルを持たない。既存の調理母語がそのまま出ることを、語の一致で問う。
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent ?? "")).toEqual(
      FIRMNESS_ORDER.map((firmness) => expect.stringContaining(FIRMNESS_LABEL[firmness])),
    );
  });
});
