// tests/client/audioWiring.example.test.ts — Touch_Cue 配線の example テスト（タスク5.4・要件1.3 / 1.5）。
//
// 検証するのは配線だけである。指定操作（Start 押下＝ラジアルを開く / 麺選択確定 / Cancel / Complete /
// 茹で加減変更）が `playTouchCue` を呼び、指定外操作（設定ポップオーバーの開閉・茹で加減メニューの開閉のみ）が
// 呼ばないこと（要件1.5）、そして `playTouchCue` が失敗しても UI 操作の本体が済むこと（要件1.3）。音そのもの
// （AudioContext・解錠・周期）は `useAudioCues` の関心事でここでは扱わない。
//
// **なぜこの据え付けか**
//
// 本リポジトリに DOM レンダラ（@testing-library/react・jsdom 等）は無い（assignment-ui.example.test.ts の
// 注記）。使えるのは react-dom/server の一回描画だけで、クリックそのものは発生させられない。ゆえに操作は
// 「実描画で子へ渡ったコールバックを直接呼ぶ」形で駆動する——配線とは props に載って渡るコールバックであり、
// その口を呼ぶことが配線を通ることである。SlotCard の実描画は complete.example.test.ts
// （renderToStaticMarkup）の先例に倣い、子は実物へ委譲したまま props だけを控える。
//
// 差し替えは二つだけである。
//   - `useSyncExternalStore`: SlotBoard は getServerSnapshot を渡さないため、サーバ描画は React が
//     「Missing getServerSnapshot」で落とす。初回描画の意味（getSnapshot() を読む）と同形へ置き換える。
//   - 子（SlotCard / RadialMenu / FirmnessCornerControl）: 実物へそのまま委譲しつつ props を控える。
//     描画は本物のまま——観測のために振る舞いを変えない。
//
// **観測できない継ぎ目**: Start 押下（ラジアルを開く）と麺選択確定の「本来の動作」はボード内のローカル状態
// （picker）に閉じ、一回描画では状態更新後の姿を見られない。ゆえに要件1.3 は送信を跨ぐ三つ
// （Cancel / Complete / 茹で加減変更）で検証する。設定ポップオーバーは App（window.location と接続の生成を
// 要する）に属し描画できないため、audioWakeLock.example.test.ts と同じくソーステキストで見る。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
// `?raw` はソーステキストをそのまま取り込む Vite の仮想モジュール。oxlint はクエリ付きの解決を追えず
// 既定 export を見失うため、この 1 行だけ規則を外す（型は tsconfig の vite/client が与える）。
// oxlint-disable-next-line import/default
import appSource from "../../src/client/App.tsx?raw";
import { SlotBoard } from "../../src/client/components/SlotBoard";
import type { SlotCard } from "../../src/client/components/SlotCard";
import type { RadialMenu } from "../../src/client/components/RadialMenu";
import type { FirmnessCornerControl } from "../../src/client/components/FirmnessCornerControl";
import { EMPTY_VIEW, type ClientView, type TimerConnection } from "../../src/client/connection";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";

type SlotCardProps = Parameters<typeof SlotCard>[0];
type RadialMenuProps = Parameters<typeof RadialMenu>[0];
type FirmnessProps = Parameters<typeof FirmnessCornerControl>[0];

/** 実描画で子へ渡った props の控え。差し替えの工場が参照するため vi.hoisted で先に据える。 */
const capture = vi.hoisted(() => ({
  slotCards: [] as SlotCardProps[],
  radials: [] as RadialMenuProps[],
  firmnesses: [] as FirmnessProps[],
}));

// SlotBoard は `useSyncExternalStore(connection.subscribe, connection.getView)` を 2 引数で呼ぶ。サーバ描画は
// getServerSnapshot を要求して落ちるため、初回描画の意味（getSnapshot() の値を返す）と同形へ置き換える。
// 差し替えるのはこの 1 フックだけで、他は実物の React を通す。
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T): T => getSnapshot(),
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

vi.mock("../../src/client/components/RadialMenu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/components/RadialMenu")>();
  const { createElement: element } = await import("react");
  return {
    RadialMenu: (props: RadialMenuProps) => {
      capture.radials.push(props);
      return element(actual.RadialMenu, props);
    },
  };
});

vi.mock("../../src/client/components/FirmnessCornerControl", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/client/components/FirmnessCornerControl")>();
  const { createElement: element } = await import("react");
  return {
    FirmnessCornerControl: (props: FirmnessProps) => {
      capture.firmnesses.push(props);
      return element(actual.FirmnessCornerControl, props);
    },
  };
});

/** 担当ユニット。unit 0 = slot 0..5（走行中 slot 0・茹で上がり slot 1・残りは idle）。 */
const ASSIGNED_UNITS: readonly number[] = [0];
const RUNNING_TIMER_ID = "RUN";
const BOILED_TIMER_ID = "BOILED";

/**
 * 指定操作の口がすべて現れる盤面。走行中（Cancel と茹で加減変更の口）・茹で上がり（Complete の口）・
 * idle（Start の口）を同時に含める。offset は EMPTY_VIEW の 0 のままなので endTime は実時刻の直値で足りる。
 */
function boardView(now: number): ClientView {
  return {
    ...EMPTY_VIEW,
    // idle が Start を提示するのは同期済みのときだけ（未同期は unreceived で操作手段を持たない）。
    sync: "synced",
    connectivity: "up",
    timers: [
      {
        id: RUNNING_TIMER_ID,
        slotIds: ["0"],
        noodleType: "Thin",
        firmness: "normal",
        startTime: now - 30_000,
        endTime: now + 120_000,
        origin: "server",
      },
      {
        id: BOILED_TIMER_ID,
        slotIds: ["1"],
        noodleType: "Medium",
        firmness: "normal",
        startTime: now - 95_000,
        endTime: now - 5_000,
        origin: "server",
      },
    ],
  };
}

/** 盤面を実描画し、子へ渡った操作の口と接続への送信を観測できる形で返す。 */
function renderBoard(playTouchCue: () => void) {
  capture.slotCards.length = 0;
  capture.radials.length = 0;
  capture.firmnesses.length = 0;

  const cancel = vi.fn<TimerConnection["cancel"]>();
  const complete = vi.fn<TimerConnection["complete"]>();
  const adjust = vi.fn<TimerConnection["adjust"]>();
  // SlotBoard は描画時点の Date.now() で残りを導出するため、盤面も同じ実時刻を基準に組む。
  const view = boardView(Date.now());
  const connection: TimerConnection = {
    getView: () => view,
    subscribe: () => () => {},
    // 開始の送信は観測に使わない。ラジアルの開閉はボード内のローカル状態で、一回描画では Start 押下の
    // 状態更新（picker）が反映されないため、麺選択確定の分岐（`if (picker)`）へは到達しない。
    start: vi.fn<TimerConnection["start"]>(),
    cancel,
    complete,
    adjust,
    close: () => {},
  };

  const html = renderToStaticMarkup(
    createElement(SlotBoard, { connection, units: ASSIGNED_UNITS, playTouchCue }),
  );

  return {
    html,
    cancel,
    complete,
    adjust,
    /** 指定スロットのカードへ渡った操作の口（SlotBoard が合成した本物）。 */
    slotCard: (slot: number): SlotCardProps => {
      const props = capture.slotCards.find((card) => card.display.slot === slot);
      if (props === undefined) throw new Error(`slot ${slot} のカードが描画されていない`);
      return props;
    },
    /** ボードが 1 つだけ描くラジアルメニューの口（麺選択確定はここを通る）。 */
    radial: (): RadialMenuProps => {
      const props = capture.radials[0];
      if (props === undefined) throw new Error("RadialMenu が描画されていない");
      return props;
    },
    /**
     * 走行中カードの茹で加減コントロール。茹で上がりカードも同じ口を描くが、そちらは操作不能
     * （SlotCard が `disabled={isBoiled}` を渡す）ゆえ disabled で区別できる。
     */
    firmnessOfRunning: (): FirmnessProps => {
      const props = capture.firmnesses.find((control) => control.disabled !== true);
      if (props === undefined)
        throw new Error("走行中カードの茹で加減コントロールが描画されていない");
      return props;
    },
  };
}

describe("Touch_Cue の配線（タスク5.4・要件1.3 / 1.5）", () => {
  it("Start 押下・麺選択確定・Cancel・Complete・茹で加減変更のそれぞれで 1 回鳴る（要件1.1 / 1.5）", () => {
    const cue = vi.fn<() => void>();
    const board = renderBoard(cue);

    // Start 押下＝ラジアルを開くタップ（idle スロット）。開く動作とは別に、このタップ自体へ 1 回乗る。
    board.slotCard(2).onStart(2, { x: 120, y: 240 });
    expect(cue).toHaveBeenCalledTimes(1);

    // 麺選択確定（RadialMenu の onSelect）。Start 押下とは別タップゆえ、ここでも 1 回鳴る
    // （鳴動は開始の分岐の外にあるため、picker が未反映の一回描画でも配線は通る）。
    board.radial().onSelect(DEFAULT_NOODLE_PRESETS[0]);
    expect(cue).toHaveBeenCalledTimes(2);

    // Cancel（走行中カード）。SlotBoard が connection.cancel と同じハンドラで鳴らす。
    board.slotCard(0).onCancel(RUNNING_TIMER_ID);
    expect(cue).toHaveBeenCalledTimes(3);
    expect(board.cancel).toHaveBeenCalledWith(RUNNING_TIMER_ID);

    // Complete（茹で上がりカードの消し込み）。対象 Timer は表示導出が持つ本物を渡す。
    const boiled = board.slotCard(1).display;
    if (boiled.kind !== "boiled") throw new Error("slot 1 が boiled として描画されていない");
    board.slotCard(1).onComplete(1, boiled.timer);
    expect(cue).toHaveBeenCalledTimes(4);
    expect(board.complete).toHaveBeenCalledWith(BOILED_TIMER_ID);

    // 茹で加減変更（FirmnessCornerControl の選択＝確定）。メニューの開閉とは別のタップである。
    board.firmnessOfRunning().onChange("hard");
    expect(cue).toHaveBeenCalledTimes(5);
    expect(board.adjust).toHaveBeenCalledWith(RUNNING_TIMER_ID, "hard");
  });

  it("茹で加減メニューの開閉だけでは鳴らない（指定外操作・要件1.5）", () => {
    const cue = vi.fn<() => void>();
    const board = renderBoard(cue);
    const firmness = board.firmnessOfRunning();
    // 開閉の口が実在することを先に確かめる（無ければ以下の呼び出しは空振りし、主張が空になる）。
    expect(firmness.onOpenChange, "SlotCard が開閉通知の口を受け取っていない").toBeTypeOf(
      "function",
    );

    // 開閉はカード内のローカル状態（操作ボタンを隠すか）だけを動かす。確定ではないので adjust も鳴動も伴わない。
    firmness.onOpenChange?.(true);
    firmness.onOpenChange?.(false);

    expect(cue).not.toHaveBeenCalled();
    expect(board.adjust).not.toHaveBeenCalled();
  });

  it("設定ポップオーバーの開閉には配線されていない（指定外操作・要件1.5）", () => {
    // ボード側: 設定は App の上部バーに属し、Touch_Cue が相乗りするボードの描画には現れない。
    const board = renderBoard(vi.fn<() => void>());
    expect(board.html).not.toContain("Settings");

    // App 側: 設定ポップオーバーの開閉を起こす唯一の遷移は setSettingsOpen である。その呼び出しのどれにも
    // playTouchCue は現れない。App は window.location と接続の生成を要して描画できないため、ここは
    // ソーステキストで見る（audioWakeLock.example.test.ts と同じ静的検査の形）。
    const toggleSites = appSource.split("\n").filter((line) => line.includes("setSettingsOpen("));
    expect(
      toggleSites.length,
      "App.tsx に setSettingsOpen の呼び出しが見当たらない",
    ).toBeGreaterThanOrEqual(2);
    for (const site of toggleSites) {
      expect(site, "設定ポップオーバーの開閉に playTouchCue が配線されている").not.toContain(
        "playTouchCue",
      );
    }
    // 受け取った再生口の行き先はボードだけである（指定外に配線されていないことの裏付け）。
    expect(appSource, "App が playTouchCue を SlotBoard へ渡していない").toMatch(
      /<SlotBoard[^>]*playTouchCue=\{playTouchCue\}/,
    );
  });

  it("再生が失敗しても UI 操作の本体は継続する（best-effort・要件1.3）", () => {
    const cue = vi.fn<() => void>(() => {
      throw new Error("cue failed");
    });
    const board = renderBoard(cue);
    const boiled = board.slotCard(1).display;
    if (boiled.kind !== "boiled") throw new Error("slot 1 が boiled として描画されていない");

    // playTouchCue は各ハンドラの最後に呼ばれる。ゆえに失敗しても本来の動作（送信）は既に済んでいる。
    // 例外の行方そのものは要件1.3 の主張ではない（実系では useAudioCues が失敗を握り潰す）ため問わない。
    driveIgnoringCueFailure(() => board.slotCard(0).onCancel(RUNNING_TIMER_ID));
    driveIgnoringCueFailure(() => board.slotCard(1).onComplete(1, boiled.timer));
    driveIgnoringCueFailure(() => board.firmnessOfRunning().onChange("soft"));

    expect(board.cancel).toHaveBeenCalledWith(RUNNING_TIMER_ID);
    expect(board.complete).toHaveBeenCalledWith(BOILED_TIMER_ID);
    expect(board.adjust).toHaveBeenCalledWith(RUNNING_TIMER_ID, "soft");
    // 三度とも再生は試みられている（失敗が次の操作の再生を止めない）。
    expect(cue).toHaveBeenCalledTimes(3);
  });
});

/** 再生失敗の例外を無視して操作を呼び切る。要件1.3 が要求するのは UI 操作本体の継続である。 */
function driveIgnoringCueFailure(operate: () => void): void {
  try {
    operate();
  } catch (cueFailure) {
    expect(cueFailure).toBeInstanceOf(Error);
  }
}
