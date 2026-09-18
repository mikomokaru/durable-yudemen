// tests/client/radial-queue.example.test.tsx — ラジアルの待ち行列の帯（lift-group-display Requirement 4）。
//
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9, 6.11**
//
// SlotBoard を丸ごと実描画し、idle の釜の Start からラジアルを開き、body 直下に描かれた帯を DOM から観測する
// （`slot-board-suggestions.example` と同じ据え付け）。帯の行の語・並び・不活性・押下の配線はすべて SlotBoard
// が `pairSlots` で組んで渡したものであり、RadialMenu 単体を描いても「起点の釜が埋まれば全行が不活性になる」
// は問えない——帯は view から毎描画導かれるため、接続の作り物は snapshot の到着（購読者への通知）を再現する。
//
// 場面は 1 台（釜 0〜5）・待ち行列 3 品（到着順は B → A → C）。B は 2 釜を要り、A と C は 1 釜。釜の組は
// `liftGroups.example` の `pairSlots` と同じ既定の台（横 10・縦 10・斜め 14・許容 14）で、釜 0 から組むと
// 釜 1 が最も近い。釜 1〜3 が埋まった台では釜 0 の隣接が無く、B だけが組めない。
//
// 帯の配置は happy-dom では観測できない（矩形はすべて 0・レイアウトが無い）ため、Start の矩形を差し替えて
// 画面の隅から開き、帯のインライン style を矩形へ読み戻して問う。既定の 1024×768 で side の余白（8rem）が
// 足りないのは画面端から約 306px の帯域で、右列・下段の釜の Start はそこに落ちる。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SlotBoard } from "../../src/client/components/SlotBoard";
import { FIRMNESS_LABEL } from "../../src/client/components/firmness";
import {
  EMPTY_VIEW,
  type ClientTimer,
  type ClientView,
  type TimerConnection,
} from "../../src/client/connection";
import { ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
import { defaultUnitOrigins, type NoodlePreset } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import { nonEmpty } from "../nonEmpty";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const T0 = 1_700_000_000_000;
const SECOND = 1000;

const PRESETS: NonEmptyArray<NoodlePreset> = [
  { noodleType: "Long", boilSeconds: { extraHard: 510, hard: 510, normal: 510, soft: 510 } },
  { noodleType: "Mid", boilSeconds: { extraHard: 360, hard: 360, normal: 360, soft: 360 } },
  { noodleType: "Short", boilSeconds: { extraHard: 330, hard: 330, normal: 330, soft: 330 } },
];

function order(overrides: Partial<OrderItem> & { externalOrderId: string }): OrderItem {
  return {
    itemIndex: 0,
    noodleType: "Long",
    firmness: "normal",
    tableId: "t-1",
    arrivalTime: T0 - 60 * SECOND,
    portions: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
    ...overrides,
  };
}

function timer(overrides: Partial<ClientTimer> & { id: string }): ClientTimer {
  return {
    slotIds: nonEmpty(["0"]),
    noodleType: "Long",
    firmness: "normal",
    startTime: T0 - 30 * SECOND,
    endTime: T0 + 480 * SECOND,
    orderItem: null,
    origin: "server",
    ...overrides,
  };
}

/** 2 釜を要る品目。最初に到着。鍵が (externalOrderId, itemIndex) で運ばれることを見るため itemIndex は 0 でない。 */
const B = order({
  externalOrderId: "b",
  itemIndex: 1,
  portions: 2,
  itemName: "Salt",
  sizeName: "L",
  completedAt: null,
  interruptedAt: null,
  tableAssignedAt: null,
  arrivalTime: T0 - 90 * SECOND,
});
/** 1 釜の品目。2 番目に到着。商品名が無いので麺種の名で呼ばれる。 */
const A = order({ externalOrderId: "a", noodleType: "Mid" });
/** 卓なしの 1 釜の品目。最後に到着。半角カナの商品名は表示で全角へ寄る（レールと同じ語）。 */
const C = order({
  externalOrderId: "c",
  noodleType: "Short",
  tableId: null,
  itemName: "ﾈｷﾞ丼",
  arrivalTime: T0 - 30 * SECOND,
});

/** 全釜 idle の live な台。待ち行列は到着順に B → A → C（配列は到着の逆順に置き、並びが導出であることを見る）。 */
const OPEN: ClientView = {
  ...EMPTY_VIEW,
  connectivity: "up",
  sync: "synced",
  unitCount: 1,
  unitOrigins: defaultUnitOrigins(1),
  noodlePresets: PRESETS,
  orderItems: [C, A, B],
};

/** 釜 1〜3 が走行中の台。釜 0 の隣接（横 10・縦 10・斜め 14）がすべて埋まり、残る釜 4・5 は許容 14 の外。 */
const BOXED: ClientView = {
  ...OPEN,
  timers: [timer({ id: "box", slotIds: nonEmpty(["1", "2", "3"]) })],
};

const FIRMNESS = FIRMNESS_LABEL.normal;

/**
 * 盤面を実描画する。接続の作り物は snapshot の到着を再現できる——`replace(view)` が現在のビューを差し替えて
 * 購読者へ通知し、useSyncExternalStore が再描画する（帯が view から毎描画導かれることを問うため）。
 */
function renderBoard(initial: ClientView) {
  vi.spyOn(Date, "now").mockReturnValue(T0);
  let current = initial;
  const listeners = new Set<() => void>();
  const connection: TimerConnection = {
    getView: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: vi.fn<TimerConnection["start"]>(),
    startOrderItem: vi.fn<TimerConnection["startOrderItem"]>(),
    cancel: vi.fn<TimerConnection["cancel"]>(),
    complete: vi.fn<TimerConnection["complete"]>(),
    adjust: vi.fn<TimerConnection["adjust"]>(),
    assignTable: vi.fn<TimerConnection["assignTable"]>(),
    close: () => {},
  };
  const playTouchCue = vi.fn();
  render(<SlotBoard connection={connection} units={[0]} playTouchCue={playTouchCue} />);
  // 左の器は既定で Plan（2026-09-18）。この試験はレールと帯の一致を見るので Queue へ切り替えてから読む。
  fireEvent.click(screen.getByRole("tab", { name: "Queue" }));
  const replace = (view: ClientView) => {
    act(() => {
      current = view;
      for (const listener of listeners) listener();
    });
  };
  return { connection, playTouchCue, replace };
}

/** 釜のカードの Start を押してラジアルを開き、dialog を返す。 */
function openRadial(slot: number): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: `Slot ${slot} — Start` }));
  return screen.getByRole("dialog", { name: "Select noodle" });
}

/** 帯の行（ボタン）。帯が無ければ空。 */
function rows(dialog: HTMLElement): readonly HTMLElement[] {
  const column = within(dialog).queryByRole("list", { name: "Waiting orders" });
  return column === null ? [] : within(column).getAllByRole("button");
}

/** 麺種プリセットの花びら（名は `Long510s` の形）。 */
function petal(dialog: HTMLElement, preset: NoodlePreset): HTMLElement {
  return within(dialog).getByRole("button", {
    name: new RegExp(`^${preset.noodleType}\\s*${preset.boilSeconds.normal}s$`),
  });
}

/** 行の見え方：語と不活性。 */
function shown(row: HTMLElement) {
  return { label: row.textContent ?? "", disabled: row.getAttribute("aria-disabled") };
}

describe("live で帯が出る——店舗全体の待ち行列を到着順に、レールと同じ語で（R4.1・R4.6）", () => {
  it("釜 0 から開くと B → A → C の順に並び、語は 名（麺量）· 茹で加減 · 卓 で時刻を持たない", () => {
    renderBoard(OPEN);
    const dialog = openRadial(0);

    expect(rows(dialog).map(shown)).toEqual([
      { label: `Salt L 2玉 · ${FIRMNESS} · Table t-1`, disabled: "false" },
      { label: `Mid 1玉 · ${FIRMNESS} · Table t-1`, disabled: "false" },
      { label: `ネギ丼 1玉 · ${FIRMNESS}`, disabled: "false" },
    ]);
    for (const row of rows(dialog)) {
      const label = row.textContent ?? "";
      expect(label).not.toMatch(/\d{1,2}:\d{2}/);
      expect(label).not.toMatch(/\bin\b/);
    }
    // 麺種プリセットの花びらは残る（アドホック開始・AC 4.6）。花びらの名は麺種と既定の茹で秒。
    for (const preset of PRESETS) expect(petal(dialog, preset)).toBeDefined();
  });

  it("帯の語はレールの語と同じ（同じ品目を同じ名で呼ぶ）", () => {
    renderBoard(OPEN);
    const rail = screen.getByRole("region", { name: "Waiting orders" });
    const railNames = within(rail)
      .getAllByRole("listitem")
      .map((item) => item.querySelector("span")?.textContent ?? "");
    const dialog = openRadial(0);
    const columnNames = rows(dialog).map((row) => row.querySelector("span")?.textContent ?? "");
    expect(columnNames).toEqual(railNames);
    expect(columnNames).toEqual(["Salt L 2玉", "Mid 1玉", "ネギ丼 1玉"]);
  });
});

describe("選ぶと品目の鍵と組んだ釜で startOrderItem を要求する（R4.2・R4.3・R4.4）", () => {
  it("slotSpan 1 の A は押した釜 0 だけで要求し、Touch_Cue が鳴り、ラジアルが閉じ、アドホック開始は呼ばれない", () => {
    const { connection, playTouchCue, replace } = renderBoard(OPEN);
    const dialog = openRadial(0);
    playTouchCue.mockClear(); // Start 押下（開く操作）の 1 回を除き、選択の 1 回だけを数える

    fireEvent.click(
      within(dialog).getByRole("button", { name: `Mid 1玉 · ${FIRMNESS} · Table t-1` }),
    );

    expect(connection.startOrderItem).toHaveBeenCalledTimes(1);
    expect(connection.startOrderItem).toHaveBeenCalledWith(["0"], {
      externalOrderId: "a",
      itemIndex: 0,
    });
    expect(playTouchCue).toHaveBeenCalledTimes(1);
    expect(connection.start).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // 閉じた後の snapshot は帯を再び開かない（帯は picker が開いているときだけ導かれる）。
    replace(OPEN);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("slotSpan 2 の B は押した釜 0 と最も近い idle の釜 1 で要求する（鍵は (b, 1)）", () => {
    const { connection } = renderBoard(OPEN);
    const dialog = openRadial(0);

    fireEvent.click(
      within(dialog).getByRole("button", { name: `Salt L 2玉 · ${FIRMNESS} · Table t-1` }),
    );

    expect(connection.startOrderItem).toHaveBeenCalledWith(["0", "1"], {
      externalOrderId: "b",
      itemIndex: 1,
    });
  });

  it("釜 4 から開けば、同じ B が釜 4 と同距離の釜 2・5 のうち index の小さい釜 2 で要求される（組は押した釜から導く）", () => {
    const { connection } = renderBoard(OPEN);
    const dialog = openRadial(4);

    fireEvent.click(
      within(dialog).getByRole("button", { name: `Salt L 2玉 · ${FIRMNESS} · Table t-1` }),
    );

    expect(connection.startOrderItem).toHaveBeenCalledWith(["4", "2"], {
      externalOrderId: "b",
      itemIndex: 1,
    });
  });
});

describe("許容距離の内側に足りない行は不活性（R4.5・R4.9）", () => {
  it("釜 1〜3 が走行中の台で釜 0 から開くと、2 釜要る B だけが aria-disabled で、押しても何も起きない", () => {
    const { connection, playTouchCue } = renderBoard(BOXED);
    const dialog = openRadial(0);
    playTouchCue.mockClear();

    expect(rows(dialog).map(shown)).toEqual([
      { label: `Salt L 2玉 · ${FIRMNESS} · Table t-1`, disabled: "true" },
      { label: `Mid 1玉 · ${FIRMNESS} · Table t-1`, disabled: "false" },
      { label: `ネギ丼 1玉 · ${FIRMNESS}`, disabled: "false" },
    ]);

    fireEvent.click(
      within(dialog).getByRole("button", { name: `Salt L 2玉 · ${FIRMNESS} · Table t-1` }),
    );
    expect(connection.startOrderItem).not.toHaveBeenCalled();
    expect(playTouchCue).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBe(dialog); // 閉じもしない
  });
});

describe("degraded では帯が無い（R4.8・R6.11）", () => {
  it("connectivity down で開くと花びらだけが出て、待ち行列の行は 1 つも無い", () => {
    const { connection } = renderBoard({ ...OPEN, connectivity: "down" });
    const dialog = openRadial(0);

    expect(within(dialog).queryByRole("list", { name: "Waiting orders" })).toBeNull();
    expect(rows(dialog)).toEqual([]);
    expect(within(dialog).getAllByRole("button")).toHaveLength(PRESETS.length + 1); // 花びら + 中心の ×
    expect(connection.startOrderItem).not.toHaveBeenCalled();
  });
});

/** 花びらの半径（rem）。`RadialMenu` の定数と同じ値で、帯が弧の外縁に揃うことを問う。 */
const PETAL_RADIUS_REM = 2.875;
/** 既定の展開半径（px）。 */
const RADIUS = 132;

/** Start の矩形を差し替え、押した釜の中心を (x, y) に置く。他の要素の矩形も同じになるが、読むのは Start だけ。 */
function placeStartAt(x: number, y: number): void {
  const rect = { x: x - 1, y: y - 1, left: x - 1, top: y - 1, width: 2, height: 2 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...rect,
    right: x + 1,
    bottom: y + 1,
    toJSON: () => rect,
  });
}

/** 長さの style（`Npx` または `calc(Npx + Rrem)`）を px に読む。rem は happy-dom の既定 16px。 */
function px(value: string): number {
  const plain = /^(-?[\d.]+)px$/.exec(value);
  if (plain) return Number(plain[1]);
  const calc = /^calc\((-?[\d.]+)px \+ ([\d.]+)rem\)$/.exec(value);
  if (calc) return Number(calc[1]) + Number(calc[2]) * 16;
  throw new Error(`読めない長さ: ${value}`);
}

/** 帯のインライン style を、行が上限まで詰まったときの矩形（ビューポート座標）に読み戻す。 */
function bandRect(dialog: HTMLElement) {
  const band = within(dialog).getByRole("list", { name: "Waiting orders" });
  const { style } = band;
  const height = px(style.maxHeight);
  const width = px(style.width);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = style.left !== "" ? px(style.left) : vw - px(style.right) - width;
  const top = style.top !== "" ? px(style.top) : vh - px(style.bottom) - height;
  return { left, top, right: left + width, bottom: top + height, height };
}

describe("帯は画面のどの隅の釜から開いても画面内に収まり、1 行以上の高さを持つ（R4.1）", () => {
  const vw = 1024;
  const vh = 768;
  const petal = PETAL_RADIUS_REM * 16;
  const margin = RADIUS + 60;

  it.each([
    ["右下（下段・右列の釜）", vw - 24, vh - 8],
    ["左上", 24, 8],
    ["右端の中段", vw - 24, vh / 2],
    ["左端の中段", 24, vh / 2],
  ])("%s から開いた帯の矩形は画面内で、弧の外縁と重ならず、高さは 8rem 以上", (_, x, y) => {
    expect([window.innerWidth, window.innerHeight]).toEqual([vw, vh]);
    placeStartAt(x, y);
    renderBoard(OPEN);
    const dialog = openRadial(0);
    const rect = bandRect(dialog);
    // 中心は margin で画面内へクランプされる（`RadialMenu` の幾何・AC 4.6 で不変）。
    const cx = Math.max(margin, Math.min(vw - margin, x));
    const cy = Math.max(margin, Math.min(vh - margin, y));

    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(vw);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(vh);
    expect(rect.height).toBeGreaterThanOrEqual(8 * 16);
    // 弧の外縁（radius + 花びらの半径）の円に、帯の矩形が食い込まない——上下左右のいずれかで外側に在る。
    const outer = RADIUS + petal;
    const clear =
      rect.bottom <= cy - outer ||
      rect.top >= cy + outer ||
      rect.right <= cx - outer ||
      rect.left >= cx + outer;
    expect(clear).toBe(true);
  });

  it("右下の釜では帯は弧の上に置かれ、下端が弧の上端に揃う（下に固定すれば 14px しか残らない）", () => {
    placeStartAt(vw - 24, vh - 8);
    renderBoard(OPEN);
    const rect = bandRect(openRadial(0));
    const cy = vh - margin;

    expect(rect.bottom).toBe(cy - RADIUS - petal);
    expect(rect.top).toBe(0);
    expect(vh - (cy + RADIUS + petal)).toBeLessThan(34); // 下に落とせば 1 行（≈ 34px）も出ない
  });
});

describe("開いたまま snapshot で起点の釜が走行中になると、全行が不活性になる（R4.9・観測事実 12）", () => {
  it("釜 0 で開いた帯は、釜 0 を占める Timer の snapshot で slotSpan 1 の行も含めて不活性になり、選んでも要求しない", () => {
    const { connection, replace } = renderBoard(OPEN);
    const dialog = openRadial(0);
    expect(rows(dialog).map((row) => shown(row).disabled)).toEqual(["false", "false", "false"]);

    // 別端末が釜 0 を始めた snapshot が届く。ラジアルは開いたまま（picker はローカル状態）。
    replace({ ...OPEN, timers: [timer({ id: "other", slotIds: nonEmpty(["0"]) })] });

    expect(screen.getByRole("dialog", { name: "Select noodle" })).toBe(dialog);
    expect(rows(dialog).map(shown)).toEqual([
      { label: `Salt L 2玉 · ${FIRMNESS} · Table t-1`, disabled: "true" },
      { label: `Mid 1玉 · ${FIRMNESS} · Table t-1`, disabled: "true" },
      { label: `ネギ丼 1玉 · ${FIRMNESS}`, disabled: "true" },
    ]);
    for (const row of rows(dialog)) fireEvent.click(row);
    expect(connection.startOrderItem).not.toHaveBeenCalled();
    // 花びらは残る——アドホック開始は既存経路のまま（tasks 10 の申し送り）。
    expect(petal(dialog, PRESETS[0])).toBeDefined();
  });

  it("逆に、隣の釜が空く snapshot で組めなかった行が組めるようになる（帯は状態でなく導出）", () => {
    const { connection, replace } = renderBoard(BOXED);
    const dialog = openRadial(0);
    expect(shown(rows(dialog)[0]!).disabled).toBe("true");

    replace(OPEN);

    expect(shown(rows(dialog)[0]!).disabled).toBe("false");
    fireEvent.click(
      within(dialog).getByRole("button", { name: `Salt L 2玉 · ${FIRMNESS} · Table t-1` }),
    );
    expect(connection.startOrderItem).toHaveBeenCalledWith(["0", "1"], {
      externalOrderId: "b",
      itemIndex: 1,
    });
  });
});

// ── pending-order-expiry: 帯もレールも、時計が寿命を跨げば次の snapshot を待たずに品目を落とす（AC 3.1・性質 5.8） ──

describe("時計が寿命を跨ぐと、開いたままの帯とレールから同じ品目が同じ瞬間に消える（pending-order-expiry AC 3.1）", () => {
  /** 端末のローカル時計はサーバより 1 秒遅れている（offset +1 秒）。補正後現在時刻 = Date.now() + 1 秒。 */
  const OFFSET = 1_000;
  /** 補正後現在時刻が T0 + 1 秒 + 1 ms になった瞬間にちょうど寿命を迎える A。 */
  const EXPIRING_A = { ...A, arrivalTime: T0 + OFFSET + 1 - ORDER_LIFETIME_MS };
  const AGING: ClientView = { ...OPEN, offset: OFFSET, orderItems: [C, EXPIRING_A, B] };

  /** レールの行の語。 */
  function railNames(): readonly string[] {
    const rail = screen.queryByRole("region", { name: "Waiting orders" });
    return rail === null
      ? []
      : within(rail)
          .getAllByRole("listitem")
          .map((item) => item.querySelector("span")?.textContent ?? "");
  }

  it("snapshot 直後（1 ms 手前）は 3 行、ローカル時計が 1 ms 進んで補正後現在時刻が寿命に達すると A が帯とレールから消え、選べない", () => {
    const { connection, replace } = renderBoard(AGING);
    const dialog = openRadial(0);
    // A は 2 時間前の到着ゆえ先頭に並ぶ（到着順）。
    expect(rows(dialog).map((row) => shown(row).label)).toEqual([
      `Mid 1玉 · ${FIRMNESS} · Table t-1`,
      `Salt L 2玉 · ${FIRMNESS} · Table t-1`,
      `ネギ丼 1玉 · ${FIRMNESS}`,
    ]);
    expect(railNames()).toEqual(["Mid 1玉", "Salt L 2玉", "ネギ丼 1玉"]);

    // 時計の tick（再描画）だけが起きる。snapshot は同じ内容——待ち行列は wire のまま、絞るのは描画の導出である。
    // ローカル時計では A の寿命（arrivalTime + 2 時間 = T0 + 1 秒 + 1 ms）にまだ 1 秒足りないが、補正後現在時刻は
    // ちょうど寿命に達している——判定は補正後現在時刻で行う。
    vi.spyOn(Date, "now").mockReturnValue(T0 + 1);
    replace({ ...AGING });

    expect(screen.getByRole("dialog", { name: "Select noodle" })).toBe(dialog);
    expect(rows(dialog).map((row) => shown(row).label)).toEqual([
      `Salt L 2玉 · ${FIRMNESS} · Table t-1`,
      `ネギ丼 1玉 · ${FIRMNESS}`,
    ]);
    expect(railNames()).toEqual(["Salt L 2玉", "ネギ丼 1玉"]);
    expect(
      within(dialog).queryByRole("button", { name: `Mid 1玉 · ${FIRMNESS} · Table t-1` }),
    ).toBeNull();
    expect(connection.startOrderItem).not.toHaveBeenCalled();
    // 花びら（アドホック開始）は残る。
    for (const preset of PRESETS) expect(petal(dialog, preset)).toBeDefined();
  });
});

// order-lifecycle（AC 4.5・性質 7.6）：帯もレールも同じ未調理（pendingOrders）を読む。snapshot の orderItems に載る
// 調理中（生きた Timer の参照先）・調理済み（completedAt）の品目は、帯にもレールにも現れない。中断済みは戻る。
describe("帯は未調理の品目だけ——調理中・調理済みは orderItems に在っても出ず、中断済みは戻る（order-lifecycle AC 4.5）", () => {
  /** 調理済み（Complete 済み）の品目。期限内なので snapshot には載る。 */
  const DONE = order({
    externalOrderId: "d",
    noodleType: "Mid",
    itemName: "Done",
    completedAt: T0 - 5 * SECOND,
    arrivalTime: T0 - 120 * SECOND,
  });
  /** 一度 Cancel で戻された品目（interruptedAt・状態には効かない）。 */
  const INTERRUPTED = order({
    externalOrderId: "e",
    noodleType: "Short",
    itemName: "Back",
    interruptedAt: T0 - 5 * SECOND,
    arrivalTime: T0 - 45 * SECOND,
  });
  /** A を指す走行中の Timer（釜 5・起点の釜 0 は空いたまま）。 */
  const COOKING_A = timer({
    id: "cook-a",
    slotIds: nonEmpty(["5"]),
    orderItem: { externalOrderId: A.externalOrderId, itemIndex: A.itemIndex },
  });
  const MIXED: ClientView = {
    ...OPEN,
    orderItems: [C, DONE, A, INTERRUPTED, B],
    timers: [COOKING_A],
  };

  it("釜 0 から開くと B → E → C（A は調理中・D は調理済みで出ない）。レールも同じ 3 品", () => {
    renderBoard(MIXED);
    const rail = screen.getByRole("region", { name: "Waiting orders" });
    const railNames = within(rail)
      .getAllByRole("listitem")
      // 戻された品目（INTERRUPTED）の行は名の前に記号 ↩（role="img"・lift-order-numbering Component 4）を持つ。
      // 記号は名の一部ではないので、テキストノードだけを名として読む。
      .map((item) =>
        [...(item.querySelector("span")?.childNodes ?? [])]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(""),
      );
    const dialog = openRadial(0);
    const columnNames = rows(dialog).map((row) => row.querySelector("span")?.textContent ?? "");
    expect(columnNames).toEqual(["Salt L 2玉", "Back 1玉", "ネギ丼 1玉"]);
    expect(columnNames).toEqual(railNames);
  });

  it("A を指す Timer が snapshot から消えれば（厨房 Cancel）、開いたままの帯に A が戻る", () => {
    const { replace } = renderBoard(MIXED);
    const dialog = openRadial(0);
    expect(rows(dialog).map((row) => row.querySelector("span")?.textContent)).not.toContain(
      "Mid 1玉",
    );

    replace({
      ...MIXED,
      timers: [],
      orderItems: [C, DONE, { ...A, interruptedAt: T0 }, INTERRUPTED, B],
    });

    expect(rows(dialog).map((row) => row.querySelector("span")?.textContent)).toEqual([
      "Salt L 2玉",
      "Mid 1玉",
      "Back 1玉",
      "ネギ丼 1玉",
    ]);
  });
});
