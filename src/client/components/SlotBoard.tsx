// client/components/SlotBoard.tsx — 担当スロットの一覧表示と操作の配線。
// 接続の外部ストアを useSyncExternalStore で購読してビューを得る（受信・接続状態の変化で再描画）。
// 残りの秒読みはビュー変化では起きないため、useNow が現在時刻を 1 秒間隔で刻んで再描画を促し、
// 描画のたびに slotDisplay の純粋導出で残りを算出し直す（要件10.5）。残り秒は状態に持たない。

import { useSyncExternalStore } from "react";
import type { TimerConnection } from "../connection";
import { assignedSlotDisplays } from "./slotDisplay";
import { useNow } from "./useNow";
import { SlotCard } from "./SlotCard";

interface SlotBoardProps {
  readonly connection: TimerConnection;
  readonly units: readonly number[];
}

/** 同期フェーズを人が読む文へ（UI コンテンツは英語）。 */
const SYNC_LABEL = {
  connecting: "Connecting…",
  synced: "Synced",
  syncFailed: "Sync failed — reconnecting…",
} as const;

/** 担当ユニットの Timer を秒読み表示し、担当スロットにのみ開始/キャンセル操作を提示する。 */
export function SlotBoard({ connection, units }: SlotBoardProps) {
  // ビューは受信・接続状態変化でのみ更新される外部ストア。残り秒は持たない。
  const view = useSyncExternalStore(connection.subscribe, connection.getView);
  const now = useNow();
  // 保持は全量・表示は導出。担当外スロットはここで構造的に除外される（要件12.2）。
  const displays = assignedSlotDisplays(view, units, now);

  // slotId はスロット番号の文字列表現（slotOf = Number(slotId) の逆／要件12.5）。
  // UI はスロット単位なので 1 スロットを駆動する Timer として開始する（slotIds は 1 件）。
  const startOnSlot = (slot: number, noodleType: string, boilSeconds: number) => {
    connection.start([String(slot)], noodleType, boilSeconds);
  };

  return (
    <section aria-label="Slots">
      <p role="status">{SYNC_LABEL[view.sync]}</p>
      {view.error && <p role="alert">{view.error.message}</p>}
      <div>
        {displays.map((display) => (
          <SlotCard
            key={display.slot}
            display={display}
            onStart={startOnSlot}
            onCancel={connection.cancel}
          />
        ))}
      </div>
    </section>
  );
}
