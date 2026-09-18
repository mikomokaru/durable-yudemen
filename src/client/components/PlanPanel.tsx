// client/components/PlanPanel.tsx — 最新の計画（調理クラスタの一覧）。Orders 画面と釜のタイマー画面が同じ部品を使う
// （見え方を二つ作らない・2026-09-18）。導出は flowLanes.ts の planClusters / rebasePlan で、ここは写すだけ。

import { itemKeyOf } from "../../domain/order";
import { formatRemaining } from "../format";
import { cn } from "../cn";
import type { NoodleColor } from "./noodleColor";
import { displayName } from "./queueDisplay";
import type { PlanCluster } from "./flowLanes";
import { SlotGlyph, TableBadge } from "./OrderFlowBoard";

/**
 * 最新の計画。**一度に上げる調理クラスタ**（上がり時刻が等しい品目）を 1 箱にし、上がりの早い順に縦に並べる。箱の見出しは
 * 開始までの時間（過ぎていれば `now`）と上がりの時刻。箱の中は卓（提供の単位＝群）で区切り、品目ごとに卓のバッジ・名・
 * 釜の位置の図。操作は持たない——開始は釜の画面の仕事で、ここは「次に何をどの釜で、一緒に何が上がるか」を読む一覧である。
 * 計画は snapshot のたびに置き換わる。
 */
export function PlanPanel({
  clusters,
  lagMs,
  corrected,
  unitCount,
  noodleColor,
  className,
}: {
  readonly clusters: readonly PlanCluster[];
  /** 先頭の遅れ（ミリ秒）。正なら目盛りは「いま始めたら」の見込みで、見出しにそう記す。 */
  readonly lagMs: number;
  readonly corrected: number;
  readonly unitCount: number;
  readonly noodleColor: NoodleColor;
  /** 器の幅と伸縮（置く画面が決める。Orders は `w-56 flex-none`、釜のタイマーは左レールの幅）。 */
  readonly className?: string | undefined;
}) {
  const bowls = clusters.reduce(
    (sum, cluster) => sum + cluster.groups.reduce((n, group) => n + group.items.length, 0),
    0,
  );
  return (
    <section
      aria-label="Plan"
      className={cn(
        "flex min-h-0 flex-col gap-2 rounded-[0.875rem] border border-line bg-panel px-[clamp(0.5rem,1vw,0.75rem)] py-2",
        className,
      )}
    >
      <h2 className="m-0 flex flex-none items-baseline justify-between text-xs font-bold tracking-wide text-muted uppercase">
        <span>
          Plan
          {lagMs > 0 && (
            <span
              className="ml-2 font-normal text-running normal-case"
              title="The first start is overdue; times assume you start now."
            >
              if now
            </span>
          )}
        </span>
        <span className="font-mono text-sm tabular-nums">
          {clusters.length}
          <span className="text-muted/60"> / {bowls}</span>
        </span>
      </h2>
      <ol className="m-0 flex min-h-0 flex-1 list-none flex-col gap-2 overflow-y-auto p-0">
        {clusters.length === 0 && <li className="text-sm text-muted">No plan</li>}
        {clusters.map((cluster) => {
          const startIn = cluster.startAt - corrected;
          const startLabel = startIn <= 0 ? "now" : `in ${formatRemaining(startIn)}`;
          const serve = new Date(cluster.serveAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          return (
            <li
              key={cluster.serveAt}
              className={cn(
                "rounded-[0.625rem] border px-2 py-1.5",
                startIn <= 0 ? "border-running/60 bg-panel2" : "border-line bg-panel2",
              )}
            >
              <div className="flex items-baseline justify-between text-[0.6875rem] text-muted">
                <span
                  className={cn("font-mono font-bold tabular-nums", startIn <= 0 && "text-running")}
                >
                  {startLabel}
                </span>
                <span className="font-mono tabular-nums">↑ {serve}</span>
              </div>
              {/* 卓（群）ごとの区切り。同じ箱＝一度に上がる。区切り線＝別の卓へ届ける。 */}
              {cluster.groups.map((group, index) => (
                <ul
                  key={group.group}
                  className={cn(
                    "m-0 mt-1 flex list-none flex-col gap-1 p-0",
                    index > 0 && "border-t border-dashed border-line/70 pt-1",
                  )}
                >
                  {group.items.map((item) => (
                    <li
                      key={itemKeyOf(item.order)}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex min-w-0 items-baseline gap-1">
                        <TableBadge tableId={item.order.tableId} />
                        <span
                          className="truncate font-bold"
                          style={{ color: noodleColor(item.order.noodleType) }}
                        >
                          {displayName(item.order)}
                        </span>
                      </span>
                      <span className="flex flex-none text-muted">
                        <SlotGlyph slotIds={item.suggestion.slotIds} unitCount={unitCount} />
                      </span>
                    </li>
                  ))}
                </ul>
              ))}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
