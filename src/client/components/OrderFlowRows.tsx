// client/components/OrderFlowRows.tsx — オーダーの流れ（KANBAN）の**横時系列・縦積み**の盤面（既定・2026-09-17 確定）。
//
// 縦レーン版（OrderFlowBoard・`?layout=columns` で比較用に残す）の並びを 90 度倒す。段階は上から Waiting / Boiling / Bowls / Done の行で、どの行も
// **右が急ぎ**（時系列の昇順を右から）——丼のドックと同じ向きに全体を揃え、視線と手の向きを一つにする。
//   Waiting … 左に釜のミニマップ（別の箱・どの釜にどの食券が入っているか・4 桁の食券番号）、右に待ちの札の箱。急ぐものが右端。
//   Boiling … 左に最新の計画（一度に上げる調理クラスタの一覧・上がりの早い順・中は卓で区切る）、右に横のタイムライン。
//             タイムラインは右端に 0s の線、上がった札はその右の帯へ。左端に 7m+ の帯。
//   Bowls   … 丼のドック（縦レーン版と同じ部品）。Plating の行は持たない——ドックが盛りつけ中を含む。
//             右端に Done の小片（件数だけ）を同じ行に置く。タップで直近の Done を上に小さく開く。
// 導出（flowLanes / timelinePlacements）は縦レーン版と共有し、ここは向きを写すだけである。

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TimerConnection } from "../connection";
import { itemKeyOf, type ItemKey, type OrderItem } from "../../domain/order";
import { SLOTS_PER_UNIT, slotOf } from "../../domain/store";
import { TablePicker } from "./TablePicker";
import { PlanPanel } from "./PlanPanel";

import { cn } from "../cn";
import { noodleColors, type NoodleColor } from "./noodleColor";
import { displayName } from "./queueDisplay";
import {
  BOWL_PREP_LEAD_MS,
  flowLanes,
  planClusters,
  rebasePlan,
  ticketNumberOf,
  timelinePlacements,
  type BoilingEntry,
  type DoneEntry,
  type WaitingEntry,
} from "./flowLanes";
import {
  BOILING_CARD_PX,
  BOILING_CARD_WIDTH_MAX_PX,
  BoilingCard,
  BowlDock,
  Card,
  FALLBACK_PX_PER_SECOND,
  GAP_PX,
  metaOf,
  TIMELINE_WINDOW_MS,
  TIMELINE_WINDOW_SEC,
  useMeasuredSize,
  useSecondBeat,
  waitFigure,
} from "./OrderFlowBoard";

interface OrderFlowRowsProps {
  readonly connection: TimerConnection;
  readonly acked: ReadonlySet<ItemKey>;
  readonly onAck: (key: ItemKey) => void;
  /** Waiting / Boiling の札をタップして卓を選んだときの送信（店が卓を決める・2026-09-17）。 */
  readonly onAssignTable: (
    orderItem: { readonly externalOrderId: string; readonly itemIndex: number },
    tableId: string | null,
  ) => void;
}

/** 横版の札の寸法（px）。縦版の Boiling の札と同じ。 */
const CARD_W = BOILING_CARD_WIDTH_MAX_PX;
const CARD_H = BOILING_CARD_PX;
/** 目盛りラベルの帯（px・タイムラインの下端）。 */
const AXIS_H = 16;
/** 0s の線の右の余白と、7m+ の線の左の余白（px）。 */
const LINE_PAD = 10;

export function OrderFlowRows({ connection, acked, onAck, onAssignTable }: OrderFlowRowsProps) {
  const view = useSyncExternalStore(connection.subscribe, connection.getView);
  useSecondBeat();
  const now = Date.now();
  const lanes = flowLanes(view, acked, now);
  const corrected = now + view.offset;
  // 先頭の開始が過去なら、その遅れぶんを全クラスタに足して「いま始めたら」の目盛りで出す（表示だけ・中身は変えない）。
  const plan = rebasePlan(planClusters(view, now), corrected);
  const colorOf = useMemo(
    () => noodleColors(view.noodlePresets.map((preset) => preset.noodleType)),
    [view.noodlePresets],
  );
  // 卓を選んでいる品目（ダイアログの対象）。null は閉。
  const [picking, setPicking] = useState<OrderItem | null>(null);
  return (
    <>
      {view.error && (
        <p
          role="alert"
          className="flex-none rounded-[0.625rem] border border-danger bg-[color-mix(in_oklab,var(--color-danger)_18%,var(--color-panel))] px-[0.875rem] py-2 font-bold text-ink"
        >
          {view.error.message}
        </p>
      )}
      {!lanes.synced && (
        <p role="status" className="flex-none text-sm text-muted">
          Waiting for the latest orders from the server… Boiling timers keep counting locally.
        </p>
      )}
      {/* 最上段：左に釜のミニマップの箱、右に Waiting の箱。ミニマップは Waiting の中身ではないので箱を分ける。 */}
      <div className="flex flex-none items-stretch gap-[clamp(0.5rem,1.2vw,0.875rem)]">
        <section
          aria-label="Slot map"
          className="flex flex-none items-center rounded-[0.875rem] border border-line bg-panel px-[clamp(0.5rem,1vw,0.75rem)] py-2"
        >
          <SlotMinimap unitCount={view.unitCount} entries={lanes.boiling} noodleColor={colorOf} />
        </section>
        <Row title="Waiting" count={lanes.waiting.length} className="min-w-0 flex-1">
          <div
            className="flex min-w-0 flex-1 flex-row-reverse items-center overflow-x-auto overflow-y-hidden"
            style={{ gap: GAP_PX }}
          >
            {lanes.waiting.map((entry) => (
              <WaitingTile
                key={itemKeyOf(entry.order)}
                entry={entry}
                noodleColor={colorOf}
                onPick={setPicking}
              />
            ))}
          </div>
        </Row>
      </div>
      {/* 中段：左に最新の計画の箱、右に Boiling の箱。 */}
      <div className="flex min-h-0 flex-1 items-stretch gap-[clamp(0.5rem,1.2vw,0.875rem)]">
        <PlanPanel
          clusters={plan.clusters}
          lagMs={plan.lagMs}
          corrected={corrected}
          unitCount={view.unitCount}
          noodleColor={colorOf}
          className="w-56 flex-none"
        />
        <Row title="Boiling" count={lanes.boiling.length} className="min-h-0 min-w-0 flex-1">
          <BoilingStrip
            entries={lanes.boiling}
            noodleColor={colorOf}
            unitCount={view.unitCount}
            onPick={setPicking}
          />
        </Row>
      </div>
      <div className="flex flex-none items-stretch gap-2">
        <BowlDock bowls={lanes.bowls} noodleColor={colorOf} onAck={onAck} grow />
        <DoneChip entries={lanes.done} noodleColor={colorOf} />
      </div>
      {picking !== null && (
        <TablePicker
          order={picking}
          onPick={(tableId) => {
            onAssignTable(
              { externalOrderId: picking.externalOrderId, itemIndex: picking.itemIndex },
              tableId,
            );
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}

/** 行の器。左に見出しと件数、右に中身。`grow` の行だけが残りの高さを取る。 */
function Row({
  title,
  count,
  grow = false,
  className,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly grow?: boolean;
  /** 横並びの器に置くときの伸縮（例: `min-w-0 flex-1`）。 */
  readonly className?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "flex items-stretch gap-3 rounded-[0.875rem] border border-line bg-panel px-[clamp(0.5rem,1vw,0.75rem)] py-2",
        grow ? "min-h-0 flex-1" : (className ?? "flex-none"),
      )}
    >
      <h2 className="m-0 flex w-16 flex-none flex-col justify-center text-xs font-bold tracking-wide text-muted uppercase">
        <span>{title}</span>
        <span className="font-mono text-sm tabular-nums">{count}</span>
      </h2>
      {children}
    </section>
  );
}

/** Waiting の札（横版）。丼のタイルと同じ寸法で、名・待ち・茹で加減と卓。推奨が付いた札は縁を琥珀に。 */
function WaitingTile({
  entry,
  noodleColor,
  onPick,
}: {
  readonly entry: WaitingEntry;
  readonly noodleColor: NoodleColor;
  /** 札のタップで卓を選ぶ。 */
  readonly onPick: (order: OrderItem) => void;
}) {
  const { order } = entry;
  const wait = waitFigure(entry.waitingMs);
  return (
    <button
      type="button"
      onClick={() => onPick(order)}
      aria-label={`Set table — ${displayName(order)}`}
      className="flex-none cursor-pointer rounded-[0.625rem] border-0 bg-transparent p-0 text-left hover:brightness-110"
      style={{ width: CARD_W, height: CARD_H }}
    >
      <Card
        name={displayName(order)}
        tint={noodleColor(order.noodleType)}
        figure={wait.text}
        figureClass={wait.className}
        meta={metaOf(order)}
        table={order.tableId}
        returned={order.interruptedAt !== null}
        className={cn("h-full", entry.startAt !== null && "border-running/50")}
      />
    </button>
  );
}

/**
 * 釜のミニマップ。釜のタイマー画面と同じ並び（ユニットごとに 2 列 × 3 段・slot 6u..6u+5）で、各釜に入っている
 * 注文の**食券番号（4 桁）**を正方形に出す——上 2 桁・下 2 桁の 2 行（ユーザー確定 2026-09-17）。注文を持たない Timer は
 * 麺種の頭 2 文字、空の釜は釜番号だけを薄く。縁の色は釜の札と同じ語彙（走行中は琥珀・上がりは赤）。
 * 操作は持たない——ここは「どこに何が入っているか」を読むためだけの図である。
 */
function SlotMinimap({
  unitCount,
  entries,
  noodleColor,
}: {
  readonly unitCount: number;
  readonly entries: readonly BoilingEntry[];
  readonly noodleColor: NoodleColor;
}) {
  const bySlot = new Map<number, BoilingEntry>();
  for (const entry of entries)
    for (const slotId of entry.timer.slotIds) bySlot.set(slotOf(slotId), entry);
  return (
    <div role="img" aria-label="Kettles" className="flex flex-none items-start gap-2">
      {Array.from({ length: unitCount }, (_, unit) => (
        <div key={unit} className="grid grid-cols-2 gap-1">
          {Array.from({ length: SLOTS_PER_UNIT }, (_cell, k) => unit * SLOTS_PER_UNIT + k).map(
            (slot) => {
              const entry = bySlot.get(slot);
              if (entry === undefined) {
                return (
                  <span
                    key={slot}
                    className="flex h-10 w-10 items-center justify-center rounded-[0.375rem] border border-dashed border-line font-mono text-[0.625rem] text-muted/60"
                  >
                    {slot}
                  </span>
                );
              }
              const boiled = entry.remainingMs === 0;
              const label =
                entry.order === null
                  ? entry.timer.noodleType.slice(0, 4)
                  : ticketNumberOf(entry.order.externalOrderId);
              return (
                <span
                  key={slot}
                  title={`Slot ${slot} — ${label}`}
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-[0.375rem] border bg-panel2",
                    boiled ? "animate-badge-blink border-danger text-danger" : "border-running/60",
                  )}
                  style={boiled ? undefined : { color: noodleColor(entry.timer.noodleType) }}
                >
                  <TicketSquare label={label} />
                </span>
              );
            },
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * 食券番号の正方形表記。4 文字を上 2・下 2 の 2 行に割る（`1023` → `10` / `23`）。
 * 4 文字に満たなければ 1 行で出す。等幅・詰めた行送りで、正方形の枡に収まる。
 */
function TicketSquare({ label }: { readonly label: string }) {
  if (label.length !== 4) {
    return <span className="font-mono text-xs leading-none font-bold tabular-nums">{label}</span>;
  }
  return (
    <span className="flex flex-col items-center font-mono text-sm leading-[1.05] font-bold tabular-nums">
      <span>{label.slice(0, 2)}</span>
      <span>{label.slice(2)}</span>
    </span>
  );
}

/**
 * Boiling の横タイムライン。右端に 0s の線（いま）。走行中の札は残り時間に比例して左に置かれ、右へ流れて線を越えると
 * 右の帯（上がった札）へ移る。7 分より先は左端の帯に上がる順で並ぶ。同じ頃に上がる札は縦の段へ避ける
 * （timelinePlacements の `column` を段に読む）。0s と 90s の間は準備帯として薄く塗る。
 * 幅は実寸から測り、上下の帯（右の UP・左の 7m+）を除いた幅いっぱいを 7 分とする。段が増えれば行は縦にスクロールする。
 */
function BoilingStrip({
  entries,
  noodleColor,
  unitCount,
  onPick,
}: {
  readonly entries: readonly BoilingEntry[];
  readonly noodleColor: NoodleColor;
  /** 釜の位置の図（SlotGlyph）の幾何。 */
  readonly unitCount: number;
  /** 注文を持つ札のタップで卓を選ぶ。 */
  readonly onPick: (order: OrderItem) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const { width: frameW, height: frameH } = useMeasuredSize(frameRef);
  const boiled = entries.filter((entry) => entry.remainingMs === 0);
  const running = entries.filter(
    (entry) => entry.remainingMs > 0 && entry.remainingMs <= TIMELINE_WINDOW_MS,
  );
  const far = entries.filter((entry) => entry.remainingMs > TIMELINE_WINDOW_MS);
  const stepY = CARD_H + GAP_PX;
  const stepX = CARD_W + GAP_PX;
  // 帯は縦に積む。1 列に入る枚数は行の高さから、列数は枚数から。
  const usable = Math.max(frameH - AXIS_H, stepY);
  const perCol = Math.max(1, Math.floor((usable + GAP_PX) / stepY));
  const colsOf = (count: number) => Math.ceil(count / perCol);
  const upBand = boiled.length > 0 ? colsOf(boiled.length) * stepX + LINE_PAD : LINE_PAD;
  const farBand = far.length > 0 ? colsOf(far.length) * stepX + LINE_PAD : 0;
  const window = frameW - upBand - farBand;
  const pxPerSecond = window > 0 ? window / TIMELINE_WINDOW_SEC : FALLBACK_PX_PER_SECOND;
  const placed = timelinePlacements(running, pxPerSecond, CARD_W, GAP_PX);
  const rows = Math.max(
    1,
    placed.columns,
    Math.min(boiled.length, perCol),
    Math.min(far.length, perCol),
  );
  // 高さは常に Boiling 枠いっぱい（線と目盛りは枠の上端から下端まで伸びる）。段が枠より多いときだけ伸びて縦スクロール。
  const height = Math.max(frameH, rows * stepY - GAP_PX + AXIS_H);
  const zeroX = Math.max(frameW, window + upBand + farBand) - upBand; // 0s の線の x
  const bandPos = (index: number) => ({
    top: (index % perCol) * stepY,
    col: Math.floor(index / perCol),
  });
  return (
    <div ref={frameRef} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div className="relative" style={{ height, minWidth: frameW }}>
        {/* 準備帯（0s〜90s）と準備線 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 bg-[color-mix(in_oklab,var(--color-ink)_6%,transparent)]"
          style={{
            left: zeroX - (BOWL_PREP_LEAD_MS / 1000) * pxPerSecond,
            width: (BOWL_PREP_LEAD_MS / 1000) * pxPerSecond,
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 border-l border-ink/50"
          style={{ left: zeroX - (BOWL_PREP_LEAD_MS / 1000) * pxPerSecond }}
        >
          <span className="absolute bottom-0 left-0.5 font-mono text-[0.625rem] text-ink/70">
            {BOWL_PREP_LEAD_MS / 1000}s
          </span>
        </div>
        {/* 分の目盛り（右から左へ 1m..7m） */}
        {Array.from({ length: TIMELINE_WINDOW_SEC / 60 }, (_, k) => k + 1).map((minute) => (
          <div
            key={minute}
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-line/70"
            style={{ left: zeroX - minute * 60 * pxPerSecond }}
          >
            <span className="absolute bottom-0 left-0.5 font-mono text-[0.625rem] text-muted/70">
              {minute}m
            </span>
          </div>
        ))}
        {/* 0s の線＝いま */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 border-l-2 border-ink/70"
          style={{ left: zeroX }}
        >
          <span className="absolute bottom-0 left-0.5 font-mono text-[0.625rem] font-bold text-ink/80">
            0s
          </span>
        </div>
        {/* 7m+ の線 */}
        {far.length > 0 && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-muted/60"
            style={{ left: farBand - LINE_PAD }}
          >
            <span className="absolute bottom-0 left-0.5 font-mono text-[0.625rem] text-muted/70">
              7m+
            </span>
          </div>
        )}
        {/* 走行中：右端（0s）から残り時間ぶん左。段は重なり回避。 */}
        {placed.placements.map(({ entry, top, column }) => (
          <div
            key={entry.timer.id}
            className="absolute"
            style={{
              left: zeroX - top - CARD_W,
              top: column * stepY,
              width: CARD_W,
              height: CARD_H,
            }}
          >
            <BoilingCard
              entry={entry}
              noodleColor={noodleColor}
              unitCount={unitCount}
              onPick={onPick}
            />
          </div>
        ))}
        {/* 上がった札：0s の右の帯。長く放置されているものが線の隣。 */}
        {boiled.map((entry, index) => {
          const { top, col } = bandPos(index);
          return (
            <div
              key={entry.timer.id}
              className="absolute"
              style={{ left: zeroX + LINE_PAD + col * stepX, top, width: CARD_W, height: CARD_H }}
            >
              <BoilingCard
                entry={entry}
                noodleColor={noodleColor}
                unitCount={unitCount}
                onPick={onPick}
              />
            </div>
          );
        })}
        {/* 7 分より先：左端の帯。上がる順で線の隣から。 */}
        {far.map((entry, index) => {
          const { top, col } = bandPos(index);
          return (
            <div
              key={entry.timer.id}
              className="absolute"
              style={{
                left: farBand - LINE_PAD - (col + 1) * stepX + GAP_PX,
                top,
                width: CARD_W,
                height: CARD_H,
              }}
            >
              <BoilingCard
                entry={entry}
                noodleColor={noodleColor}
                unitCount={unitCount}
                onPick={onPick}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Done の小片（横版）。ドックと同じ行の右端に件数だけを置く。基本は見ないもので、確認したいときだけタップして
 * 直近の Done を上へ小さく開く（新しいものが上・外側タップか再タップで閉じる）。
 */
function DoneChip({
  entries,
  noodleColor,
}: {
  readonly entries: readonly DoneEntry[];
  readonly noodleColor: NoodleColor;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Done" className="relative flex flex-none items-stretch">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "flex w-14 cursor-pointer flex-col items-center justify-center rounded-[0.875rem] border border-line bg-panel text-xs font-bold tracking-wide text-muted uppercase hover:text-ink",
          open && "text-ink",
        )}
      >
        <span>Done</span>
        <span className="font-mono text-sm tabular-nums">{entries.length}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Recent done"
          className="absolute right-0 bottom-[calc(100%+0.5rem)] z-40 flex max-h-[60vh] w-56 flex-col gap-[6px] overflow-y-auto rounded-[0.875rem] border border-line bg-panel p-2 shadow-[0_1.125rem_3.125rem_rgba(0,0,0,.55)]"
        >
          {entries.length === 0 && <p className="m-0 text-sm text-muted">Nothing done yet</p>}
          {entries.map((entry) => (
            <Card
              key={itemKeyOf(entry.order)}
              name={displayName(entry.order)}
              tint={noodleColor(entry.order.noodleType)}
              figure={new Date(entry.completedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
              meta={metaOf(entry.order)}
              table={entry.order.tableId}
              className="h-14 opacity-80"
            />
          ))}
        </div>
      )}
    </section>
  );
}
