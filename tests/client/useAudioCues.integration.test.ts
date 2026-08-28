// tests/client/useAudioCues.integration.test.ts — Audio_Session のライフサイクルと、周期・自己回復の
// integration テスト（タスク3.7）。
//
// 扱うのは「時間と Audio_Session の状態が動くこと」で初めて現れる振る舞いだけである——解錠の起点、
// Done の 5 秒周期、中断からの回復、closed からの作り直し、可視復帰、評価ティックの粗さ。解錠ゲートそのもの
// （未解錠では鳴らない・非対応環境では何もしない）は useAudioCues.example.test.ts（タスク3.6）の関心事ゆえ
// ここでは繰り返さない。
//
// **据え付けは 3.6 と同一**（理由の全文は useAudioCues.example.test.ts 冒頭を参照）。要点だけ:
//   - `useEffect` のみを「マウント時に 1 回走る」意味へ差し替え、実 React ＋ `react-dom/server` で描画する。
//     通る経路は本物（readyContext / emit / 実 tick / 純粋層 / 実 audioTone）で、テスト側にゲートの写しは無い。
//   - 時刻は `options.now` で注入し、偽タイマーと同じ歩幅で進める（`advanceMs` が唯一の進め手）。
//   - 偽の音声環境は audioMocks.ts を使い、テストごとに差し込んで afterEach で必ず戻す。
//
// **タスク3.7 の文面と現行実装のズレ（実装の現行の形に合わせて主張する）**
//
// タスク文面（および要件4.2 / 7.4 の原文）は warm-up 版の実装を前提にしているが、現行実装はそれを持たない。
// design.md「解錠は『実測』で扱う（warm-up / onended に頼らない）」の通り、warm-up 版は iOS 実機で
// 永久未解錠に陥ったため撤去されている。ゆえに本テストは次を**主張しない**（存在しない振る舞いを偽らない）。
//   - 「無音バッファの warm-up」「無音 `onended` で running を確定」— 実装に該当経路が無い。
//     代わりに「解錠の試行そのものは音を鳴らさない」「ジェスチャ内 resume で running を実測できる」を主張する。
//   - 「解錠成立後にリスナを一括解除」— 実装は解錠フラグを持たないので解除の儀式が無い。
//     代わりに「リスナは張られ続け、running なら readyContext を素通りして resume を追試しない」を主張する。
//   - 「resume 失敗 → close → 再生成」— 実装が捨てて作り直すのは `state === "closed"` のときだけである。
//     代わりに「reject でも Audio_Session を捨てず、次の機会に resume を再試行して同一 Audio_Session が回復する」
//     「closed は次ジェスチャで作り直される」を分けて主張する。
//   - 「周期の冒頭で resume を試みた上で Done_Cue を再生」— 実装は resume を投げてその周期は pop 破棄し、
//     次の周期で鳴らす（鳴らないノードを撃たない）。ゆえに「冒頭で resume を投げる」と「次周期で回復する」を
//     分けて主張する。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudioCues, type AudioCues } from "../../src/client/components/useAudioCues";
import { EMPTY_VIEW, type ClientTimer, type ClientView } from "../../src/client/connection";
import {
  installFakeAudio,
  type FakeAudio,
  type FakeAudioOptions,
  type GestureKind,
} from "./audioMocks";

/** 描画で得た再生口と、マウントした効果の片付け。差し替えの工場が参照するため vi.hoisted で先に据える。 */
const mounted = vi.hoisted(() => ({
  cues: [] as AudioCues[],
  teardowns: [] as (() => void)[],
}));

// `useEffect` だけを「マウント時に 1 回走る」意味へ置き換える（据え付けの理由は 3.6 の冒頭注記）。
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
/** 評価ティックの既定間隔（フックの既定値。上書きせず既定のまま駆動し、その粗さ自体を検証する）。 */
const TICK_MS = 1000;
/** Done_Cue の周期（audioCue.ts の DONE_CUE_INTERVAL_MS と同じ 5 秒）。 */
const DONE_INTERVAL_TICKS = 5;
/** 解錠ジェスチャの 4 種（useAudioCues.ts の UNLOCK_EVENTS と同じ並び）。 */
const UNLOCK_GESTURES: readonly GestureKind[] = ["touchstart", "touchend", "click", "keydown"];
const BASE = 1_700_000_000_000;

/** 注入する現在時刻。偽タイマーと同じ歩幅で進める。 */
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
    origin: "server",
  };
}

/** 同期済みの盤面。offset は EMPTY_VIEW の 0 のままゆえ endTime は注入時刻の直値で足りる。 */
function viewOf(timers: readonly ClientTimer[]): ClientView {
  return { ...EMPTY_VIEW, sync: "synced", connectivity: "up", timers };
}

/** フックをマウントして再生口を得る（効果＝リスナ登録と評価ティックの仕掛けはこの時点で走る）。 */
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
 * 注入時刻と偽タイマーを同じ量だけ進める。時刻を先に動かすため、この区間で発火する評価ティックは
 * 進めた先の now を見る（実系と同じ順序）。1 ティック未満の量を渡してティックの粗さ自体を測るためにある。
 */
function advanceMs(ms: number): void {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

/** 評価ティックを count 回進める。1 ティックずつ刻むことで、一括ジャンプで閾値クロスを飛ばさない。 */
function advanceTicks(count: number): void {
  for (let i = 0; i < count; i++) advanceMs(TICK_MS);
}

/**
 * 壁時計だけを進める（評価ティックは発火させない）。
 * なぜ必要か: 非可視のあいだ OS はタイマーを throttle して止めるが、時間そのものは進む。この非対称を
 * 作らないと「可視復帰時にまとめて再評価される」振る舞い（要件5.2）を観測できない。
 */
function advanceClockOnly(ms: number): void {
  clock += ms;
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

describe("Audio_Unlock — 最初のジェスチャが解錠点（要件4.1 / 4.2 / 4.6）", () => {
  it("4 種のジェスチャを capture フェーズで待受し、最初のジェスチャ内で生成＋resume して running を実測する", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    mountCues(viewOf([]));

    // capture フェーズで張る（bubble 側では張らない）。子要素が止めるタップも取りこぼしにくい（要件4.2）。
    for (const gesture of UNLOCK_GESTURES) {
      expect(audio.listenerCount(gesture, true), `${gesture} を capture で待受していない`).toBe(1);
      expect(audio.listenerCount(gesture, false), `${gesture} を bubble でも待受している`).toBe(0);
    }
    // ジェスチャ前に Audio_Session は無い（生成はジェスチャ経路のみ・iOS の解錠条件）。
    expect(audio.contexts.length).toBe(0);

    // 最初のジェスチャ。この 1 回で生成し、同じジェスチャ内で resume を 1 回投げる（要件4.1）。
    audio.fireGesture("touchstart");
    expect(audio.contexts.length).toBe(1);
    const session = audio.latest();
    expect(session.resume).toHaveBeenCalledTimes(1);
    expect(session.state, "ジェスチャ内 resume で running を実測できていない").toBe("running");
    // 解錠の試行そのものは音を出さない（warm-up の無音バッファを持たない現行実装）。
    expect(session.oscillators.length, "解錠の試行が音を鳴らしている").toBe(0);
    expect(session.gains.length).toBe(0);

    // running を実測できて以後、待受は張られ続ける（解錠フラグを持たないので一括解除の儀式が無い）。
    // 張りっぱなしでも安いのは、running なら readyContext を素通りして resume を追試しないからである。
    for (const gesture of UNLOCK_GESTURES) expect(audio.listenerCount(gesture, true)).toBe(1);
    audio.fireGesture("click");
    audio.fireGesture("keydown");
    expect(session.resume, "running なのに resume を追試している").toHaveBeenCalledTimes(1);
    expect(audio.contexts.length, "running なのに Audio_Session を作り直している").toBe(1);
  });

  it("解錠の試行が失敗しても、次のジェスチャを起点に再試行する（要件4.6）", () => {
    // resume が resolve しても running へ上がらない iOS（design.md「resume が効かない」）。
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "stay" });
    mountCues(viewOf([]));

    // 3 種のジェスチャで 3 回試行する。試行のたびに resume が投げられ、Audio_Session は捨てられない。
    audio.fireGesture("touchstart");
    const session = audio.latest();
    audio.fireGesture("touchend");
    audio.fireGesture("click");
    expect(session.resume, "次のジェスチャで再試行していない").toHaveBeenCalledTimes(3);
    expect(session.state).toBe("suspended");
    expect(audio.contexts.length).toBe(1);
    expect(session.close, "失敗しただけで Audio_Session を捨てている").not.toHaveBeenCalled();

    // resume が効くようになれば、次のジェスチャがそのまま解錠点になる（試行回数に上限を持たない）。
    session.resumeOutcome = "running";
    audio.fireGesture("keydown");
    expect(session.state).toBe("running");
    expect(audio.contexts.length).toBe(1);
  });
});

describe("Touch_Cue — 即時スケジュールと再トリガ（要件1.1 / 1.6）", () => {
  it("呼び出しの中で ctx.currentTime に予約され、連続呼び出しでは都度新ノードになる", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    const cues = mountCues(viewOf([]));
    audio.fireGesture(); // 解錠（この試行では鳴らない）
    const session = audio.latest();
    expect(session.oscillators.length).toBe(0);

    // タイマー待ちを介さず、呼び出しが戻った時点で予約が済んでいる（遅延を足さない・要件1.1）。
    cues.playTouchCue();
    const first = [...session.oscillators];
    expect(first.length, "Touch_Cue がノードを撃っていない").toBeGreaterThan(0);
    for (const oscillator of first) {
      expect(oscillator.start).toHaveBeenCalledTimes(1);
      // 開始時刻は ctx の現在時刻そのもの＝Cue 側で遅延を足していない。
      expect(oscillator.start).toHaveBeenCalledWith(session.currentTime);
    }

    // 直前の Touch_Cue の終了（onended）を起こさないまま再度呼ぶ＝未完了での再トリガ（要件1.6）。
    cues.playTouchCue();
    const second = session.oscillators.slice(first.length);
    expect(second.length, "再トリガで新しいノードが撃たれていない").toBe(first.length);
    expect(new Set([...first, ...second]).size, "ノードが再利用されている").toBe(
      first.length + second.length,
    );
    // 既存ノードへ再 start しない（finished ノードへの再 start＝InvalidStateError を構造的に避ける）。
    for (const oscillator of [...first, ...second]) {
      expect(oscillator.start).toHaveBeenCalledTimes(1);
    }
  });
});

describe("再生終了ノードの後始末（要件3.11）", () => {
  it("onended で disconnect され、複数周期にわたって滞留も再 start も起きない", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    mountCues(viewOf([timerAt("A", "0", BASE - 1_000)])); // 既に boiled
    audio.fireGesture();
    const session = audio.latest();

    advanceTicks(1); // 最初の Done（boiled 非空で lastRingAt が無い＝即時）
    const perCue = session.oscillators.length;
    expect(perCue, "Done_Cue が鳴っていない").toBeGreaterThan(0);
    expect(session.gains.length).toBe(perCue);

    // 再生終了を起こす。各ノードが disconnect され、onended は null 化される（参照を残さない）。
    for (const oscillator of session.oscillators) oscillator.finish();
    for (const oscillator of session.oscillators) {
      expect(oscillator.disconnect).toHaveBeenCalledTimes(1);
      expect(oscillator.onended, "onended が null 化されていない").toBeNull();
    }
    for (const gain of session.gains) expect(gain.disconnect).toHaveBeenCalledTimes(1);

    // さらに 2 周期。各周期はちょうど 1 Cue 分の新ノードだけを作る（周期ごとの滞留が無い）。
    advanceTicks(DONE_INTERVAL_TICKS);
    expect(session.oscillators.length).toBe(perCue * 2);
    advanceTicks(DONE_INTERVAL_TICKS);
    expect(session.oscillators.length).toBe(perCue * 3);
    expect(session.gains.length).toBe(perCue * 3);
    for (const oscillator of session.oscillators) {
      expect(oscillator.start, "終了済みノードへ再 start している").toHaveBeenCalledTimes(1);
    }
  });
});

describe("Done_Cue の 5 秒周期と自己回復（要件3.1 / 3.11 / 7.5 / 7.6）", () => {
  it("boiled が残る間、5 秒ごとにちょうど 1 回鳴る（要件3.1）", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    mountCues(viewOf([timerAt("A", "0", BASE - 1_000)])); // 既に boiled
    audio.fireGesture();
    const session = audio.latest();

    advanceTicks(1); // 1 発目（未存在→存在の遷移は既に済んでおり lastRingAt が無い＝即時）
    const perCue = session.oscillators.length;
    expect(perCue).toBeGreaterThan(0);

    advanceTicks(DONE_INTERVAL_TICKS - 1); // 周期未満（4 秒）では鳴らない
    expect(session.oscillators.length, "周期未満で鳴っている").toBe(perCue);

    advanceTicks(1); // 5 秒目で 2 発目
    expect(session.oscillators.length).toBe(perCue * 2);

    advanceTicks(DONE_INTERVAL_TICKS - 1);
    expect(session.oscillators.length).toBe(perCue * 2);

    advanceTicks(1); // 3 発目
    expect(session.oscillators.length).toBe(perCue * 3);
  });

  it("周期の冒頭で state を実測して resume を投げ、その周期は鳴らさず次周期で回復する（要件7.5 / 7.6）", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    mountCues(viewOf([timerAt("A", "0", BASE - 1_000)]));
    audio.fireGesture();
    const session = audio.latest();
    advanceTicks(1);
    const perCue = session.oscillators.length;
    expect(perCue).toBeGreaterThan(0);
    const resumesBefore = session.resume.mock.calls.length;

    // 着信等で Audio_Session が中断された（前面に居ても自動では running へ戻らない）。
    session.state = "interrupted";

    advanceTicks(DONE_INTERVAL_TICKS); // 次の周期の冒頭
    // 冒頭で state を実測し、running でないので resume を投げた（回復の機会が周期に内包される・要件7.5）。
    expect(session.resume.mock.calls.length, "周期の冒頭で resume を投げていない").toBe(
      resumesBefore + 1,
    );
    expect(session.state).toBe("running");
    // ただしこの周期は鳴らさない（running を実測できたのは resume の後＝鳴らないノードを撃たない）。
    expect(session.oscillators.length, "実測できていない周期で鳴っている").toBe(perCue);

    advanceTicks(DONE_INTERVAL_TICKS); // 次の周期で回復（要件7.6）
    expect(session.oscillators.length, "次周期で鳴動が回復していない").toBe(perCue * 2);
  });

  it("ある周期の再生失敗を握り潰し、次の周期で鳴動を継続する（要件3.11 / 7.6）", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    mountCues(viewOf([timerAt("A", "0", BASE - 1_000)]));
    audio.fireGesture();
    const session = audio.latest();
    advanceTicks(1);
    const perCue = session.oscillators.length;
    expect(perCue).toBeGreaterThan(0);

    // なぜノード生成を投げさせるか: 実 AudioContext は closed・資源枯渇などで生成時に投げる。再生失敗を
    // 注入できる継ぎ目はここだけで、しかも Cue の途中で落ちる現実的な失敗の形でもある。
    const createOscillator = session.createOscillator.bind(session);
    let failOnce = true;
    session.createOscillator = () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("再生失敗を模す");
      }
      return createOscillator();
    };

    advanceTicks(DONE_INTERVAL_TICKS); // この周期は失敗する
    expect(session.oscillators.length, "失敗した周期でノードが残っている").toBe(perCue);

    advanceTicks(DONE_INTERVAL_TICKS); // boiled が残る限り次周期で継続する
    expect(session.oscillators.length, "失敗の次の周期で鳴動が継続していない").toBe(perCue * 2);
  });
});

describe("Audio_Session の作り直しと sampleRate（要件7.2 / 7.3 / 7.4）", () => {
  it("closed は次のジェスチャで新しい Audio_Session へ作り直される（非ジェスチャでは作らない）", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    mountCues(viewOf([timerAt("A", "0", BASE - 1_000)]));
    audio.fireGesture();
    const first = audio.latest();
    advanceTicks(1);
    const perCue = first.oscillators.length;
    expect(perCue).toBeGreaterThan(0);

    // OS が Audio_Session を破棄した状態を模す（長時間の背面滞留等）。
    first.state = "closed";

    // 非ジェスチャの評価ティックは作り直さない（生成はジェスチャ内に限る・iOS の解錠条件）。
    advanceTicks(DONE_INTERVAL_TICKS);
    expect(audio.contexts.length, "非ジェスチャで Audio_Session を作り直した").toBe(1);
    expect(first.oscillators.length, "closed な Audio_Session で鳴らしている").toBe(perCue);

    // 次のジェスチャで新しい Audio_Session を生成し、同じジェスチャ内の resume で running へ（要件7.2 / 7.3）。
    audio.fireGesture();
    expect(audio.contexts.length).toBe(2);
    const second = audio.latest();
    expect(second).not.toBe(first);
    expect(second.state).toBe("running");

    // 以後の Done は新しい Audio_Session で鳴り、古い方は二度と使われない。
    advanceTicks(DONE_INTERVAL_TICKS);
    expect(second.oscillators.length, "新しい Audio_Session で鳴っていない").toBe(perCue);
    expect(first.oscillators.length).toBe(perCue);
  });

  it("resume の失敗（reject）では Audio_Session を捨てず、次の機会の resume で同一 Audio_Session が回復する", () => {
    // 現行実装が捨てて作り直すのは state === "closed" のときだけである（冒頭注記のズレ）。
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "reject" });
    mountCues(viewOf([timerAt("A", "0", BASE - 1_000)]));
    audio.fireGesture();
    const session = audio.latest();
    expect(session.state).toBe("suspended");

    advanceTicks(DONE_INTERVAL_TICKS * 2 + 1); // 周期ごとに resume を投げ続ける（鳴らない）
    expect(session.resume.mock.calls.length, "周期が回復の機会になっていない").toBeGreaterThan(1);
    expect(session.oscillators.length, "reject のまま鳴っている").toBe(0);
    expect(session.close, "reject で Audio_Session を捨てている").not.toHaveBeenCalled();
    expect(audio.contexts.length, "reject で Audio_Session を作り直している").toBe(1);

    // resume が通るようになれば、同じ Audio_Session が回復して鳴り始める（作り直しは要らない）。
    session.resumeOutcome = "running";
    audio.fireGesture();
    expect(session.state).toBe("running");
    advanceTicks(DONE_INTERVAL_TICKS);
    expect(session.oscillators.length, "resume 回復後も鳴らない").toBeGreaterThan(0);
    expect(audio.contexts.length).toBe(1);
  });

  it("sampleRate 48000 のデバイスでも解錠が成立し、実装は sampleRate を読み書きしない（要件7.4）", () => {
    const audio = installAudio({
      initialState: "suspended",
      resumeOutcome: "running",
      sampleRate: 48_000,
    });
    mountCues(viewOf([timerAt("A", "0", BASE - 1_000)]));
    audio.fireGesture();
    const session = audio.latest();

    // 「干渉しない」を読み書きの回数で見る。特定値を正常とみなして弾く実装なら、必ず一度は覗く。
    let rate = session.sampleRate;
    let reads = 0;
    let writes = 0;
    Object.defineProperty(session, "sampleRate", {
      configurable: true,
      get: (): number => {
        reads++;
        return rate;
      },
      set: (value: number): void => {
        writes++;
        rate = value;
      },
    });

    advanceTicks(1);
    expect(session.state).toBe("running");
    expect(session.oscillators.length, "48000 のデバイスで鳴っていない").toBeGreaterThan(0);
    expect(reads, "実装が sampleRate を覗いている").toBe(0);
    expect(writes, "実装が sampleRate を書き換えている").toBe(0);
    expect(rate).toBe(48_000);
  });
});

describe("可視復帰（要件5.1 / 5.2 / 5.3 / 5.9）", () => {
  it("非可視中は鳴らずに劣化し、可視復帰で resume を試みて Done_Cue の周期を再開する", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    mountCues(viewOf([timerAt("A", "0", BASE - 1_000)])); // 既に boiled
    audio.fireGesture();
    const session = audio.latest();
    advanceTicks(1);
    const perCue = session.oscillators.length;
    expect(perCue).toBeGreaterThan(0);

    // Wake_Lock 不在の環境（偽の音声環境は wakeLock を持たない）。音声の回復は Wake_Lock に依らず、
    // 可視復帰時の再評価だけで成立する（要件5.9）。
    const wakeLock = (globalThis as { navigator?: { wakeLock?: unknown } }).navigator?.wakeLock;
    expect(wakeLock, "偽環境に Wake_Lock が現れている（前提が崩れている）").toBeUndefined();

    // 背面化。OS が Audio_Session を止め、背面のあいだは resume も効かない（iOS）。
    audio.becomeHidden();
    session.state = "suspended";
    session.resumeOutcome = "stay";
    const resumesBefore = session.resume.mock.calls.length;

    // throttle 下でも走った 1 ティック。再生条件は成立しているが、例外もクラッシュも起こさず鳴らさない（要件5.1）。
    expect(() => advanceTicks(DONE_INTERVAL_TICKS)).not.toThrow();
    expect(session.oscillators.length, "非可視中に鳴っている").toBe(perCue);
    expect(session.resume.mock.calls.length, "非可視中に回復を試みていない").toBeGreaterThan(
      resumesBefore,
    );

    // 前面復帰。ティックが止まっていたあいだ壁時計だけが進み、周期は既に到来している。
    session.resumeOutcome = "running";
    advanceClockOnly(6_000);
    audio.becomeVisible();

    // 可視化の検知と同時（1000ms を待たず）に resume を試み、boiled 残存ゆえ Done_Cue を再開する（要件5.2）。
    expect(session.state).toBe("running");
    expect(session.oscillators.length, "可視復帰で Done_Cue が再開していない").toBe(perCue * 2);

    // 再開後も件数に比例せず 5 秒周期のまま（可視復帰が周期を二重化しない）。
    advanceTicks(DONE_INTERVAL_TICKS - 1);
    expect(session.oscillators.length).toBe(perCue * 2);
    advanceTicks(1);
    expect(session.oscillators.length).toBe(perCue * 3);
  });

  it("boiled が 1 つも無ければ可視復帰で鳴らさない（要件5.3）", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    // 走行中のみ（残り 10 分＝閾値の外）。boiled は存在せず Pre_Alert の資格も立たない。
    mountCues(viewOf([timerAt("A", "0", BASE + 600_000)]));
    audio.fireGesture();
    const session = audio.latest();

    advanceTicks(2);
    audio.becomeHidden();
    advanceClockOnly(30_000); // 背面のあいだ壁時計だけが大きく進む
    audio.becomeVisible();

    expect(session.oscillators.length, "boiled が無いのに鳴っている").toBe(0);
    advanceTicks(DONE_INTERVAL_TICKS * 2);
    expect(session.oscillators.length).toBe(0);
  });
});

describe("評価ティックの粗さ（要件2.9 / 3.3 / 5.5）", () => {
  it("評価ティックは 1 本で、間隔はちょうど 1000ms（≤1000ms の上限）である（要件5.5）", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    mountCues(viewOf([timerAt("A", "0", BASE - 1_000)])); // 既に boiled ＝ 最初の評価で必ず鳴る条件
    audio.fireGesture();
    const session = audio.latest();

    // 評価ティックはただ 1 本。解錠・可視復帰・自己回復のいずれも別ループを持たない。
    expect(vi.getTimerCount(), "評価ティックが 1 本でない").toBe(1);

    // 境界の 1ms で間隔を挟み込む。1000ms 未満では未評価、1000ms 到達で評価済み——これが成り立つのは
    // 間隔がちょうど 1000ms のときだけであり、1000ms より粗い実装（1500ms 等）はここで落ちる。
    advanceMs(TICK_MS - 1);
    expect(session.oscillators.length, "1000ms 未満で評価が走っている").toBe(0);
    advanceMs(1);
    expect(session.oscillators.length, "1000ms 経過時点で評価が済んでいない").toBeGreaterThan(0);
  });

  it("boiled が未存在から存在へ遷移してから 1 秒以内に最初の Done_Cue を鳴らす（要件3.3）", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    // 2.5 秒後に茹で上がる Timer。boiled は「未存在→存在」へ遷移する（遷移は 2500ms の時点）。
    mountCues(viewOf([timerAt("A", "0", BASE + 2_500)]));
    audio.fireGesture();
    const session = audio.latest();

    advanceTicks(2); // 残り 500ms。まだ走行中ゆえ鳴らない。
    expect(session.oscillators.length, "走行中に Done_Cue が鳴っている").toBe(0);

    advanceTicks(1); // 遷移から 500ms 後のティックで最初の Done（1 秒以内）。
    expect(session.oscillators.length, "boiled 出現から 1 秒以内に鳴っていない").toBeGreaterThan(0);
  });

  it("閾値クロスから 1 秒以内に Pre_Alert_Cue の可否を判定し、一度きり鳴らす（要件2.9）", () => {
    const audio = installAudio({ initialState: "suspended", resumeOutcome: "running" });
    // 残り 62.5 秒。閾値（60 秒）クロスは 2500ms の時点に起きる。
    mountCues(viewOf([timerAt("A", "0", BASE + 62_500)]));
    audio.fireGesture();
    const session = audio.latest();

    advanceTicks(2); // 残り 61.5 秒 → 60.5 秒。いずれも閾値超ゆえ鳴らない（armed のまま）。
    expect(session.oscillators.length, "閾値超で Pre_Alert が鳴っている").toBe(0);

    advanceTicks(1); // 残り 59.5 秒。クロスから 500ms 後の判定で 1 回鳴る。
    const perCue = session.oscillators.length;
    expect(perCue, "閾値クロスから 1 秒以内に Pre_Alert が鳴っていない").toBeGreaterThan(0);

    advanceTicks(3); // once-only。以後の判定では二度と鳴らない。
    expect(session.oscillators.length, "Pre_Alert が二度鳴っている").toBe(perCue);
  });
});
