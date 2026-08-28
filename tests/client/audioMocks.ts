// tests/client/audioMocks.ts — 音声キューの端（useAudioCues / audioTone）を据え付けるための偽の音声環境。
//
// **なぜ手製の偽物か:** 本リポジトリは jsdom / happy-dom を入れていない（assignment-ui.example.test.ts の
// 注記）。workerd・node のいずれの pool でも `window` / `document` / `AudioContext` は存在しないため、
// 実装が実際に触る面だけを持つ最小の偽物を `globalThis` へ差し込む（persistence-scope.property.test.ts の
// MemoryStorage と同じ据え付け）。差し込みは可逆で、`uninstall()` が元の globals を戻す。
//
// **写した面（実装が触る呼び出しの正本・これ以外は持たない）:**
//   - `window.AudioContext` / `window.webkitAudioContext` — useAudioCues.ts:62-68（resolveAudioContextConstructor）
//   - `ctx.state` / `ctx.resume()`                        — useAudioCues.ts:129-144（readyContext）
//   - `ctx.close()`                                      — useAudioCues.ts:226（アンマウント）
//   - `ctx.createOscillator()` / `ctx.createGain()`       — audioTone.ts:109-110
//   - `ctx.currentTime` / `ctx.destination`               — audioTone.ts:147 / 124
//   - oscillator: `type` / `frequency.setValueAtTime` / `frequency.exponentialRampToValueAtTime` /
//     `connect` / `start` / `stop` / `onended` / `disconnect` — audioTone.ts:111-134
//   - gain: `gain.setValueAtTime` / `gain.exponentialRampToValueAtTime` / `connect` / `disconnect` — audioTone.ts:119-129
//   - `document.addEventListener(type, h, true)`（解錠ジェスチャ）/ `document.visibilityState` /
//     `visibilitychange` / それぞれの `removeEventListener` — useAudioCues.ts:209-221
//
// **なぜ createBuffer / createBufferSource を持たないか:** 現行実装は warm-up（無音バッファの 1 回再生）を
// 持たない。解錠は「鳴らす直前に `state` を実測し、running でなければ `resume()` を投げる」だけで成立する
// （design.md「解錠は『実測』で扱う（warm-up / onended に頼らない）」）。実装が触らない面を偽物に置くと、
// 偽物が実装より大きな嘘をつく。
//
// **なぜ sampleRate を持つのか（実装は読まないのに）:** 実装は `ctx.sampleRate` に一切干渉しない（要件7.4）。
// 偽物が持つのは、44100 でないデバイス（48000 の macOS など）でも解錠・鳴動が成立することを、環境条件として
// テストが置けるようにするためである。
//
// 利用者: tests/client/useAudioCues.example.test.ts（タスク3.6）・useAudioCues.integration.test.ts（タスク3.7）

import { vi } from "vitest";

// ── Audio_Session の状態と resume の帰結 ─────────────────────────────────────────────────────

/**
 * Audio_Session の状態（要件の用語・design.md「Audio_Session の状態」）。
 * DOM の `AudioContextState` には無い `interrupted`（iOS の着信等による中断）を含むため自前で定義する。
 */
export type AudioSessionState = "suspended" | "running" | "interrupted" | "closed";

/**
 * `resume()` の帰結。iOS 実機で観測された 4 通りを名前で区別する（design.md「resume が効かない / closed」）。
 *   - `running` — resolve し running へ上がる（ジェスチャ内 resume の成功＝解錠成立）。
 *   - `stay`    — resolve するが状態は変わらない（resume が効かない）。
 *   - `reject`  — `InvalidStateError` 相当で reject する。
 *   - `hang`    — 永久に settle しない（iOS で観測されたハング）。
 */
export type ResumeOutcome = "running" | "stay" | "reject" | "hang";

/** 解錠ジェスチャの待受イベント（useAudioCues.ts の UNLOCK_EVENTS と同じ 4 種）。 */
export type GestureKind = "touchstart" | "touchend" | "click" | "keydown";

/** 生成される Audio_Session 1 つ分の初期条件（install の options から既定を埋めて確定させた形）。 */
interface SessionSettings {
  readonly state: AudioSessionState;
  readonly resumeOutcome: ResumeOutcome;
  readonly sampleRate: number;
  readonly currentTime: number;
}

// ── ノード（AudioParam / Oscillator / Gain）── 観測はすべてスパイで行う ──────────────────────

/** `setValueAtTime` / `exponentialRampToValueAtTime` だけを持つ偽 AudioParam（エンベロープの観測口）。 */
export class FakeAudioParam {
  readonly setValueAtTime = vi.fn<(value: number, at: number) => void>();
  readonly exponentialRampToValueAtTime = vi.fn<(value: number, at: number) => void>();
}

/** 偽 OscillatorNode。1 ノート 1 個生成される（実装は finished ノードを再利用しない）。 */
export class FakeOscillator {
  type: OscillatorType = "sine";
  readonly frequency = new FakeAudioParam();
  /** 実装が後始末（disconnect・null 化）を仕込む口。`finish()` で発火させて後始末を観測する。 */
  onended: (() => void) | null = null;
  readonly connect = vi.fn<(destination: unknown) => void>();
  readonly disconnect = vi.fn<() => void>();
  readonly start = vi.fn<(at: number) => void>();
  readonly stop = vi.fn<(at: number) => void>();

  /**
   * 再生終了を模して `onended` を呼ぶ。
   * なぜ必要か: 後始末の規律（`disconnect` して `onended` を null 化・要件3.11）は、終了を起こさない限り
   * 観測できない。実 AudioContext の時間進行を待たずに終了だけを与える。
   */
  finish(): void {
    this.onended?.();
  }
}

/** 偽 GainNode。エンベロープの `gain` と接続の観測口だけを持つ。 */
export class FakeGain {
  readonly gain = new FakeAudioParam();
  readonly connect = vi.fn<(destination: unknown) => void>();
  readonly disconnect = vi.fn<() => void>();
}

// ── Audio_Session（偽 AudioContext）─────────────────────────────────────────────────────────

/**
 * 偽 AudioContext。状態・レート・時刻・resume の帰結をすべて可変フィールドで持つ。
 *
 * なぜ可変フィールドか: 実装は「鳴らす直前に `state` を実測する」設計ゆえ、テスト側は評価の合間に
 * suspended / interrupted / closed へ動かして自己回復を観測する必要がある。setter を被せても同じ操作を
 * 遠回りに書くだけで、観測は増えない。
 */
export class FakeAudioContext {
  state: AudioSessionState;
  sampleRate: number;
  currentTime: number;
  /** `resume()` の帰結。テスト途中で差し替えて中断・恒久失敗・回復を作る。 */
  resumeOutcome: ResumeOutcome;
  /** 接続先の同一性を見るための識別だけ持つ終端（gain.connect の引数として現れる）。 */
  readonly destination = { node: "destination" } as unknown as AudioNode;
  /** 生成されたノードの履歴（Cue ごとに新ノードが積まれる＝滞留と再 start の不在を数で見る）。 */
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];

  readonly resume = vi.fn((): Promise<void> => {
    switch (this.resumeOutcome) {
      case "running":
        this.state = "running";
        return Promise.resolve();
      case "stay":
        return Promise.resolve();
      case "reject":
        return Promise.reject(new Error("InvalidStateError"));
      case "hang":
        return new Promise<void>(() => {}); // 永久に settle しない
    }
  });

  readonly close = vi.fn((): Promise<void> => {
    this.state = "closed";
    return Promise.resolve();
  });

  constructor(settings: SessionSettings) {
    this.state = settings.state;
    this.resumeOutcome = settings.resumeOutcome;
    this.sampleRate = settings.sampleRate;
    this.currentTime = settings.currentTime;
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
}

// ── 偽 document（capture フェーズの待受と visibilitychange）───────────────────────────────────

/** 1 回の addEventListener を写した記録（type と listener と capture フェーズの三つ組）。 */
interface Listening {
  readonly type: string;
  readonly listener: (event: Event) => void;
  readonly capture: boolean;
}

/**
 * 偽 document。`addEventListener` / `removeEventListener` / `visibilityState` だけを持つ。
 * capture フラグまで記録するのは、解錠ジェスチャを capture フェーズで張る規律（要件4.2）を観測できる
 * ようにするためである。解除は DOM と同じく type + listener + capture の一致で 1 件だけ外す。
 */
class FakeDocument {
  visibilityState: DocumentVisibilityState = "visible";
  readonly listenings: Listening[] = [];

  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const capture = options === true || (typeof options === "object" && options.capture === true);
    this.listenings.push({ type, listener, capture });
  }

  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    const capture = options === true || (typeof options === "object" && options.capture === true);
    const index = this.listenings.findIndex(
      (l) => l.type === type && l.listener === listener && l.capture === capture,
    );
    if (index >= 0) this.listenings.splice(index, 1);
  }

  /** 登録順に発火する。発火中の登録・解除に巻き込まれないよう複製を回す。 */
  fire(type: string): void {
    for (const listening of [...this.listenings]) {
      if (listening.type === type) listening.listener({ type } as Event);
    }
  }
}

// ── 据え付け（差し込みと復元）─────────────────────────────────────────────────────────────────

/** 偽の音声環境の初期条件。すべて省略可（既定は iOS PWA の初期状態＝未解錠の suspended）。 */
export interface FakeAudioOptions {
  /**
   * `window` へ出す音声出力 API。
   *   - `standard`（既定）— `AudioContext` を出す。
   *   - `webkit` — `webkitAudioContext` だけを出す（古い iOS）。
   *   - `absent` — どちらも出さない＝音声出力 API 非提供（要件4.5）。
   */
  readonly expose?: "standard" | "webkit" | "absent";
  /** 生成直後の状態。既定 `suspended`（ジェスチャ内 resume を要する iOS の初期状態）。 */
  readonly initialState?: AudioSessionState;
  /** 生成される各 Audio_Session の `resume()` の帰結。既定 `running`（解錠成立）。 */
  readonly resumeOutcome?: ResumeOutcome;
  /** `sampleRate`。既定 44100（iOS の典型値）。48000 等を渡してデバイス差を置ける（要件7.4）。 */
  readonly sampleRate?: number;
  /** `currentTime` の初期値（秒）。既定 0。 */
  readonly currentTime?: number;
  /** 初期の可視状態。既定 `visible`。 */
  readonly visibilityState?: DocumentVisibilityState;
}

/** 差し込んだ偽の音声環境を操る口。 */
export interface FakeAudio {
  /** 生成された Audio_Session の全履歴（closed からの作り直しを件数と参照で追える）。 */
  readonly contexts: readonly FakeAudioContext[];
  /** 直近の Audio_Session。未生成なら明示的に失敗する。 */
  latest(): FakeAudioContext;
  /** 解錠ジェスチャを 1 回起こす（既定 `touchstart`）。capture / bubble 双方の待受へ届く。 */
  fireGesture(kind?: GestureKind): void;
  /** 可視へ復帰させ `visibilitychange` を起こす（要件5.2 / 5.3）。 */
  becomeVisible(): void;
  /** 非可視へ退避させ `visibilitychange` を起こす（実装は非可視では何もしない）。 */
  becomeHidden(): void;
  /** 指定イベントの待受数。capture を渡すとフェーズ一致のものだけ数える（要件4.2・解除の完全性）。 */
  listenerCount(type: string, capture?: boolean): number;
  /** 差し込んだ globals を元へ戻す（テスト間へ漏らさない）。 */
  uninstall(): void;
}

/**
 * 偽の音声環境（`window.AudioContext` と `document`）を `globalThis` へ差し込む。
 *
 * 呼び出し側は必ず `uninstall()` で戻す（`afterEach` 等）。差し込み前の値は退避しており、元から
 * 無かったものは削除して復元する——グローバルを跨いで漏らさないための可逆性がこのヘルパの要件である。
 */
export function installFakeAudio(options?: FakeAudioOptions): FakeAudio {
  const settings: SessionSettings = {
    state: options?.initialState ?? "suspended",
    resumeOutcome: options?.resumeOutcome ?? "running",
    sampleRate: options?.sampleRate ?? 44_100,
    currentTime: options?.currentTime ?? 0,
  };

  const contexts: FakeAudioContext[] = [];
  /** 生成のたびに履歴へ積む。実装は `new Ctor()` で作るため、記録は構築子の側に置く。 */
  class TrackedSession extends FakeAudioContext {
    constructor() {
      super(settings);
      contexts.push(this);
    }
  }

  const fakeDocument = new FakeDocument();
  fakeDocument.visibilityState = options?.visibilityState ?? "visible";

  const expose = options?.expose ?? "standard";
  const fakeWindow: Record<string, unknown> = {};
  if (expose === "standard") fakeWindow.AudioContext = TrackedSession;
  if (expose === "webkit") fakeWindow.webkitAudioContext = TrackedSession;

  const globals = globalThis as unknown as Record<string, unknown>;
  const hadWindow = "window" in globals;
  const priorWindow = globals.window;
  const hadDocument = "document" in globals;
  const priorDocument = globals.document;
  globals.window = fakeWindow;
  globals.document = fakeDocument;

  return {
    contexts,
    latest: (): FakeAudioContext => {
      const last = contexts[contexts.length - 1];
      if (last === undefined) throw new Error("Audio_Session がまだ生成されていない");
      return last;
    },
    fireGesture: (kind: GestureKind = "touchstart") => fakeDocument.fire(kind),
    becomeVisible: () => {
      fakeDocument.visibilityState = "visible";
      fakeDocument.fire("visibilitychange");
    },
    becomeHidden: () => {
      fakeDocument.visibilityState = "hidden";
      fakeDocument.fire("visibilitychange");
    },
    listenerCount: (type: string, capture?: boolean): number =>
      fakeDocument.listenings.filter(
        (l) => l.type === type && (capture === undefined || l.capture === capture),
      ).length,
    uninstall: () => {
      fakeDocument.listenings.length = 0;
      if (hadWindow) globals.window = priorWindow;
      else delete globals.window;
      if (hadDocument) globals.document = priorDocument;
      else delete globals.document;
    },
  };
}
