// client/components/OrderRail.tsx — 未着手オーダーの待ち行列と、担当範囲内の開始提案の表示。
//
// 到着順に並んだ行を盤面の左端で縦 1 列に示す。縦方向の余りを可視件数へ変換するため、器は固定幅
// （w-32）の縦レールであり、溢れは自領域内の縦スクロールだけで受ける（横スクロールは持たない）。
// 行の並び・待ち時間・提案の絞り込みはすべて queueDisplay.ts の純粋導出が済ませており、ここは
// 「導出済みの値を人が読む形へ写す」だけを担う（残り時間の表示と同じ分担）。
//
// entries は非空を型で要求する。0 件のレールは「幅 0」ではなく不在であり、描くか否かの判定は
// SlotBoard が 1 箇所だけで行う——ここで再び空を数えれば条件の出所が二つになる。
//
// 機械は開始を指示しない。提案は Suggested として示し、命令形の文言も自動開始の示唆も置かない
// （AC 8.2）。推奨開始時刻が過ぎていても、client は時刻の到来を契機に何もしない——サーバの次回
// 再評価で置き換わるまで過去時刻のまま出る。
//
// スロットカードとの重畳は作らない。ある釜が茹で上がり（boiled）表示のまま同じ釜へ提案が付くことは
// あるが（湯切りで釜は空くため物理的に正しい）、カードの表示状態は既存の規律（running > boiled > idle）が
// 決めたままにし、提案はこのレールの中だけに現れる。新しい重畳規則を持ち込まない。

import type { PendingOrder } from "../../domain/order";
import type { NonEmptyArray } from "../../domain/timer";
import type { QueueEntry, QueueSuggestion } from "./queueDisplay";
import type { NoodleColor } from "./noodleColor";
import { FIRMNESS_LABEL } from "./firmness";
import { formatRemaining } from "../format";
import { cn } from "../cn";

interface OrderRailProps {
  /** 到着順に導出済みの表示状態。非空を型で要求する（0 件のレールは構築不能）。 */
  readonly entries: NonEmptyArray<QueueEntry>;
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

/** 待ち行列と提案の縦レール。盤面の左端に立ち、区切りは自身の右 padding と border が作る。 */
export function OrderRail({ entries, noodleColor, onStart }: OrderRailProps) {
  return (
    <section
      aria-label="Waiting orders"
      className={cn(
        "flex w-32 flex-none flex-col gap-[clamp(0.25rem,0.8vh,0.5rem)]",
        "border-r border-line pr-[clamp(0.5rem,1.2vw,0.875rem)]",
      )}
    >
      <p className="m-0 flex-none text-xs font-bold tracking-wide text-muted uppercase">
        Waiting orders ({entries.length})
      </p>
      {/* スクロール位置は DOM が持つ事実。ul の identity と行の key を保ち、React state へ昇格させない。 */}
      <ul
        className={cn(
          "m-0 flex min-h-0 flex-1 list-none flex-col gap-[clamp(0.25rem,0.8vh,0.5rem)] p-0",
          "overflow-x-hidden overflow-y-auto overscroll-contain",
        )}
      >
        {entries.map((entry) => (
          <OrderRow
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
function OrderRow({
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
        "flex flex-none flex-col gap-[0.125rem]",
        "rounded-[0.625rem] border border-line bg-panel2 px-3 py-[0.4375rem]",
      )}
    >
      {/* 麺種色はインライン style で与える。これがこのレール唯一のインラインスタイルであり、
          色の出所はスロットカードと共有する resolver（noodleColor prop）だけである。 */}
      <span
        className="truncate text-sm leading-tight font-bold"
        style={{ color: noodleColor(order.noodleType) }}
      >
        {order.noodleType}
      </span>
      {/* 左群（茹で加減 + 卓番）と待ち時間を justify-between で両端へ固定する。左寄せの連結では
          卓番が消えたときに待ち時間が左へずれる——両端固定なら動くのは左群の内側だけで、
          茹で加減は左端・待ち時間は右端に留まり行高も変わらない。
          幅が足りないとき削るのは麺種名・卓番の末尾だけ（左群の truncate）で、待ち時間は
          flex-none ゆえ常に全桁が出る。 */}
      <span className="flex items-baseline justify-between gap-1 text-[0.6875rem] leading-tight text-muted">
        <span className="truncate">
          {FIRMNESS_LABEL[order.firmness]}
          {order.tableId !== null && ` · Table ${order.tableId}`}
        </span>
        <span className="flex-none tabular-nums">{formatRemaining(entry.waitingMs)}</span>
      </span>
      {/* 提案の開始操作。aria-label を持たない——支援技術へ渡す名前は 3 行の可視テキストから
          計算される。可視表示と AT 名が同一の語であることを、同一のものであることで保証する。
          横並び（アイコン + 1 行）は幅 73px の欄に収まらないため、3 行に積む。釜の行に truncate を
          置かないのは、推奨が含む釜番号を 1 つも落とさないためで、区切りの ", " の空白が折り返し
          機会になる。 */}
      {suggestion !== null && (
        <button
          type="button"
          onClick={() => onStart(order, suggestion)}
          className={cn(
            "mt-[0.25rem] flex min-h-[2.75rem] w-full cursor-pointer flex-col items-start",
            "rounded-[0.5rem] border border-line bg-panel px-1.5 py-1 text-left leading-tight text-ink",
            "hover:border-muted active:scale-95",
          )}
        >
          <span className="text-[0.6875rem] font-bold text-muted">Suggested</span>
          <span className="text-[0.6875rem] font-bold tabular-nums">
            {`${suggestion.slotIds.length === 1 ? "Slot" : "Slots"} ${suggestion.slotIds.join(", ")}`}
          </span>
          <span className="text-xs font-bold tabular-nums">{wallClock(suggestion.startAt)}</span>
        </button>
      )}
    </li>
  );
}
