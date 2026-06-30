// client/audioCue.ts — 音声キューの「鳴らすか否か」だけを決める純粋判定の核。
// WS も DOM も時計も AudioContext も localStorage も触れない決定的関数群（時刻・観測位相は引数で受ける）。
// 「計算と作用の分離」をクライアントへ徹底し、ここでは音を一切鳴らさない——鳴らすのは端の作用（useAudioCues）。
//
// boiled 集合・remaining の導出は既存の純粋関数（slotDisplay.ts / clock.ts）をそのまま組み合わせる。
// boiled / remaining をここで再定義せず、表示が出るのと同じ集合に音を載せる（重複の根絶・要件3.5）。

import type { SlotDisplay } from "./components/slotDisplay";
import type { TimerFact } from "../domain/timer";
import { remainingMs } from "./clock";

/** Pre_Alert のしきい（残り 60 秒）。要件記述の Pre_Alert_Threshold。 */
export const PRE_ALERT_THRESHOLD_MS = 60_000;

/** Done_Cue のリピート間隔（5 秒）。要件記述の Done_Cue_Interval。 */
export const DONE_CUE_INTERVAL_MS = 5_000;

/**
 * boiled 集合の導出 — Done_Cue の鳴動主体（要件3.6 / 3.7）。
 *
 * 既存の表示導出 SlotDisplay[] から kind:"boiled" の timerId を Set で集める。
 * Set ゆえ複数スロット駆動・複数件同時 boiled は dedup され、Done_Cue 周期ごと 1 回へ集約される。
 * 担当外スロットは呼び出し側の assignedSlotDisplays 射影で構造的に現れないため、ここでは絞り込まない。
 */
export function boiledTimerIds(displays: readonly SlotDisplay[]): ReadonlySet<string> {
  const boiled = new Set<string>();
  for (const display of displays) {
    if (display.kind === "boiled") boiled.add(display.timer.id);
  }
  return boiled;
}

/**
 * Done_Cue の周期到来判定 — 「鳴らすか否か」は現在の boiled 集合の関数（要件3.2 / 3.7）。
 *
 * boiled が空なら、now / lastRingAt の値によらず常に false（停止・要件3.4）。
 * boiled が非空かつ前回鳴動が無い（lastRingAt === null）なら true（未存在→存在への遷移で即時・要件3.3）。
 * boiled が非空なら now - lastRingAt >= interval のとき、かつそのときに限り true（要件3.1）。
 * done 通知の受信回数・boiled の濃度・processedIds には一切依存しない（要件3.2 / 3.6 / 3.7）。
 *
 * lastRingAt は端が抱える「最後に Done_Cue を鳴らした時刻」（SSOT ではない作用ローカルな計時情報）。
 */
export function dueDoneCue(
  boiled: ReadonlySet<string>,
  now: number,
  lastRingAt: number | null,
  intervalMs: number = DONE_CUE_INTERVAL_MS,
): boolean {
  if (boiled.size === 0) return false;
  if (lastRingAt === null) return true;
  return now - lastRingAt >= intervalMs;
}

/**
 * Pre_Alert の観測位相 — timerId 基準の表示制御用ローカル情報（SSOT のコピーではない・要件2.7）。
 *
 *   - armed   : remaining > 閾値 で観測済み（閾値クロスを発火できる待機状態）。
 *   - alerted : Pre_Alert 発火済み、または「出現時に既に ≤ 閾値」で失格（once-only を担う）。
 * どちらにも無い timerId は「未観測」。notification.ts の processedIds と同じローカル冪等の構図。
 */
export interface PreAlertWatch {
  readonly armed: ReadonlySet<string>;
  readonly alerted: ReadonlySet<string>;
}

/** 空の観測位相（初期値）。 */
export const EMPTY_PRE_ALERT_WATCH: PreAlertWatch = {
  armed: new Set<string>(),
  alerted: new Set<string>(),
};

/**
 * Pre_Alert 閾値クロスの検知 — (前回位相, 担当 Timer 群, offset, now) → (発火 timerId 群, 次位相)。
 *
 * 各担当 Timer の remaining（endTime と offset と now から clock.ts で導出）を見て:
 *   - 未観測 かつ remaining > 閾値          → armed へ（発火しない）
 *   - armed かつ remaining <= 閾値          → 発火し alerted へ（要件2.1）
 *   - 未観測 かつ remaining <= 閾値（0含む）→ alerted へ直行（出現時既に閾値以下＝失格・要件2.5）、発火しない
 *   - alerted                               → 何もしない（once-only・要件2.4）
 *
 * 入力 assigned に居ない timerId は次位相の armed/alerted から落とす（done/cancel で記録破棄・要件2.10）。
 * assigned のみを走査するため、次位相は「現に担当中の id」だけを含み、記録は有界に保たれる。
 * 担当外 Timer は呼び出し側が assignedTimers で除外済み（要件2.2）。純粋・決定的。
 */
export function advancePreAlert(
  prev: PreAlertWatch,
  assigned: readonly TimerFact[],
  offset: number,
  now: number,
  thresholdMs: number = PRE_ALERT_THRESHOLD_MS,
): { readonly fire: readonly string[]; readonly next: PreAlertWatch } {
  const fire: string[] = [];
  // 次位相は assigned のみから組み立てる。前位相に居ても今 assigned に居ない id は自然に脱落する（要件2.10）。
  const armed = new Set<string>();
  const alerted = new Set<string>();

  for (const timer of assigned) {
    const id = timer.id;
    const remaining = remainingMs(timer.endTime, offset, now);

    if (prev.alerted.has(id)) {
      // 既に発火済み or 失格済み。二度と鳴らさない（once-only・要件2.4）。
      alerted.add(id);
      continue;
    }

    if (prev.armed.has(id)) {
      // 閾値超で観測済み＝クロスを発火する資格がある。閾値以下へ達した瞬間に発火（要件2.1）。
      if (remaining <= thresholdMs) {
        fire.push(id);
        alerted.add(id);
      } else {
        armed.add(id);
      }
      continue;
    }

    // 未観測。閾値超で初観測なら armed、出現時点で既に閾値以下なら失格として alerted 直行（要件2.5）。
    if (remaining > thresholdMs) {
      armed.add(id);
    } else {
      alerted.add(id);
    }
  }

  return { fire, next: { armed, alerted } };
}
