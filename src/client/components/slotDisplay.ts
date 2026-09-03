// client/components/slotDisplay.ts — 担当スロットごとの表示状態を導出する純粋関数。
// WS も DOM も触れない。受信ビュー（全量保持）・担当ユニット集合・現在時刻 now から、
// 表示集合を毎描画導出する（保持は全量・表示は導出／要件12.2）。残り秒は状態に昇格させず、
// clock.ts の remainingMs に now を渡して描画のたびに算出する（要件10.1 の思想をクライアントへ延長）。

import type { TimerFact } from "../../domain/timer";
import { mode, type ClientTimer, type ClientView } from "../connection";
import { correctedNow, remainingMs } from "../clock";
import { assignedTimers, slotsOfUnits } from "../assignment";
import { slotOf } from "../../domain/store";
import type { QueueEntry, QueueSuggestion } from "./queueDisplay";

/**
 * 担当スロット 1 つの表示状態。
 *
 * - running   : 担当スロットに走行中（remaining > 0）の Timer がある。残りを導出して秒読み表示する。
 *               unconfirmed は最早走行 Timer の origin === "local"（Provisional_Timer）からの導出値（要件6.4）。
 * - boiled    : 担当スロットの Timer が茹で上がった（remaining ≤ 0）が、まだ明示完了されていない。
 *               ユーザーが消し込むべき状態。Complete 操作の対象として timer を保持する。
 * - idle      : 同期済みだが担当スロットに Timer が無い。開始操作と次の提案を提示できる（直前結果の表示は UI 層）。
 * - unreceived: 未同期で当該スロットの endTime を未受信。「残り時間未受信」表示（要件5.5）。
 */
export type SlotDisplay =
  | {
      readonly kind: "running";
      readonly slot: number;
      readonly timer: TimerFact;
      readonly remainingMs: number;
      readonly unconfirmed: boolean;
    }
  | {
      readonly kind: "boiled";
      readonly slot: number;
      readonly timer: TimerFact;
      readonly overdueMs: number;
    }
  | {
      readonly kind: "idle";
      readonly slot: number;
      /**
       * この釜に次に入る提案 1 件（無ければ null）。
       *
       * ビューに保持しない導出値である。当該釜を slotIds に含む担当範囲内の提案のうち startAt 最小の 1 件で、
       * QueueSuggestion をそのまま載せる——「開始に要る事実が揃った提案」は queueDisplay が既に定義しており、
       * 同じ概念を二度定義しない。degraded では常に null（押しても送られない操作を出さない・要件 1.3 / 2.12）。
       */
      readonly next: QueueSuggestion | null;
    }
  | { readonly kind: "unreceived"; readonly slot: number };

/**
 * 担当スロットの全件について表示状態を昇順で導出する。
 *
 * 担当外スロットは slotsOfUnits / assignedTimers の射影で構造的に現れない（要件12.2）。
 * boiled / running は endTime（事実）と now からの導出で切り分ける（remaining > 0 は走行中、≤ 0 は茹で上がり）。
 * 走行中（remaining > 0）があればそれを最優先で秒読み表示し、無ければ茹で上がり（明示完了待ち）を示す。
 * completed / cancelled で除去された Timer は view.timers から消えているため、空きスロットは idle になる。
 */
export function assignedSlotDisplays(
  view: ClientView,
  units: readonly number[],
  now: number,
  entries: readonly QueueEntry[],
): readonly SlotDisplay[] {
  const assignedSet = slotsOfUnits(units);
  const slots = [...assignedSet].sort((a, b) => a - b);
  // 担当分の Timer をスロット番号で引けるよう束ねる。表示はスロット単位の事象である。
  // ClientTimer のまま束ね、origin（未確定タグ）を失わない（unconfirmed の導出元・要件6.4）。
  // 1 Timer は複数スロットを駆動しうるため、その駆動スロットそれぞれ（担当範囲内のもの）へ束ねる。
  const timersBySlot = new Map<number, ClientTimer[]>();
  for (const timer of assignedTimers(view.timers, units)) {
    for (const slotId of timer.slotIds) {
      const slot = slotOf(slotId);
      if (!assignedSet.has(slot)) continue; // 担当外スロットには出さない（多スロット Timer の範囲外スロット）
      const bucket = timersBySlot.get(slot);
      if (bucket) bucket.push(timer);
      else timersBySlot.set(slot, [timer]);
    }
  }

  return slots.map((slot) => {
    const bucket = timersBySlot.get(slot) ?? [];
    // 走行中（remaining > 0）を最優先。複数あれば最早 endTime を採る。
    const running = bucket.filter((timer) => remainingMs(timer.endTime, view.offset, now) > 0);
    if (running.length > 0) {
      const earliest = running.reduce((a, b) => (b.endTime < a.endTime ? b : a));
      const remaining = remainingMs(earliest.endTime, view.offset, now);
      // unconfirmed は origin === "local"（Provisional_Timer）からの導出値。状態には昇格させない（要件6.4）。
      return {
        kind: "running",
        slot,
        timer: earliest,
        remainingMs: remaining,
        unconfirmed: earliest.origin === "local",
      };
    }
    if (bucket.length > 0) {
      // 走行中が無く Timer が在席＝茹で上がり（remaining ≤ 0・明示完了待ち）。最早 endTime を消し込み対象にする。
      // overdueMs（≥ 0・クランプなし）も載せる：boiled は超過時間をマイナス表示する（早く上げろ、の意思表示）。
      const earliest = bucket.reduce((a, b) => (b.endTime < a.endTime ? b : a));
      const overdueMs = Math.max(0, correctedNow(view.offset, now) - earliest.endTime);
      return { kind: "boiled", slot, timer: earliest, overdueMs };
    }
    if (view.sync === "synced") {
      // 同期済みで Timer が無い＝アイドル。開始操作と次の提案を提示する（直前結果の表示は UI 層が担う）。
      return { kind: "idle", slot, next: nextForSlot(entries, slot, view) };
    }
    // 未同期（connecting / syncFailed）で endTime 未受信 → 残り時間未受信（要件5.5）。
    return { kind: "unreceived", slot };
  });
}

/**
 * ある釜に次に入る提案を導く。無ければ null。
 *
 * 候補は entries が既に絞り込んでいる——担当範囲（assignedBySlots）と、開始に要る茹で秒が引けること
 * （boilSecondsOf）はあちらの条件であり、ここで書き直さない（要件 1.4）。
 *
 * 同値の startAt では entries の順（到着順・orderQueueEntries が決定的）の先着を採る。`<` で比較すれば
 * 先着が残るため、端末間・再描画間で並びが揺れない。
 *
 * degraded では常に null を返す。判定をここに閉じ、SlotCard に「degraded なら出さない」という条件を
 * 書かせない（表示の判断を 1 箇所に集める）。
 */
function nextForSlot(
  entries: readonly QueueEntry[],
  slot: number,
  view: ClientView,
): QueueSuggestion | null {
  if (mode(view) !== "live") return null;
  let next: QueueSuggestion | null = null;
  for (const entry of entries) {
    const suggestion = entry.suggestion;
    if (suggestion === null) continue;
    if (!suggestion.slotIds.some((slotId) => slotOf(slotId) === slot)) continue;
    if (next === null || suggestion.startAt < next.startAt) next = suggestion;
  }
  return next;
}
