// client/components/OrderQueue.tsx — 未着手オーダーの待ち行列と、担当範囲内の開始提案の表示。
//
// 到着順に並んだ行を横 1 列で示す（釜のグリッドの高さを奪わないため、固定高の帯として上に置く）。
// 行の並び・待ち時間・提案の絞り込みはすべて queueDisplay.ts の純粋導出が済ませており、ここは
// 「導出済みの値を人が読む形へ写す」だけを担う（残り時間の表示と同じ分担）。
//
// 機械は開始を指示しない。提案は Suggested として示し、命令形の文言も自動開始の示唆も置かない
// （AC 8.2）。推奨開始時刻が過ぎていても、client は時刻の到来を契機に何もしない——サーバの次回
// 再評価で置き換わるまで過去時刻のまま出る。
//
// スロットカードとの重畳は作らない。ある釜が茹で上がり（boiled）表示のまま同じ釜へ提案が付くことは
// あるが（湯切りで釜は空くため物理的に正しい）、カードの表示状態は既存の規律（running > boiled > idle）が
// 決めたままにし、提案はこの帯の中だけに現れる。新しい重畳規則を持ち込まない。

import type { PendingOrder } from "../../domain/order";
import type { QueueEntry, QueueSuggestion } from "./queueDisplay";
import type { NoodleColor } from "./noodleColor";
import { FIRMNESS_LABEL } from "./firmness";
import { formatRemaining } from "../format";
import { PlayIcon } from "./icons";
import { cn } from "../cn";

interface OrderQueueProps {
  readonly entries: readonly QueueEntry[];
  /** noodleType → 前景色の resolver（スロットカードと同一の割り当てを共有する）。 */
  readonly noodleColor: NoodleColor;
  /** 提案から開始する（提案が揃った行だけがこの口を持つ）。 */
  readonly onStart: (order: PendingOrder, suggestion: QueueSuggestion) => void;
}

/** 絶対時刻を端末のローカル壁時計 HH:MM へ写す。提案開始時刻の提示専用（過去時刻もそのまま出す）。 */
function wallClock(epochMillis: number): string {
  const at = new Date(epochMillis);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** 待ち行列と提案の帯。未着手オーダーが無ければ何も描かない（釜のグリッドに一切の場所を譲る）。 */
export function OrderQueue({ entries, noodleColor, onStart }: OrderQueueProps) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Waiting orders"
      className="flex flex-none flex-col gap-[clamp(0.25rem,0.8vh,0.5rem)]"
    >
      <p className="m-0 text-xs font-bold tracking-wide text-muted uppercase">
        Waiting orders ({entries.length})
      </p>
      <ul className="m-0 flex list-none gap-[clamp(0.375rem,0.9vw,0.625rem)] overflow-x-auto p-0">
        {entries.map((entry) => (
          <OrderQueueRow
            key={`${entry.order.externalOrderId}-${entry.order.itemIndex}`}
            entry={entry}
            noodleColor={noodleColor}
            onStart={onStart}
          />
        ))}
      </ul>
    </section>
  );
}

/** 待ち行列 1 行。麺種・卓・待ち時間の事実を示し、提案がある行にだけ開始の口を添える。 */
function OrderQueueRow({
  entry,
  noodleColor,
  onStart,
}: {
  readonly entry: QueueEntry;
  readonly noodleColor: NoodleColor;
  readonly onStart: (order: PendingOrder, suggestion: QueueSuggestion) => void;
}) {
  const { order, suggestion } = entry;
  return (
    <li
      className={cn(
        "flex flex-none items-center gap-[clamp(0.375rem,0.9vw,0.625rem)]",
        "rounded-[0.625rem] border border-line bg-panel2 px-3 py-[0.4375rem]",
      )}
    >
      <span className="flex flex-col items-start leading-tight">
        <span className="text-sm font-bold" style={{ color: noodleColor(order.noodleType) }}>
          {order.noodleType}
        </span>
        <span className="text-[0.6875rem] text-muted">
          {FIRMNESS_LABEL[order.firmness]}
          {order.tableId !== null && ` · Table ${order.tableId}`}
          {` · ${formatRemaining(entry.waitingMs)}`}
        </span>
      </span>
      {suggestion !== null && (
        <button
          type="button"
          // 提案であることを支援技術にも同じ語で伝える（指示ではない）。
          aria-label={`Suggested: start ${order.noodleType} on slot ${suggestion.slotIds.join(", ")} at ${wallClock(suggestion.startAt)}`}
          onClick={() => onStart(order, suggestion)}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-[0.5rem] border border-line bg-panel px-2 py-1",
            "text-left text-ink hover:border-muted active:scale-95",
          )}
        >
          <PlayIcon className="h-4 w-auto" />
          <span className="flex flex-col leading-tight">
            <span className="text-[0.625rem] font-bold tracking-wide text-muted uppercase">
              Suggested
            </span>
            <span className="text-xs font-bold tabular-nums">
              {`Slot ${suggestion.slotIds.join(", ")} · ${wallClock(suggestion.startAt)}`}
            </span>
          </span>
        </button>
      )}
    </li>
  );
}
