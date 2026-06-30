// client/components/audioTone.ts — 3 種の合成 Cue を「鳴らす」だけの端の作用。
//
// 音声経路は AudioContext（Web Audio）の単一経路に一本化する（design.md 骨格1）。外部音源ファイル・
// <audio> 要素・アセット読み込みは持たず、OscillatorNode + GainNode のエンベロープで音を合成する。
// これにより warm-up（解錠）と同じ経路で全 Cue が鳴り、二つの音声経路がズレる余地を構造的に消す。
//
// 各 Cue は「ノート列（CueShape）」である。単発音は 1 ノート、複数音（上昇予告・チャイム）は時間差を
// 持つ複数ノートとして表現する。再生は各ノートを AudioContext のスケジューラへ一括予約するだけで、
// JS タイマーによる逐次発火は用いない（バックグラウンド throttle の影響を受けず、ノート間隔が崩れない）。
//
// 本モジュールは「鳴らす」作用に閉じる。AudioContext のライフサイクル（生成・解錠・resume・破棄）の
// 所有は呼び出し側（useAudioCues＝タスク3.3）の責務であり、ここでは渡された ctx 上で鳴らすだけ。
// 「鳴らすか否か」の判定は純粋層（audioCue.ts）が持ち、本モジュールは判定結果を受けて世界（音）を変える。
//
// best-effort（design.md 骨格8・Error Handling 表）: いかなる再生失敗もユーザー操作・Timer 進行・
// 視覚正本を妨げない。失敗は内部で握り潰し、例外を呼び出し側へ波及させない。

/** 1 ノートの音色。周波数・波形・長さ・ピーク音量に、開始オフセットと任意の装飾を加えて定める。 */
interface Note {
  /** 基本周波数（Hz）。 */
  readonly frequency: number;
  /** 波形。sine は柔らかく、triangle は適度な倍音で芯があり、square は角があり強い。 */
  readonly type: OscillatorType;
  /** 再生長（ミリ秒）。 */
  readonly durationMs: number;
  /** エンベロープのピーク音量（0〜1）。耳に痛くない控えめな値に保つ。 */
  readonly peakGain: number;
  /** Cue 先頭からの開始オフセット（ミリ秒）。複数ノートを時間差で重ねるために用いる。既定 0。 */
  readonly atMs?: number;
  /** 指定時、durationMs かけて frequency からこの周波数へ指数グライドする（ピッチの動き）。 */
  readonly glideToHz?: number;
  /** 立ち上がり時間（ミリ秒）。短いほどアタックが鋭い。既定 6ms。 */
  readonly attackMs?: number;
  /** true のとき 1 オクターブ上の倍音を弱く重ね、ベル/チャイム的な艶を与える。 */
  readonly octaveLayer?: boolean;
}

/** Cue の音色＝1 つ以上のノート列。単発音は 1 要素、複数音は時間差を持つ複数要素で表す。 */
type CueShape = readonly Note[];

// ─── Touch_Cue 連打エスカレーション（演出であって状態ではない）───────────────────
//
// 素早い連続タップで Touch_Cue のピッチを 1 段ずつ上げ、「積み重なっている」感触を音で返す
// （券売機の連打感）。これは UI フィードバックの装飾にすぎず、サーバ状態・純粋層・ワイヤ表現には
// 一切触れない。直近タップ時刻と段数という揮発的なローカル変数のみで成立させ、状態へ昇格させない
// （設計哲学「導出値を状態に昇格させない」）。段数は音を鳴らした副作用として進むだけで、誰も読み戻さない。
const TOUCH_ESCALATION_SEMITONES = 1.5; // 1 段あたりの上昇幅（半音）。
const TOUCH_ESCALATION_WINDOW_MS = 1200; // この間隔以内の連続タップを「連打」とみなす。超えると基準へ戻す。
const TOUCH_ESCALATION_MAX_STEP = 7;    // 上限段。耳が痛くなる音域までは上げない頭打ち。
const SEMITONE_RATIO = Math.pow(2, 1 / 12); // 等比 1 半音＝周波数比 2^(1/12)。

let touchStep = 0;       // 現在の連打段（0＝基準）。鳴らすたびに進み、間が空くと 0 へ戻る揮発値。
let lastTouchAt = 0;     // 直近 Touch_Cue の発火時刻（performance.now ミリ秒）。連打判定にのみ使う。

/**
 * 今回の Touch_Cue のピッチ倍率を求めつつ連打段を更新する（純粋でない＝モジュール内の揮発状態を進める）。
 * 前回タップから WINDOW_MS 以内なら段を 1 つ上げ（MAX_STEP で頭打ち）、超えていれば 0 へリセットする。
 */
function nextTouchPitchMultiplier(): number {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  touchStep = now - lastTouchAt <= TOUCH_ESCALATION_WINDOW_MS
    ? Math.min(touchStep + 1, TOUCH_ESCALATION_MAX_STEP)
    : 0;
  lastTouchAt = now;
  return Math.pow(SEMITONE_RATIO, TOUCH_ESCALATION_SEMITONES * touchStep);
}

// 各 Cue の音色。具体的な周波数・長さは design.md「合成トーン」節の調整事項。
// 3 種を音色で明確に区別する——Touch（撥弦的な極短クリック）/ Pre_Alert（上昇する単発予告）/
// Done（上昇 3 音の反復しやすいチャイム）。Pre_Alert と Done は音色・構成を別物にして混同を防ぐ。

/** Touch_Cue — 高音の撥(はじ)きに胴鳴りを重ねた極短クリック。合成っぽさを抑え、押した触感を与える。 */
const TOUCH_CUE: CueShape = [
  { frequency: 2100, type: "triangle", durationMs: 22, peakGain: 0.10, attackMs: 2 },
  { frequency: 1320, type: "sine", durationMs: 50, peakGain: 0.13 },
];

/** Pre_Alert_Cue — 660→988 の上昇 2 音。triangle で抜けを出し、Done に埋もれない音量に上げる（上昇形で予告）。 */
const PRE_ALERT_CUE: CueShape = [
  { frequency: 660, type: "triangle", durationMs: 150, peakGain: 0.3 },
  { frequency: 988, type: "triangle", durationMs: 240, peakGain: 0.34, atMs: 130, octaveLayer: true },
];

/** Done_Cue — ソ・シ・ミ（784/988/1319）の上昇 3 音＋倍音のチャイム。鐘のように識別しやすく反復に強い。 */
const DONE_CUE: CueShape = [
  { frequency: 784, type: "triangle", durationMs: 500, peakGain: 0.17, octaveLayer: true },
  { frequency: 988, type: "triangle", durationMs: 500, peakGain: 0.17, atMs: 150, octaveLayer: true },
  { frequency: 1319, type: "triangle", durationMs: 600, peakGain: 0.16, atMs: 300, octaveLayer: true },
];

/**
 * 1 つの発振ノードを、指定の開始時刻・音色・エンベロープで鳴らす。
 *
 * ノートごと（発振ごと）に新しい OscillatorNode + GainNode を生成する——OscillatorNode は一度きりで、
 * finished なノードへ再 start すると InvalidStateError になるため、再利用せず毎回作り直す（design.md
 * 「再生終了ノードの後始末」節）。再生終了（onended）で disconnect し参照を解放、onended を null 化して
 * 生きた実行資源を端に抱え込まない（メモリリークと再 start 例外の構造的防止・要件3.11）。
 */
function scheduleOscillator(
  ctx: AudioContext,
  startAt: number,
  frequency: number,
  type: OscillatorType,
  durationSec: number,
  peakGain: number,
  attackSec: number,
  glideToHz?: number,
): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startAt);
  // ピッチの動き: 指定時は duration かけて目標周波数へ指数グライドさせる。
  if (glideToHz) oscillator.frequency.exponentialRampToValueAtTime(glideToHz, startAt + durationSec);

  // エンベロープ: 短いアタックでピークへ、その後ほぼゼロへ指数減衰させる。
  // 立ち上がり/立ち下がりを滑らかにすることでブツッというクリックノイズを避ける。
  // exponentialRampToValueAtTime は 0 を目標にできないため十分小さい値へ落とす。
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peakGain, startAt + attackSec);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSec);

  oscillator.connect(gain);
  gain.connect(ctx.destination);

  oscillator.onended = () => {
    // 後始末の規律: 再生終了ごとに disconnect し参照を切る。finished ノードへは再 start しない。
    oscillator.disconnect();
    gain.disconnect();
    oscillator.onended = null;
  };

  oscillator.start(startAt);
  oscillator.stop(startAt + durationSec);
}

/**
 * Cue（ノート列）を渡された AudioContext 上で 1 回鳴らす。
 *
 * 各ノートを atMs のオフセットで AudioContext の時間軸へ一括予約する。JS タイマーで逐次発火しないため、
 * バックグラウンド throttle に晒されてもノート間隔（上昇音/チャイムの timing）が崩れない。
 * octaveLayer 指定のノートには 1 オクターブ上の弱い倍音を重ね、ベル的な艶を加える。
 * pitchMultiplier は全ノートの周波数（とグライド先）に一律で掛かり、Cue の音色比率を保ったまま移調する。
 */
function playCue(ctx: AudioContext, cue: CueShape, pitchMultiplier = 1): void {
  try {
    const base = ctx.currentTime;
    for (const note of cue) {
      const startAt = base + (note.atMs ?? 0) / 1000;
      const durationSec = note.durationMs / 1000;
      const attackSec = (note.attackMs ?? 6) / 1000;
      const frequency = note.frequency * pitchMultiplier;
      const glideToHz = note.glideToHz ? note.glideToHz * pitchMultiplier : undefined;

      scheduleOscillator(
        ctx, startAt, frequency, note.type, durationSec, note.peakGain, attackSec, glideToHz,
      );

      // 倍音レイヤー: 1 オクターブ上を弱く・やや短く重ねて、芯のある艶を与える（チャイム/ベル系）。
      if (note.octaveLayer) {
        scheduleOscillator(
          ctx, startAt, frequency * 2, "sine", durationSec * 0.8, note.peakGain * 0.28, attackSec,
        );
      }
    }
  } catch {
    // best-effort: 再生失敗は握り潰す。視覚正本（boiled 表示・カウントダウン）は不変。
  }
}

/**
 * Touch_Cue — 指定 UI 操作の受理を知らせる撥弦的な極短クリック。
 * 素早い連打では 1 段ずつピッチが上がり（上限あり）、間が空けば基準へ戻る（連打の積み重ね感）。
 */
export function playTouchTone(ctx: AudioContext): void {
  playCue(ctx, TOUCH_CUE, nextTouchPitchMultiplier());
}

/** Pre_Alert_Cue — 茹で上がり 1 分前の上昇 2 音による予告。 */
export function playPreAlertTone(ctx: AudioContext): void {
  playCue(ctx, PRE_ALERT_CUE);
}

/** Done_Cue — boiled が残る限り反復する上昇 3 音のチャイム（反復は呼び出し側の周期が担う）。 */
export function playDoneTone(ctx: AudioContext): void {
  playCue(ctx, DONE_CUE);
}
