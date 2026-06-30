// client/components/useAudioCues.ts — 音声キュー機構を担う端の作用フック。
//
// Audio_Session（AudioContext）のライフサイクルを所有する唯一の場所。音声経路は AudioContext の
// 単一経路に一本化し（design.md 骨格1）、解錠・resume・破棄と再生成をここ一点で完結させる。
// 「鳴らすか否か」の判定は純粋層（audioCue.ts）が持ち、本フックは判定結果を受けて世界（音）を変える
// だけ——計算と作用の分離をクライアントへ徹底する（design-philosophy）。
//
// 既存 useWakeLock.ts の規律（可視時のみ・前面復帰のたびに取り直す・優雅な劣化・アンマウントで
// クリーンアップ）を手本にする。Audio_Session・解錠状態は useRef にセッション内ローカルで抱え、
// SSOT（ClientView / サーバ）・永続へ書き戻さない（要件4.7 / 7.10）。
//
// 本ファイルが担うのは Audio_Session のライフサイクル（タスク3.3）と、評価ティック（≤1s）・Pre_Alert/
// Done_Cue の発火・5 秒周期の自己回復（タスク3.4）である。後者は前者で整えた refs と内部ヘルパ
// （warmUp / needsResume / tryResume / destroy）の上に、純粋層（audioCue.ts）の判定を載せて配線する。

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
  /** 指定された UI 操作（タップ）から呼ぶ Touch_Cue の再生口。未解錠・失敗時は no-op（要件1）。 */
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
// 音は best-effort であり正しさの担保は視覚正本（boiled 表示・カウントダウン）ゆえ、稀な Mobile Safari の
// レート変動による歪みは受容し、ここではレートに一切干渉しない（YAGNI・実在の歪みを観測してから対処する）。

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

/** suspended / interrupted（Safari 固有・標準型に無い）なら resume を要する。 */
function needsResume(ctx: AudioContext): boolean {
  const state: string = ctx.state;
  return state === "suspended" || state === "interrupted";
}

/**
 * 音声キュー機構をマウント中だけ動かす端のフック。
 *
 * 本フック（タスク3.3）が担う Audio_Session ライフサイクル:
 *   - Audio_Unlock — 初回ジェスチャ（touchstart/touchend/click/keydown を capture フェーズで待受）で
 *     AudioContext を生成し、無音バッファ（createBuffer(1,1,sampleRate)）を 1 回 warm-up する（要件4.1/4.2）。
 *   - 解錠成立の確認 — 無音 BufferSource の onended が発火し「実際に再生完了した」ことを確認してから
 *     running（解錠済み）とみなし、確認後に解錠リスナ群を一括解除する（試みただけで running を主張しない）。
 *   - resume — suspended/interrupted な Audio_Session を、可視化（visibilitychange→visible）起点で resume する（要件7.2）。
 *   - 破棄と再生成 — resume 失敗（InvalidStateError 等）で close → null 化し、解錠リスナを再武装して
 *     次ジェスチャで再 warm-up する。warm-up 失敗時も次ジェスチャで再試行する（要件4.6 / 7.4）。
 *   - sampleRate — レートはデバイス任せで正常値が一定でないため干渉しない（特定値で弾くと無音化する）。
 *   - 非対応環境 — AudioContext/webkitAudioContext 不在なら何もせず劣化する（解錠リスナも張らない・要件4.5）。
 *   - アンマウント — AudioContext を破棄し、張った全リスナ（解錠ジェスチャ・visibilitychange）を解除する。
 *
 * 評価ティック・Pre_Alert/Done_Cue の発火・5 秒周期の自己回復（タスク3.4）:
 *   - 評価ティック — tickMs（既定 1000・≤1000）ごとに now を採取し、assignedSlotDisplays → boiledTimerIds で
 *     boiled 集合、assignedTimers + advancePreAlert で Pre_Alert 発火群を純粋導出する（導出値を状態に昇格させない）。
 *   - Pre_Alert 再生 — 鳴らせる状態（解錠済み・running）なら fire の各 timerId に Pre_Alert_Cue を 1 回鳴らす（要件2.1/2.8）。
 *   - Done_Cue 5 秒周期 — dueDoneCue が true の周期で、冒頭に suspended/interrupted なら resume を試み、鳴らせるなら
 *     Done_Cue を 1 回鳴らして lastRingAt を進める。鳴らせなければ進めず次周期へ繰り越す（要件3.1/3.11/7.5/7.6）。
 *     boiled が空になれば lastRingAt を解除し、次に非空化したら 1 秒以内に最初の Done を鳴らす（要件3.3/3.4）。
 *   - 可視復帰 — visibilitychange→visible で resume を試み、評価を 1 回即実行して boiled 残存なら Done_Cue 周期を
 *     1000ms 以内に再開する（boiled 空なら鳴らさない・要件5.2/5.3）。useWakeLock と同じ visibilitychange 規律。
 *
 * 本フックが抱える可変は Audio_Session（実行資源）・解錠状態と、preAlertWatch（観測位相）・lastRingAt（最終鳴動時刻）
 * という作用ローカルな計時/位相情報だけで、いずれも SSOT（ClientView / サーバ / 永続）へ書き戻さない（要件3.9/4.7/5.4/7.7）。
 * view / units は評価のために refs へ控える（最新の事実を端の作用から参照するため）。
 */
export function useAudioCues(
  view: ClientView,
  units: readonly number[],
  options?: AudioCuesOptions,
): AudioCues {
  // Audio_Session（実行資源）と解錠状態。セッション内ローカルに抱え、SSOT・永続へ書き戻さない（要件4.7/7.10）。
  const sessionRef = useRef<AudioContext | null>(null);
  const unlockedRef = useRef(false);

  // 評価ティック（タスク3.4）が最新の事実を参照するための控え。導出値は状態に昇格させず、毎評価で
  // この view（事実）と units（設定）から純粋導出し直す。
  const viewRef = useRef(view);
  viewRef.current = view;
  const unitsRef = useRef(units);
  unitsRef.current = units;

  // 時刻採取・ティック間隔は差し替え口（テスト）。マウント時に 1 回だけ確定する（≤1000 を保つ・要件2.9/3.3）。
  const nowFnRef = useRef<(() => number) | null>(null);
  if (nowFnRef.current === null) nowFnRef.current = options?.now ?? (() => Date.now());
  const tickMsRef = useRef<number | null>(null);
  if (tickMsRef.current === null) tickMsRef.current = options?.tickMs ?? 1000;

  // 作用ローカルな計時/位相情報（SSOT・永続へ書き戻さない・要件3.9/4.7/5.4/7.7）。
  //   - preAlertWatchRef : Pre_Alert の観測位相（once-only を担う・毎ティック畳み込む）。
  //   - lastRingAtRef    : 最後に Done_Cue を鳴らした時刻。boiled 空で null へ戻す（次の非空化で即時鳴動）。
  const preAlertWatchRef = useRef<PreAlertWatch>(EMPTY_PRE_ALERT_WATCH);
  const lastRingAtRef = useRef<number | null>(null);

  // 「鳴らせる状態か」の単一判定（解錠済み && running）。満たせば鳴らせる ctx を返し、満たさねば null。
  // Touch / Pre_Alert / Done の全 Cue がこの一点を通る（重複の根絶）。
  const playableContext = useCallback((): AudioContext | null => {
    const ctx = sessionRef.current;
    if (!unlockedRef.current || ctx === null) return null; // 未解錠は no-op（要件1.2）
    if (ctx.state !== "running") return null; // running 以外（suspended/interrupted 等）は鳴らさない
    return ctx;
  }, []);

  useEffect(() => {
    const resolved = resolveAudioContextConstructor();
    if (resolved === undefined) return; // 非対応環境: 何もしない（解錠リスナも張らない・要件4.5）
    // 早期 return 後の確定値を、閉包内（unlock）でも非 undefined と扱える型付き別名へ束ねる。
    const AudioContextCtor: AudioContextConstructor = resolved;

    // マウント時に確定した時刻採取・ティック間隔（既定 Date.now / 1000ms）。
    const nowFn = nowFnRef.current ?? (() => Date.now());
    const tickMs = tickMsRef.current ?? 1000;

    let cancelled = false; // アンマウント後の再武装・再生を抑止する
    let warming = false; // warm-up 進行中フラグ（多重 warm-up と stuck を防ぐ）

    /** Audio_Session を破棄し解錠状態を戻す。次ジェスチャで再 warm-up できるよう解錠リスナを再武装する。 */
    function destroy(): void {
      const ctx = sessionRef.current;
      sessionRef.current = null;
      unlockedRef.current = false;
      warming = false;
      if (ctx !== null) {
        try {
          void ctx.close();
        } catch {
          // close 失敗は致命的でない。参照は既に手放しており、次の生成で作り直す。
        }
      }
      armUnlockListeners(); // 破棄後は次ジェスチャでの再 warm-up を待ち受ける（cancelled なら何もしない）
    }

    /** 無音バッファを 1 回再生して warm-up する。onended 発火で解錠成立を確認してから running 化する。 */
    function warmUp(ctx: AudioContext): void {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.onended = () => {
        // 「試みた」だけでなく実際に再生完了したことを確認してから解錠済みとみなす（真＝状態について嘘をつかない）。
        if (cancelled) return;
        unlockedRef.current = true;
        warming = false;
        source.disconnect();
        source.onended = null;
        removeUnlockListeners(); // 確認後に初めて解錠リスナ群を一括解除する
      };
      source.connect(ctx.destination);
      source.start(0);
    }

    /** 初回ジェスチャでの解錠（生成 + resume + warm-up）。失敗時は破棄して次ジェスチャで再試行。 */
    function unlock(): void {
      if (unlockedRef.current || warming) return; // 解錠済み / warm-up 進行中は何もしない
      try {
        if (sessionRef.current === null) {
          sessionRef.current = new AudioContextCtor();
        }
        const ctx = sessionRef.current;
        // 生成直後は suspended のことがある。ジェスチャ内 resume を試みてから warm-up する。
        if (needsResume(ctx)) void ctx.resume().catch(() => destroy());
        warming = true;
        warmUp(ctx);
      } catch {
        // warm-up / 生成失敗。握り潰し、破棄して次ジェスチャで再試行する（要件4.6）。
        destroy();
      }
    }

    /** suspended/interrupted な Audio_Session を resume する。失敗（InvalidStateError 等）で破棄・再生成（要件7.4）。 */
    function tryResume(): void {
      const ctx = sessionRef.current;
      if (ctx === null) return;
      if ((ctx.state as string) === "closed") {
        destroy();
        return;
      }
      if (!needsResume(ctx)) return;
      void ctx
        .resume()
        .catch(() => destroy());
    }

    const onGesture = (): void => unlock();

    /**
     * 評価ティック（≤ tickMs）— now を採取し boiled 集合と Pre_Alert 発火群を毎ティック純粋導出する。
     * 導出値（boiled・remaining・発火対象）は状態へ昇格させず、view（事実）と units（設定）と now から
     * 計算し直す。鳴らすのは「鳴らせる状態」のときだけで、位相 / 周期の計時は誠実にリトライへ繰り越す。
     */
    function tick(): void {
      const now = nowFn();
      const currentView = viewRef.current;
      const currentUnits = unitsRef.current;

      // boiled 集合と Pre_Alert 発火群を純粋導出する（表示が出るのと同じ集合に音を載せる・重複の根絶）。
      const boiled = boiledTimerIds(assignedSlotDisplays(currentView, currentUnits, now));
      const { fire, next } = advancePreAlert(
        preAlertWatchRef.current,
        assignedTimers(currentView.timers, currentUnits),
        currentView.offset,
        now,
      );
      // 位相は毎ティック畳み込む。未解錠でも once-only 記録は進め、過去クロスを遡って鳴らさない（要件2.5）。
      // 鳴らすか否かはこの後の playableContext が決める。
      preAlertWatchRef.current = next;

      // Pre_Alert 再生 — 鳴らせる状態なら fire の各 timerId につき 1 回鳴らす（要件2.1/2.8）。
      if (fire.length > 0) {
        const ctx = playableContext();
        if (ctx !== null) {
          for (let i = 0; i < fire.length; i++) {
            try {
              playPreAlertTone(ctx);
            } catch {
              // best-effort: 再生失敗は握り潰す（要件3.11）。視覚正本（boiled 表示）は不変。
            }
          }
        }
      }

      // Done_Cue 5 秒周期。boiled が空なら位相を解除し、次の非空化で即時（1 秒以内）に最初の Done を鳴らす（要件3.3/3.4）。
      if (boiled.size === 0) {
        lastRingAtRef.current = null;
        return;
      }
      if (dueDoneCue(boiled, now, lastRingAtRef.current)) {
        // 冒頭で Audio_Session を確認し suspended/interrupted なら resume を試みる。resume は非同期ゆえ当ティックでは
        // 鳴らせなくとも、次周期で回復して鳴る＝自己修復リトライ（要件7.5/7.6）。
        tryResume();
        const ctx = playableContext();
        if (ctx !== null) {
          try {
            playDoneTone(ctx);
            // 鳴らせたときだけ最終鳴動時刻を進める（状態について嘘をつかない）。
            lastRingAtRef.current = now;
          } catch {
            // 再生失敗は lastRingAt を進めず、次周期で誠実にリトライへ繰り越す（要件3.11）。
          }
        }
        // 未解錠・suspended 等で鳴らせない場合も lastRingAt を更新しない（次周期で再評価＝繰り越し）。
      }
    }

    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") return;
      tryResume();
      // 可視復帰時に 1 回即評価する。boiled が残れば 1000ms 以内に Done_Cue 周期を再開し、空なら鳴らさない
      // （dueDoneCue が false・要件5.2/5.3）。useWakeLock と同じ visibilitychange 規律。
      tick();
    };

    function armUnlockListeners(): void {
      if (cancelled) return;
      for (const type of UNLOCK_EVENTS) document.addEventListener(type, onGesture, true);
    }
    function removeUnlockListeners(): void {
      for (const type of UNLOCK_EVENTS) document.removeEventListener(type, onGesture, true);
    }

    armUnlockListeners();
    document.addEventListener("visibilitychange", onVisibility);

    // 評価ティック（≤1000ms）。毎ティックで boiled / Pre_Alert を導出し、鳴らせる周期だけ鳴らす。
    const tickHandle = setInterval(tick, tickMs);

    return () => {
      cancelled = true;
      clearInterval(tickHandle);
      removeUnlockListeners();
      document.removeEventListener("visibilitychange", onVisibility);
      destroy();
    };
    // マウント中 1 回だけ張る効果。playableContext は refs だけに依存する安定参照ゆえ依存配列に含めない。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Touch_Cue 再生口: 鳴らせる状態（解錠済み・running）のとき短音を鳴らす。それ以外は no-op（best-effort・要件1）。
  // 直前の Touch_Cue 未完了でも audioTone は毎回新ノードを生成するため先頭から再トリガされる（要件1.6）。
  // 未解錠（1.2）・running 以外・再生失敗（1.3）はいずれも鳴らさない。
  const playTouchCue = useCallback((): void => {
    const ctx = playableContext();
    if (ctx === null) return;
    playTouchTone(ctx);
  }, [playableContext]);

  return useMemo<AudioCues>(() => ({ playTouchCue }), [playTouchCue]);
}
