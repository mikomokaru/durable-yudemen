// engine/settle.ts — 集合変更後の全体再同期と Effect 列組み立てを一箇所へ畳み込む純粋ヘルパ。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// start / cancel / complete / fire / adjust の各遷移は「基底の集合変更」までを担い、その後の
// 「running の全体再同期 → 確定結果の no-op 検出 → Persist 先頭の Effect 列」を settle に委ねる。
// 再同期・no-op 規律・Effect 列の順序を二度書けば二つの真実になるため、この後段をここ一箇所に集約する。
//
// 不変条件（SSOT 規律）: 確定結果が直前と変わるときのみ Effect を出し、その列は必ず Persist が先頭。
// 確定結果が直前と同一なら put も broadcast もしない（要件7.7）。

import type { EpochMillis } from "./types";
import type { TimerState } from "./state";
import type { Timer } from "./timer";
import type { Outcome, Effect } from "./effect";
import { synchronize } from "./sync";
import type { SyncParams } from "./sync";
import { toSnapshot } from "./snapshot";
import { nextAlarmEffect } from "./alarm";
import { toWireTimer } from "./project";
import type { ServerMessage } from "../domain/messages";

/**
 * 集合変更後の共通後処理（全体再同期＋no-op 検出＋Effect 列組み立て）。
 *
 * running のみ synchronize で Adjustment を全体置換し、boiled は据え置く（発火時の調整を凍結保持）。
 * 確定結果（Timer 集合の id・各 adjustment・各 boiledAt）が直前と同一なら Effect を出さず状態も prev へ戻す。
 * 変化があれば Persist を先頭に、SetAlarm|ClearAlarm（実効最早）・全量 snapshot Broadcast の順で Effect 列を組む。
 *
 * @param prev    遷移前の状態（no-op 比較の基準）
 * @param moved   基底の集合変更後・同期前の状態
 * @param params  同期パラメータ（arms / toleranceRatio・値）
 * @param now     snapshot の serverTime
 */
export function settle(
  prev: TimerState,
  moved: TimerState,
  params: SyncParams,
  now: EpochMillis,
): Outcome {
  // running のみ再同期し、boiled は据え置いて元の並び順のまま合成する。
  const running = moved.timers.filter((t) => t.boiledAt === null);
  const synced = synchronize(running, params);
  const nextTimers = mergeBoiled(moved.timers, synced);
  const nextState: TimerState = { timers: nextTimers, nextSeq: moved.nextSeq };

  // no-op 検出（要件7.7）：確定結果が prev と同一なら put も broadcast もしない。状態も prev を返す。
  if (isSameConfirmedResult(prev, nextState)) {
    return { ok: true, state: prev, effects: [] };
  }

  return { ok: true, state: nextState, effects: assembleEffects(nextState, now) };
}

/**
 * 同期済みの running（synced）を moved.timers の並び順へ差し戻す。boiled は moved のまま据え置く。
 *
 * synchronize には running のみを渡すため synced は running だけを含む。id をキーに running を synced で
 * 差し替え、boiled はそのまま通すことで、moved の元の並び順を保ったまま再合成する（順序を乱さない）。
 */
function mergeBoiled(movedTimers: readonly Timer[], synced: readonly Timer[]): readonly Timer[] {
  const syncedById = new Map<string, Timer>(synced.map((t) => [t.id, t]));
  return movedTimers.map((t) => (t.boiledAt === null ? (syncedById.get(t.id) ?? t) : t));
}

/**
 * 確定結果の同一性判定（要件7.7）。Timer の集合（id）＋各 timer の adjustment＋boiledAt が
 * prev と next で完全一致するか。id をキーに突き合わせるため列挙順に依存しない。
 */
function isSameConfirmedResult(prev: TimerState, next: TimerState): boolean {
  if (prev.timers.length !== next.timers.length) return false;
  const prevById = new Map<string, Timer>(prev.timers.map((t) => [t.id, t]));
  for (const t of next.timers) {
    const p = prevById.get(t.id);
    if (p === undefined) return false;
    if (p.adjustment !== t.adjustment || p.boiledAt !== t.boiledAt) return false;
  }
  return true;
}

/**
 * Persist 先頭の Effect 列を組む（design「broadcast 戦略」＝厳守）。
 *
 * 順序は Persist → SetAlarm|ClearAlarm（実効最早）→ 全量 snapshot Broadcast（実効 endTime を載せる）。
 * 確定変化ごとに送るのは snapshot ただ一つ（唯一の権威表現・SSOT）——意味論 Broadcast と Reply は撤去した。
 * Persist を先頭に置くのは SSOT 規律の表明であり、shell は put 成功の上にのみ Alarm / Broadcast を立てる。
 */
function assembleEffects(nextState: TimerState, now: EpochMillis): readonly Effect[] {
  // 全量 snapshot は実効 endTime（toWireTimer が畳み込む）を載せ、集合全体の調整変化を一度に反映する。
  const snapshot: ServerMessage = {
    type: "snapshot",
    serverTime: now,
    timers: nextState.timers.map(toWireTimer),
  };
  return [
    { type: "Persist", snapshot: toSnapshot(nextState) },
    nextAlarmEffect(nextState.timers),
    { type: "Broadcast", message: snapshot },
  ];
}
