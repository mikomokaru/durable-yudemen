// client/components/useAudioCues.ts — 音声キュー機構を担う端の作用フック。
//
// 音声経路は AudioContext（Web Audio）の単一経路に一本化する（design.md 骨格1）。AudioContext の
// ライフサイクルを所有する唯一の場所であり、「鳴らすか否か」の判定は純粋層（audioCue.ts）が持ち、
// 本フックは判定結果を受けて世界（音）を変えるだけ——計算と作用の分離をクライアントへ徹底する。
//
// 設計の芯（このファイルの全体を貫く一本の原則）:
//   「鳴らせるか」は保持しない。鳴らす直前に readyContext() が AudioContext の今を読むだけ。
//   解錠済みフラグのような“状態の写し”を持たない（それは ctx.state の導出値にすぎず、二つの真実を生む）。
//   Cue は 2 つの性質に分かれる:
//     - イベント型（Touch / Pre_Alert）: エッジ駆動。起きた瞬間に撃ち、結果は持たず捨てる（撃ちっぱなし）。
//     - 状態型（Done）              : レベル駆動。純粋述語 boiled が在る間、5 秒ペースで鳴らし続ける持続アラーム。
//   どの Cue も readyContext() を通る。running でなければ resume を投げて今回は pop 破棄（鳴らないノードを
//   撃たないのでメモリにも漏れない）。running を実測できたときだけ鳴らす。resume はこの emit に内包され、
//   ジェスチャ・Done 周期・可視復帰のたびに自然に叩かれる＝自己回復が管理コードなしで成立する。
//
// 本フックが抱える可変は AudioContext（実行資源）と、PreAlertWatch（Pre_Alert のエッジ検出位相）・
// lastRingAt（Done の 5 秒ペース）だけ。後二者は「鳴ったか」ではなく時間からの導出に要る最小の記憶であり、
// いずれも SSOT（ClientView / サーバ / 永続）へ書き戻さない（要件3.9/4.7/5.4/7.7/7.10）。

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ClientView } from "../connection";
import { assignedTimers } from "../assignment";
import {
  advancePreAlert,
  boiledTimerIds,
  dueDoneCue,
  EMPTY_PRE_ALERT_WATCH,
  type PreAlertWatch,
} from "../audioCue";
import { assignedSlotDisplays } from "./slotDisplay";
import { playDoneTone, playPreAlertTone, playTouchTone } from "./audioTone";

/** 音声キュー機構が UI へ提供する口。 */
export interface AudioCues {
  /** 指定された UI 操作（タップ）から呼ぶ Touch_Cue の再生口。running でなければ resume を試み no-op（best-effort・要件1）。 */
  readonly playTouchCue: () => void;
}

/** useAudioCues のオプション（時刻・ティック間隔の差し替え口）。 */
export interface AudioCuesOptions {
  /** 現在時刻の採取。既定 Date.now（remaining 導出・周期判定に用いる・テストで差し替え）。 */
  readonly now?: () => number;
  /** 評価ティック間隔（ミリ秒）。既定 1000（≤1000 を保つ・Pre_Alert を 1 秒以内に判定・要件2.9 / 3.3）。 */
  readonly tickMs?: number;
}

/** AudioContext コンストラクタの最小型（webkitAudioContext には DOM 型が無いため自前で当てる）。 */
type AudioContextConstructor = new () => AudioContext;

// sampleRate は OS / 出力デバイスが決める値で、正常値はデバイスごとに異なる（macOS は 48000、古い iOS は
// 44100 など）。特定値を「正常」と決め打ちして弾くと、その値でないデバイスを恒久的に無音化してしまう。
// 音は best-effort であり正しさの担保は視覚正本（boiled 表示・カウントダウン）ゆえ、レートには干渉しない。

/** 解錠ジェスチャの待受イベント（capture フェーズで張り、初回ジェスチャを取りこぼしにくくする）。 */
const UNLOCK_EVENTS = ["touchstart", "touchend", "click", "keydown"] as const;

/**
 * AudioContext コンストラクタを解決する。標準 AudioContext を優先し、無ければ webkitAudioContext。
 * いずれも無ければ undefined（音声出力 API 非提供＝unsupported・要件4.5）。
 */
function resolveAudioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return candidate.AudioContext ?? candidate.webkitAudioContext;
}

/**
 * 音声キュー機構をマウント中だけ動かす端のフック。
 *
 * 鳴らせるかは保持せず、鳴らす直前に readyContext() が AudioContext の今を読む:
 *   - 非対応（AudioContext 不在）       → null（何もしない・要件4.5）
 *   - 未生成                            → 生成（生成は作用だが解錠ではない）
 *   - closed（OS 破棄）                 → 捨てて作り直す
 *   - running でない（suspended 等）    → resume() を投げて null を返す（今回は pop 破棄・鳴らさない）
 *   - running                          → その ctx を返す（鳴らせる）
 * resume はジェスチャ内で叩かれて初めて iOS を解錠する。emit／onGesture／可視復帰が readyContext を通すため、
 * 解錠も中断からの回復も「別管理ループ」を持たず自然に成立する（要件4.x/5.2/7.2/7.5/7.6）。
 *
 * 評価ティック（≤ tickMs）:
 *   - Pre_Alert（イベント型）— advancePreAlert で「残り60秒を今跨いだ」timerId を検出し、各 1 回 emit（撃ち捨て・要件2.1/2.8）。
 *     PreAlertWatch は鳴否に関わらず毎ティック畳み込む（once-only エッジ検出・過去クロスを遡らない・要件2.4/2.5）。
 *   - Done（状態型）— boiled が在る間、lastRingAt で 5 秒ペースを刻んで emit。boiled が空なら lastRingAt を解除し、
 *     次の非空化で 1 秒以内に最初の一発（要件3.1/3.3/3.4）。ペースは「撃とうとした時刻」で進める（鳴否に依存しない＝撃ちっぱなし）。
 *   - 可視復帰 — visibilitychange→visible で resume を試み（readyContext）即時再評価する（要件5.2/5.3）。
 *
 * いずれの再生も best-effort。サーバ状態・状態遷移・ワイヤ表現を変えず、失敗は握り潰す（要件1.3/3.11/7.10）。
 */
export function useAudioCues(
  view: ClientView,
  units: readonly number[],
  options?: AudioCuesOptions,
): AudioCues {
  // AudioContext（実行資源）。セッション内ローカルに抱え、SSOT・永続へ書き戻さない（要件4.7/7.10）。
  const sessionRef = useRef<AudioContext | null>(null);

  // 評価ティックが最新の事実を参照するための控え。導出値は状態に昇格させず、毎評価で view（事実）と
  // units（設定）から純粋導出し直す。
  const viewRef = useRef(view);
  viewRef.current = view;
  const unitsRef = useRef(units);
  unitsRef.current = units;

  // 時刻採取・ティック間隔は差し替え口（テスト）。マウント時に 1 回だけ確定する（≤1000 を保つ・要件2.9/3.3）。
  const nowFnRef = useRef<(() => number) | null>(null);
  if (nowFnRef.current === null) nowFnRef.current = options?.now ?? (() => Date.now());
  const tickMsRef = useRef<number | null>(null);
  if (tickMsRef.current === null) tickMsRef.current = options?.tickMs ?? 1000;

  // 作用ローカルな計時/位相情報（「鳴ったか」ではなく時間からの導出に要る記憶・SSOT へ書き戻さない）。
  //   - preAlertWatchRef : Pre_Alert のエッジ検出位相（once-only・毎ティック畳み込む）。
  //   - lastRingAtRef    : 最後に Done を撃とうとした時刻。boiled 空で null へ戻す（次の非空化で即時）。
  const preAlertWatchRef = useRef<PreAlertWatch>(EMPTY_PRE_ALERT_WATCH);
  const lastRingAtRef = useRef<number | null>(null);

  // AudioContext の今を読み、鳴らせる（running な）ctx だけを返す。鳴らせる状態は保持せず毎回ライブで読む。
  // running でなければ resume() を投げて null を返す——ジェスチャ内なら解錠が成立し、そうでなければ次の機会へ。
  const readyContext = useCallback((): AudioContext | null => {
    const Ctor = resolveAudioContextConstructor();
    if (Ctor === undefined) return null; // 非対応環境（要件4.5）
    let ctx = sessionRef.current;
    if (ctx !== null && ctx.state === "closed") {
      sessionRef.current = null; // OS が破棄した closed は捨てて作り直す
      ctx = null;
    }
    if (ctx === null) {
      try {
        ctx = new Ctor();
        sessionRef.current = ctx;
      } catch {
        return null; // 生成失敗は劣化（次の機会に再試行）
      }
    }
    if (ctx.state !== "running") {
      void ctx.resume().catch(() => {}); // 投げっぱなし。ジェスチャ内なら解錠成立、違えば次の機会へ。
      return null; // 今は鳴らせない＝この回は pop 破棄（鳴らないノードを撃たない）
    }
    return ctx;
  }, []);

  // 撃ちっぱなしの再生口。running な ctx を読めたときだけ鳴らす。失敗は握り潰す（best-effort・要件1.3/3.11）。
  const emit = useCallback(
    (play: (ctx: AudioContext) => void): void => {
      const ctx = readyContext();
      if (ctx === null) return; // 未 running は pop 破棄
      try {
        play(ctx);
      } catch {
        // best-effort: 再生失敗は握り潰す。視覚正本（boiled 表示・カウントダウン）は不変。
      }
    },
    [readyContext],
  );

  useEffect(() => {
    if (resolveAudioContextConstructor() === undefined) return; // 非対応環境: リスナも張らず劣化（要件4.5）

    const nowFn = nowFnRef.current ?? (() => Date.now());
    const tickMs = tickMsRef.current ?? 1000;

    // ジェスチャは resume を叩くだけ（readyContext が生成＋resume を内包）。これが iOS の解錠点。
    // 解錠フラグを持たないので「解錠後にリスナを外す」儀式も無い。running 時は readyContext 内で resume を
    // 試みず素通りするだけなので、張りっぱなしでも安く、中断後の再タップで自然に回復する。
    const onGesture = (): void => {
      readyContext();
    };

    /**
     * 評価ティック（≤ tickMs）— now を採取し、純粋層で boiled 集合と Pre_Alert 発火群を導出して鳴らす。
     * 導出値は状態へ昇格させず、view（事実）と units（設定）と now から毎回計算し直す。
     */
    function tick(): void {
      const now = nowFn();
      const currentView = viewRef.current;
      const currentUnits = unitsRef.current;

      // Pre_Alert（イベント型）— 「今跨いだ」timerId を検出。位相は鳴否に関わらず毎ティック畳み込む（要件2.4/2.5）。
      const { fire, next } = advancePreAlert(
        preAlertWatchRef.current,
        assignedTimers(currentView.timers, currentUnits),
        currentView.offset,
        now,
      );
      preAlertWatchRef.current = next;
      for (let i = 0; i < fire.length; i++) emit(playPreAlertTone); // 撃ち捨て（各 timerId 1 回・要件2.1/2.8）

      // Done（状態型）— boiled が在る間、5 秒ペースで鳴らし続ける持続アラーム（要件3.1）。
      const boiled = boiledTimerIds(assignedSlotDisplays(currentView, currentUnits, now));
      if (boiled.size === 0) {
        lastRingAtRef.current = null; // 空へ遷移＝鳴動停止。次の非空化で即時に最初の一発（要件3.4）。
        return;
      }
      if (dueDoneCue(boiled, now, lastRingAtRef.current)) {
        lastRingAtRef.current = now; // ペースは撃とうとした時刻で進める（鳴否に依存しない＝撃ちっぱなし）
        emit(playDoneTone);
      }
    }

    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") return;
      readyContext(); // 可視復帰で resume を試みる（要件5.2）
      tick(); // throttle で止まった分を即時に再評価（boiled 残存なら 1 秒以内に Done 再開・要件5.2/5.3）
    };

    for (const type of UNLOCK_EVENTS) document.addEventListener(type, onGesture, true);
    document.addEventListener("visibilitychange", onVisibility);
    const tickHandle = setInterval(tick, tickMs);

    return () => {
      clearInterval(tickHandle);
      for (const type of UNLOCK_EVENTS) document.removeEventListener(type, onGesture, true);
      document.removeEventListener("visibilitychange", onVisibility);
      const ctx = sessionRef.current;
      sessionRef.current = null;
      if (ctx !== null) {
        try {
          void ctx.close();
        } catch {
          // close 失敗は致命的でない。参照は手放しており、次の生成で作り直す。
        }
      }
    };
    // マウント中 1 回だけ張る効果。emit / readyContext は refs だけに依存する安定参照ゆえ実質再実行されない。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [emit, readyContext]);

  // Touch_Cue 再生口: 指定操作（タップ）から呼ぶ。running なら鳴らし、未 running なら resume を試みて no-op
  // （best-effort・要件1）。直前の Touch_Cue 未完了でも audioTone が毎回新ノードを生成＝先頭から再トリガ（要件1.6）。
  const playTouchCue = useCallback((): void => {
    emit(playTouchTone);
  }, [emit]);

  return useMemo<AudioCues>(() => ({ playTouchCue }), [playTouchCue]);
}
