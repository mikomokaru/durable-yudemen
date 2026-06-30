// client/components/DebugAudioProbe.tsx — iOS 実機の音声解錠を切り分けるための一時診断オーバーレイ。
//
// useAudioCues を一切通さず、独立した AudioContext で「素のジェスチャ → resume → 可聴トーン」だけを試す。
// これにより「この端末は素のジェスチャから Web Audio で音を出せるか」を純粋に切り分ける。
// ?audiodebug=1 のときだけ描画する。原因切り分け後に撤去する（本番ユーザーには影響しない）。

import { useRef, useState } from "react";

type AudioContextConstructor = new () => AudioContext;

function resolveCtor(): AudioContextConstructor | undefined {
  const w = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return w.AudioContext ?? w.webkitAudioContext;
}

/** ?audiodebug=1 のときだけ表示する診断パネル。TEST ボタンのタップで解錠＋可聴ビープを試し、経過を画面に出す。 */
export function DebugAudioProbe() {
  const enabled =
    typeof location !== "undefined" && new URLSearchParams(location.search).has("audiodebug");
  const ctxRef = useRef<AudioContext | null>(null);
  const [lines, setLines] = useState<readonly string[]>([]);

  if (!enabled) return null;

  const log = (msg: string) => setLines((prev) => [...prev.slice(-12), `${new Date().toISOString().slice(11, 23)} ${msg}`]);

  // 可聴トーン（880Hz・0.3s・はっきり聞こえる音量）。useAudioCues の audioTone とは独立。
  const beep = (ctx: AudioContext) => {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
      osc.onended = null;
      log("beep onended (playback finished)");
    };
    osc.start(t);
    osc.stop(t + 0.3);
  };

  const onTest = () => {
    try {
      const Ctor = resolveCtor();
      if (Ctor === undefined) {
        log("AudioContext unsupported");
        return;
      }
      if (ctxRef.current === null) {
        ctxRef.current = new Ctor();
        log(`created state=${ctxRef.current.state} rate=${ctxRef.current.sampleRate}`);
        ctxRef.current.onstatechange = () => log(`statechange -> ${ctxRef.current?.state}`);
      }
      const ctx = ctxRef.current;
      log(`tap: state=${ctx.state}`);
      // ジェスチャ内で resume と可聴トーンの両方を試す（resume だけで足りない iOS 版への保険）。
      void ctx
        .resume()
        .then(() => log(`resume resolved -> ${ctx.state}`))
        .catch((e) => log(`resume rejected: ${String(e)}`));
      beep(ctx);
      log(`beep() called (state at call=${ctx.state})`);
    } catch (e) {
      log(`exception: ${String(e)}`);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        left: 8,
        bottom: 8,
        zIndex: 9999,
        width: "min(92vw, 420px)",
        background: "rgba(0,0,0,.85)",
        color: "#0f0",
        font: "11px/1.35 ui-monospace, monospace",
        padding: 10,
        borderRadius: 8,
        border: "1px solid #0f0",
      }}
    >
      <button
        type="button"
        onClick={onTest}
        style={{
          width: "100%",
          padding: "12px",
          fontSize: 16,
          fontWeight: 700,
          background: "#0a0",
          color: "#000",
          border: "none",
          borderRadius: 6,
          marginBottom: 8,
        }}
      >
        🔊 TEST BEEP (tap)
      </button>
      <div>
        {lines.length === 0 ? (
          "(tap to see the trace)"
        ) : (
          // oxlint-disable-next-line react/no-array-index-key
          lines.map((l, i) => <div key={i}>{l}</div>)
        )}
      </div>
    </div>
  );
}
