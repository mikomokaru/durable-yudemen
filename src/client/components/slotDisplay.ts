// client/components/slotDisplay.ts — 担当スロットごとの表示状態を導出する純粋関数。
// WS も DOM も触れない。受信ビュー（全量保持）・担当ユニット集合・現在時刻 now から、
// 表示集合を毎描画導出する（保持は全量・表示は導出／要件12.2）。残り秒は状態に昇格させず、
// clock.ts の remainingMs に now を渡して描画のたびに算出する（要件10.1 の思想をクライアントへ延長）。

import type { WireTimer } from "../../shared/messages";
import type { ClientTimer, ClientView } from "../connection";
import { remainingMs } from "../clock";
import { assignedTimers, slotOf, slotsOfUnits } from "../assignment";

/**
 * 担当スロット 1 つの表示状態。
 *
 * - running   : 担当スロットにアクティブ Timer があり、残りを導出して秒読み表示する。
 *               remaining は 0 以上にクランプ済み（負を出さない／要件5.6）。
 *               unconfirmed は最早アクティブ Timer の origin === "local"（Provisional_Timer）からの
 *               導出値。degraded 中に生まれた未確定な走行を表示上で区別するためにあり、状態ではない（要件6.4）。
 * - boiled    : 当該スロットの Timer がすべて茹で上がり処理済み（done）。00:00 相当の茹で上がり表示。
 * - idle      : 同期済みだが担当スロットに Timer が無い。開始操作を提示できる。
 * - unreceived: 未同期で当該スロットの endTime を未受信。「残り時間未受信」表示（要件5.5）。
 */
export type SlotDisplay =
  | {
      readonly kind: "running";
      readonly slot: number;
      readonly timer: WireTimer;
      readonly remainingMs: number;
      readonly unconfirmed: boolean;
    }
  | { readonly kind: "boiled"; readonly slot: number }
  | { readonly kind: "idle"; readonly slot: number }
  | { readonly kind: "unreceived"; readonly slot: number };

/**
 * 担当スロットの全件について表示状態を昇順で導出する。
 *
 * 担当外スロットは slotsOfUnits / assignedTimers の射影で構造的に現れない（要件12.2）。
 * アクティブ（未処理）Timer を優先し、複数あれば最早 endTime を採る。アクティブが無く
 * done 済みの Timer だけが残るスロットは茹で上がり表示（次の snapshot 全置換で除去される）。
 */
export function assignedSlotDisplays(
  view: ClientView,
  units: readonly number[],
  now: number,
): readonly SlotDisplay[] {
  const slots = [...slotsOfUnits(units)].sort((a, b) => a - b);
  // 担当分の Timer をスロット番号で引けるよう束ねる。表示はスロット単位の事象である。
  // ClientTimer のまま束ね、origin（未確定タグ）を失わない（unconfirmed の導出元・要件6.4）。
  const timersBySlot = new Map<number, ClientTimer[]>();
  for (const timer of assignedTimers(view.timers, units)) {
    const slot = slotOf(timer.slotId);
    const bucket = timersBySlot.get(slot);
    if (bucket) bucket.push(timer);
    else timersBySlot.set(slot, [timer]);
  }

  return slots.map((slot) => {
    const bucket = timersBySlot.get(slot) ?? [];
    // 未処理（アクティブ）の Timer のみが秒読みの対象。done 済みは茹で上がりの残渣。
    const active = bucket.filter((timer) => !view.processedIds.has(timer.id));
    if (active.length > 0) {
      const earliest = active.reduce((a, b) => (b.endTime < a.endTime ? b : a));
      // 残りは導出。0 以下でも 00:00 相当として running 表示し、負を出さない（要件5.6）。
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
      // アクティブが無く done 済みのみ → 茹で上がり表示（要件2.11 の表示切替の結果）。
      return { kind: "boiled", slot };
    }
    if (view.sync === "synced") {
      // 同期済みで Timer が無い＝アイドル。開始操作を提示する。
      return { kind: "idle", slot };
    }
    // 未同期（connecting / syncFailed）で endTime 未受信 → 残り時間未受信（要件5.5）。
    return { kind: "unreceived", slot };
  });
}
