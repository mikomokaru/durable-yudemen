// tests/client/useAudioCues.example.test.ts — 解錠ゲートと非対応環境の example テスト（タスク3.6）。
//
// 確認するのは二つだけである。
//   1. 未解錠（`AudioContext.state` が running でない）あいだは Pre_Alert / Done / Touch が鳴らず、
//      running を実測できた以後は鳴る（要件1.2 / 4.3 / 4.4）。
//   2. 音声出力 API 非提供（`AudioContext` / `webkitAudioContext` 不在）では例外を投げず何もしない（要件4.5）。
// Done の 5 秒周期・可視復帰・closed からの作り直しは integration テスト（タスク3.7）の関心事でここでは扱わない。
//
// **なぜこの据え付けか（フックの駆動をどう選んだか）**
//
// 本リポジトリに DOM レンダラ（jsdom / @testing-library/react）は無く、依存も増やせない。使えるのは
// `react-dom/server` の一回描画だけで、そこでは `useEffect` が走らない——ところが `useAudioCues` の
// 評価ティック（Pre_Alert 判定と Done 周期）はその効果の中にある。ゆえに選択肢は三つだった。
//
//   (a) 純粋層と audioTone だけを突く — `playPreAlertTone(suspended な ctx)` を呼んで「鳴らない」と言う形。
//       だがゲートは audioTone ではなく `readyContext`/`emit`（フック側）にある。この形は「フックなら呼ばない
//       はずだ」という前提をテストへ書き写すだけで、ゲートの再実装にほかならない。採らない。
//   (b) フック用のレンダラを自作する（`useRef`/`useCallback` を自前ディスパッチャで代行）— 依存は増えないが、
//       検証対象の周りに React の偽物を組み上げることになり、通す経路が本物から遠のく。採らない。
//   (c) 実レンダラ（`react-dom/server`）を通し、`useEffect` だけを「マウント時に 1 回走る」意味へ差し替える。
//
// (c) を採った。差し替えるのは React のフック 1 つで、これは audioWiring.example.test.ts が
// `useSyncExternalStore` を「初回描画の意味（getSnapshot() を読む）」へ置き換えた先例と同じ形である。
// 本フックの効果は依存 `[emit, readyContext]` が安定な mount-once であり、片付けも返り値の関数ひとつ。
// ゆえに「描画時に 1 回呼び、cleanup をテストへ渡す」置き換えで、マウントの意味は保たれる。
// 持ち込む嘘は効果の**時点**（commit 後ではなく描画中）だけであり、本フックはその順序に何も依存しない。
// この一手で、通る経路は本物になる——`readyContext` / `emit` / 実 tick / `advancePreAlert` / `dueDoneCue` /
// `boiledTimerIds` / `assignedSlotDisplays` / 実 `audioTone`。テスト側にゲートの写しは無い。
//
// 時刻は `options.now` で注入し、`setInterval` の駆動（vi の偽タイマー）と同じ歩幅で進める。Date を偽装した
// 暗黙時計に頼らないのは、workerd では `Date.now` の進み方が特殊で、端のテストでも時刻は引数で運ぶのが
// 本リポジトリの作法だからである（connection.example.test.ts と同じ注入）。
//
// 偽の音声環境（`window.AudioContext` / `document`）は audioMocks.ts に置いた共有の据え付けを使い、
// テストごとに差し込んで afterEach で必ず戻す（グローバルを跨いで漏らさない）。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudioCues, type AudioCues } from "../../src/client/components/useAudioCues";
import { EMPTY_VIEW, type ClientTimer, type ClientView } from "../../src/client/connection";
import { installFakeAudio, type FakeAudio, type FakeAudioOptions } from "./audioMocks";

/** 描画で得た再生口と、マウントした効果の片付け。差し替えの工場が参照するため vi.hoisted で先に据える。 */
const mounted = vi.hoisted(() => ({
  cues: [] as AudioCues[],
  teardowns: [] as (() => void)[],
}));

// `useEffect` だけを「マウント時に 1 回走る」意味へ置き換える（冒頭の注記 (c)）。サーバ描画では効果が
// 走らないため、描画中に 1 回呼んで片付けをテストへ預ける。他は実物の React を通す。
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      const teardown = effect();
      if (typeof teardown === "function") mounted.teardowns.push(teardown);
    },
  };
});

/** 検証対象のフックを 1 回だけ呼び、返り値を控えるだけの器（描画結果は空）。 */
function AudioCuesProbe(props: {
  readonly view: ClientView;
  readonly units: readonly number[];
  readonly now: () => number;
}): null {
  mounted.cues.push(useAudioCues(props.view, props.units, { now: props.now }));
  return null;
}

/** 担当ユニット。unit 0 = slot 0..5。 */
const ASSIGNED_UNITS: readonly number[] = [0];
/** 評価ティックの既定間隔（フックの既定値。ここでは上書きせず既定のまま駆動する）。 */
const TICK_MS = 1000;
const BASE = 1_700_000_000_000;

/** 注入する現在時刻。偽タイマーと同じ歩幅で進める（advanceTicks が唯一の進め手）。 */
let clock = BASE;
/** 差し込んだ偽の音声環境（afterEach で必ず戻す）。 */
let fake: FakeAudio | null = null;

function installAudio(options?: FakeAudioOptions): FakeAudio {
  fake = installFakeAudio(options);
  return fake;
}

/** 担当スロット 1 つを駆動する Timer。boiled / Pre_Alert の資格は endTime と now の関係だけで決まる。 */
function timerAt(id: string, slotId: string, endTime: number): ClientTimer {
  return {
    id,
    slotIds: [slotId],
    noodleType: "Thin",
    firmness: "normal",
    startTime: BASE - 100_000,
    endTime,
    orderItem: null,
    origin: "server",
  };
}

/** 同期済みの盤面。offset は EMPTY_VIEW の 0 のままゆえ endTime は注入時刻の直値で足りる。 */
function viewOf(timers: readonly ClientTimer[]): ClientView {
  return { ...EMPTY_VIEW, sync: "synced", connectivity: "up", timers };
}

/** フックをマウントして再生口を得る（効果＝リスナ登録と評価ティックはこの時点で走る）。 */
function mountCues(view: ClientView): AudioCues {
  mounted.cues.length = 0;
  renderToStaticMarkup(
    createElement(AudioCuesProbe, { view, units: ASSIGNED_UNITS, now: () => clock }),
  );
  const cues = mounted.cues[0];
  if (cues === undefined) throw new Error("useAudioCues の返り値が得られていない");
  return cues;
}

/**
 * 評価ティックを count 回進める。注入時刻と偽タイマーを 1 ティックずつ同じ量だけ動かすため、各ティックが
 * 見る now は実系と同じく単調に 1 秒刻みで進む（一括ジャンプで閾値クロスを飛ばさない）。
 */
function advanceTicks(count: number): void {
  for (let i = 0; i < count; i++) {
    clock += TICK_MS;
    vi.advanceTimersByTime(TICK_MS);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = BASE;
});

afterEach(() => {
  // 片付け → 偽環境の撤収 の順。片付けは document.removeEventListener と ctx.close() を通るため、
  // 偽の globals が生きているあいだに走らせる。
  for (const teardown of mounted.teardowns.splice(0)) teardown();
  mounted.cues.length = 0;
  fake?.uninstall();
  fake = null;
  vi.useRealTimers();
});

describe("useAudioCues — 解錠ゲートと非対応環境（タスク3.6・要件1.2 / 4.3 / 4.4 / 4.5）", () => {
  it("未解錠（resume が効かない）のあいだ Pre_Alert も Done も鳴らない（要件4.3）", () => {
    // resume が resolve しても running へ上がらない iOS（design.md「resume が効かない」）。
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "stay" });
    // 残り 70 秒。ティック 10 で閾値 60 秒を跨ぎ、ティック 70 で boiled になる。
    const cues = mountCues(viewOf([timerAt("A", "0", BASE + 70_000)]));
    expect(cues.playTouchCue).toBeTypeOf("function");

    // ジェスチャ前。評価ティックは Audio_Session を生成しない（生成はジェスチャ内に限る・iOS の解錠条件）。
    advanceTicks(2);
    expect(audio.contexts.length, "非ジェスチャの評価ティックが Audio_Session を生成した").toBe(0);

    // ジェスチャで生成＋resume。resume は効かないので suspended のまま＝未解錠。
    audio.fireGesture();
    expect(audio.contexts.length).toBe(1);
    const session = audio.latest();
    expect(session.state).toBe("suspended");
    // warm-up（無音バッファ）を持たない設計ゆえ、解錠の試行そのものは音を出さない。
    expect(session.oscillators.length, "解錠の試行が音を鳴らしている").toBe(0);

    // 閾値クロス（ティック 10）を跨ぐ。判定は走るが、running を実測できないので鳴らない。
    advanceTicks(10);
    expect(session.oscillators.length, "未解錠で Pre_Alert が鳴っている").toBe(0);

    // boiled へ（ティック 70）。Done 周期が到来しても同じく鳴らない。
    advanceTicks(60);
    expect(session.oscillators.length, "未解錠で Done が鳴っている").toBe(0);
    expect(session.gains.length, "鳴らない回でノードが撃たれている").toBe(0);

    // 鳴らない代わりに、鳴らそうとした各回で resume が投げられている（回復の機会が周期に内包される）。
    expect(session.resume.mock.calls.length).toBeGreaterThan(1);
    // 効かない resume で Audio_Session を作り直したりしない（closed でないものは捨てない）。
    expect(audio.contexts.length).toBe(1);
    expect(session.state).toBe("suspended");
  });

  it("running を実測できた以後は Pre_Alert と Done が鳴る（要件4.4）", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    const cues = mountCues(viewOf([timerAt("A", "0", BASE + 70_000)]));
    expect(cues.playTouchCue).toBeTypeOf("function");

    // ジェスチャ内の resume が効いて running へ。ここでも音は出ない（warm-up を持たない）。
    audio.fireGesture();
    const session = audio.latest();
    expect(session.state).toBe("running");
    expect(session.oscillators.length).toBe(0);

    // 閾値クロス（ティック 10）で Pre_Alert が鳴る。
    advanceTicks(10);
    const afterPreAlert = session.oscillators.length;
    expect(afterPreAlert, "解錠後も Pre_Alert が鳴らない").toBeGreaterThan(0);
    // 撃ったノードは接続され開始されている（鳴らす経路を実際に通った証跡）。
    for (const oscillator of session.oscillators) {
      expect(oscillator.start).toHaveBeenCalledTimes(1);
      expect(oscillator.connect).toHaveBeenCalledTimes(1);
    }
    for (const gain of session.gains) {
      expect(gain.connect).toHaveBeenCalledWith(session.destination);
    }

    // boiled へ（ティック 70）。Pre_Alert は once-only ゆえ二度目は無く、ここでの増分は Done である。
    advanceTicks(60);
    expect(session.oscillators.length, "解錠後も Done が鳴らない").toBeGreaterThan(afterPreAlert);
    // 鳴った以後も Audio_Session は 1 つ（作り直していない）。
    expect(audio.contexts.length).toBe(1);
  });

  it("未解錠の Touch_Cue は鳴らず例外も投げず、解錠後は鳴る（要件1.2 / 4.4）", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "stay" });
    const cues = mountCues(viewOf([]));

    // 未解錠。指定操作のたびに resume を試みるが、鳴らさず・投げない（UI 本来の動作を妨げない）。
    expect(() => cues.playTouchCue()).not.toThrow();
    expect(() => cues.playTouchCue()).not.toThrow();
    const session = audio.latest();
    expect(audio.contexts.length).toBe(1);
    expect(session.oscillators.length, "未解錠で Touch_Cue が鳴っている").toBe(0);
    expect(session.resume).toHaveBeenCalledTimes(2);

    // resume が効くようになった＝この操作が解錠点になる。解錠は「実測」ゆえ、running を読める次の機会から鳴る。
    session.resumeOutcome = "running";
    cues.playTouchCue();
    expect(session.state).toBe("running");
    expect(session.oscillators.length, "解錠の試行そのものが鳴っている").toBe(0);

    cues.playTouchCue();
    expect(session.oscillators.length, "解錠後も Touch_Cue が鳴らない").toBeGreaterThan(0);
  });

  it("音声出力 API 非提供では例外を投げず何もしない（要件4.5）", () => {
    // AudioContext も webkitAudioContext も無い環境。
    const audio = installAudio({ expose: "absent" });
    const boiled = viewOf([timerAt("A", "0", BASE - 1_000)]); // 既に boiled（Done 周期の条件は成立している）

    const cues = mountCues(boiled);

    // リスナも張らず、評価ティックも仕掛けない（何もせず劣化する）。
    expect(audio.listenerCount("touchstart"), "非対応環境で解錠リスナを張っている").toBe(0);
    expect(audio.listenerCount("visibilitychange")).toBe(0);
    expect(vi.getTimerCount(), "非対応環境で評価ティックを仕掛けている").toBe(0);

    // どの入口を叩いても投げない。Audio_Session は 1 つも生成されない。
    expect(() => cues.playTouchCue()).not.toThrow();
    expect(() => advanceTicks(120)).not.toThrow();
    expect(() => audio.fireGesture()).not.toThrow();
    expect(() => audio.becomeVisible()).not.toThrow();
    expect(audio.contexts.length, "非対応環境で Audio_Session を生成した").toBe(0);
  });
});
