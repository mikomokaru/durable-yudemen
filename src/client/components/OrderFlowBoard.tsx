// client/components/OrderFlowBoard.tsx — オーダーの流れ（KANBAN）の盤面。
//
// 4 レーン（Waiting / Boiling / Plating / Done）を横に並べる。並び・残り・経過はすべて flowLanes.ts の純粋導出が
// 済ませており、ここは「導出済みの値を人が読む形へ写す」だけを担う（OrderRail・SlotCard と同じ分担）。
// 秒読みのために毎秒＋復帰時の再レンダーの拍を持ち、時刻は描画時点の Date.now() で読む（SlotBoard と同じ）。
//
// Boiling だけはリストではなくタイムラインである。上端が「いま」で、札は残り時間に比例した高さに置かれ、時刻が進むほど
// 上へ動く。茹で上がった札は上端に積まれて赤く点滅する（釜カードの boiled と同じ語彙）。他のレーンは急ぐものが上に来る
// 単純な縦並びで、溢れは各レーンの縦スクロールが受ける。
//
// 盤面の最下段は「丼のドック」（BowlDock）——準備中（上がりまで BOWL_PREP_LEAD_MS 以下）から Done に入るまでの丼を、右端が
// 最も早い順で横に並べる（lanes.bowls）。やるべき丼（準備する・Done を確認する）が無いときは細い帯に畳み、在るときに広がる
// ——盛りつけの人の視線は下（丼）に在り、そこに手を動かす対象が現れる形にする。盛りつけ中（上げた後）の札はそこで
// タップして Done にできる。準備中・上がり待ちの札は操作を持たない——ドックを出る出来事は Done の確認だけである。
//
// この盤面が送る操作は Plating → Done の確認だけである（プロトタイプ・端末ローカル・flowLanes.ts の注記）。開始・
// 中断・完了は釜の画面の操作のままで、ここでは観測して写すだけ——同じ操作の口を二つの画面に持たない。

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TimerConnection } from "../connection";
import { itemKeyOf, type ItemKey, type OrderItem, type WireOrderItem } from "../../domain/order";
import { SLOTS_PER_UNIT, slotOf } from "../../domain/store";
import { formatRemaining } from "../format";
import { cn } from "../cn";
import { FIRMNESS_LABEL } from "./firmness";
import { noodleColors, type NoodleColor } from "./noodleColor";
import { displayName, portionsLabel } from "./queueDisplay";
import { TablePicker } from "./TablePicker";
import {
  BOWL_PREP_LEAD_MS,
  flowLanes,
  timelinePlacements,
  waitTone,
  type WaitTone,
  type BoilingEntry,
  type Bowl,
  type DoneEntry,
  type PlatingEntry,
  type WaitingEntry,
} from "./flowLanes";

interface OrderFlowBoardProps {
  readonly connection: TimerConnection;
  /** この端末で盛りつけ済みと確認した品目の鍵（platingAcks.ts）。 */
  readonly acked: ReadonlySet<ItemKey>;
  /** Plating の札をタップしたときの確認。 */
  readonly onAck: (key: ItemKey) => void;
  /** Waiting / Boiling の札をタップして卓を選んだときの送信（店が卓を決める・2026-09-17）。 */
  readonly onAssignTable: (
    orderItem: { readonly externalOrderId: string; readonly itemIndex: number },
    tableId: string | null,
  ) => void;
}

/**
 * タイムラインの窓：0s の線から下を 7 分とする。尺度（px/秒）はレーンの実寸から毎描画導き、状態には持たない。
 * 7 分より先の残りは時系列で置かず、窓の下の帯に上がる順で並べる（遠い未来に時系列の精度は要らない・ユーザー確定
 * 2026-09-16）——0s の上の帯（上がった札）と対になる、下の帯である。
 */
export const TIMELINE_WINDOW_SEC = 7 * 60;
export const TIMELINE_WINDOW_MS = TIMELINE_WINDOW_SEC * 1000;
/** レーンの実寸が測れないうち（初回描画・happy-dom）の代替尺度。 */
export const FALLBACK_PX_PER_SECOND = 1;
/** タイムラインの札の寸法と間隔（px）。重なりの判定に使うので、描画の実寸と同じ値をここから与える。 */
export const BOILING_CARD_PX = 56;
/** 札の幅の上限と下限（px）。列が増えるほどレーン幅に合わせて縮め、下限を割るときだけ横スクロールへ逃がす。 */
export const BOILING_CARD_WIDTH_MAX_PX = 112;
const BOILING_CARD_WIDTH_MIN_PX = 60;
export const GAP_PX = 6;
/** 左端の時間軸（分ラベル）の幅（px）。 */
const AXIS_PX = 22;
/** 0s の線の上の余白（px）。帯が空でも線がレーンの上端に貼り付かないようにする。 */
const ZERO_LINE_PAD_PX = 14;
/** 7m+ の線と下の帯の札の間の余白（px）。ラベルが札に被らないようにする。 */
const FAR_LINE_PAD_PX = 14;
/** 棚のタイルの幅と間隔（px）。収まる枚数の計算に使うので、描画の実寸と同じ値をここから与える。 */
const SHELF_TILE_WIDTH_PX = 104;
const SHELF_GAP_PX = 6;

export function OrderFlowBoard({ connection, acked, onAck, onAssignTable }: OrderFlowBoardProps) {
  const view = useSyncExternalStore(connection.subscribe, connection.getView);
  useSecondBeat();
  const lanes = flowLanes(view, acked, Date.now());
  const colorOf = useMemo(
    () => noodleColors(view.noodlePresets.map((preset) => preset.noodleType)),
    [view.noodlePresets],
  );
  const [doneOpen, setDoneOpen] = useState(false);
  // 卓を選んでいる品目（ダイアログの対象）。null は閉。卓の事実はサーバが確定させ、snapshot で戻る。
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
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-[clamp(0.5rem,1.2vw,0.875rem)]",
          // Waiting / Plating は Boiling の 1/3 の幅。タイムラインに列を取らせ、両脇は名と数字が読めれば足りる。
          doneOpen
            ? "grid-cols-[minmax(0,0.6fr)_minmax(0,1.8fr)_minmax(0,0.6fr)_minmax(0,0.6fr)]"
            : "grid-cols-[minmax(0,0.6fr)_minmax(0,1.8fr)_minmax(0,0.6fr)_auto]",
        )}
      >
        <Lane title="Waiting" count={lanes.waiting.length}>
          {lanes.waiting.map((entry) => (
            <WaitingCard
              key={itemKeyOf(entry.order)}
              entry={entry}
              noodleColor={colorOf}
              onPick={setPicking}
            />
          ))}
        </Lane>
        <Lane title="Boiling" count={lanes.boiling.length} scrollX>
          <BoilingTimeline
            entries={lanes.boiling}
            noodleColor={colorOf}
            unitCount={view.unitCount}
            onPick={setPicking}
          />
        </Lane>
        <Lane title="Plating" count={lanes.plating.length}>
          {lanes.plating.map((entry) => (
            <PlatingCard
              key={itemKeyOf(entry.order)}
              entry={entry}
              noodleColor={colorOf}
              onAck={() => onAck(itemKeyOf(entry.order))}
            />
          ))}
        </Lane>
        <DoneLane
          entries={lanes.done}
          open={doneOpen}
          onToggle={() => setDoneOpen((open) => !open)}
          noodleColor={colorOf}
        />
      </div>
      <BowlDock bowls={lanes.bowls} noodleColor={colorOf} onAck={onAck} />
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

/**
 * 待ち時間の段階を数字の色へ写す（客の待ちの警告・2026-09-17）。`alert` は ⚠ を添える。
 * Waiting の札と、盛りつけ中の丼の数字が同じ規則で染まる——起点はどちらもオーダーの到着。
 */
export function waitFigure(waitingMs: number): {
  readonly text: string;
  readonly className: string;
} {
  const tone: WaitTone = waitTone(waitingMs);
  const text = formatRemaining(waitingMs);
  if (tone === "alert") return { text: `⚠ ${text}`, className: "font-bold text-danger" };
  if (tone === "warn") return { text, className: "font-bold text-warn" };
  return { text, className: "text-muted" };
}

/** 盛りつけ中の丼の数字。待ちが穏やかなら段階の色（緑）、警告に入れば待ちの色が勝つ。 */
function platingFigure(waitingMs: number): {
  readonly figure: string;
  readonly figureClass: string;
} {
  const wait = waitFigure(waitingMs);
  return {
    figure: wait.text,
    figureClass: wait.className === "text-muted" ? "text-boiled" : wait.className,
  };
}

/**
 * 秒読み用の再レンダーの拍。値は持たず bump するだけ——毎秒＋復帰時に再レンダーを促し、時刻は描画時点の Date.now() で読む
 * （SlotBoard と同じ規律。現在時刻をキャッシュせず、どの経路の再レンダーでも実時刻で算出する）。
 */
export function useSecondBeat(): void {
  const [, beat] = useState(0);
  useEffect(() => {
    const tick = () => beat((n) => n + 1);
    const id = setInterval(tick, 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
    };
  }, []);
}

/** レーンの器。見出しに件数を添え、中身は自領域の縦スクロールで受ける。 */
export function Lane({
  title,
  count,
  scrollX = false,
  children,
}: {
  readonly title: string;
  readonly count: number;
  /** 横方向の溢れも受けるか（Boiling のタイムラインは列が増えると横へ伸びる）。 */
  readonly scrollX?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex min-h-0 flex-col gap-2 rounded-[0.875rem] border border-line bg-panel p-[clamp(0.5rem,1vw,0.75rem)]"
    >
      <h2 className="m-0 flex flex-none items-baseline justify-between text-xs font-bold tracking-wide text-muted uppercase">
        <span>{title}</span>
        <span className="font-mono tabular-nums">{count}</span>
      </h2>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-[6px] overflow-y-auto overscroll-contain",
          scrollX ? "overflow-x-auto" : "overflow-x-hidden",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** 札の共通の骨——名（麺種色）と数字を上段、茹で加減・卓・釜を下段。 */
export function Card({
  name,
  tint,
  figure,
  figureClass,
  meta,
  table = null,
  returned = false,
  className,
}: {
  readonly name: string;
  readonly tint: string;
  readonly figure: string;
  readonly figureClass?: string | undefined;
  readonly meta: string;
  /** 卓。名の前に小さなバッジで出す（文字列で並べない・面積を取らない）。null は出さない。 */
  readonly table?: string | null | undefined;
  readonly returned?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "flex h-16 flex-none flex-col justify-center gap-[0.125rem] rounded-[0.625rem] border border-line bg-panel2 px-3",
        className,
      )}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1">
          <TableBadge tableId={table} />
          <span
            className={cn("truncate text-sm leading-tight font-bold", returned && "opacity-60")}
            style={{ color: tint }}
          >
            {returned && (
              <span role="img" aria-label="Returned" className="mr-1 text-muted">
                ↩
              </span>
            )}
            {name}
          </span>
        </span>
        <span
          className={cn("flex-none font-mono text-sm tabular-nums", figureClass ?? "text-muted")}
        >
          {figure}
        </span>
      </span>
      <span className="truncate text-[0.6875rem] leading-tight text-muted">{meta}</span>
    </div>
  );
}

/**
 * 卓のバッジ。`Table 3` と綴らず、小さな角丸に数字だけを置く（面積を取らない・2026-09-17）。卓なしは何も出さない。
 * 読み上げは `Table 3`。札の中で卓を示す唯一の形——meta の文字列には卓を混ぜない。
 */
export function TableBadge({ tableId }: { readonly tableId: string | null | undefined }) {
  if (tableId === null || tableId === undefined) return null;
  return (
    <span
      aria-label={`Table ${tableId}`}
      className="inline-flex h-4 min-w-4 flex-none items-center justify-center rounded-[0.25rem] bg-ink/15 px-1 font-mono text-[0.625rem] leading-none font-bold text-ink tabular-nums"
    >
      {tableId}
    </span>
  );
}

/** 茹で加減の語。卓は入れない（バッジが担う・TableBadge）、釜も入れない（釜の位置は SlotGlyph が担う）。 */
export function metaOf(order: OrderItem | null): string {
  return order === null ? "Ad hoc" : FIRMNESS_LABEL[order.firmness];
}

/**
 * 釜の位置の小さな図（2026-09-17）。釜のミニマップと同じ幾何（ユニットごとに 2 列 × 3 段・ユニットは横に並ぶ）で、
 * この Timer が占める釜だけを塗る。`Slot 4` と綴らず、位置で読ませる——ミニマップと見比べれば同じ形が同じ場所に在る。
 * 読み上げは `Slot 4` / `Slot 4+5`。
 */
export function SlotGlyph({
  slotIds,
  unitCount,
}: {
  readonly slotIds: readonly string[];
  readonly unitCount: number;
}) {
  const occupied = new Set(slotIds.map(slotOf));
  const rows = SLOTS_PER_UNIT / 2;
  const cols = unitCount * 2;
  return (
    <span
      role="img"
      aria-label={`Slot ${slotIds.join("+")}`}
      className="grid flex-none gap-px"
      style={{ gridTemplateColumns: `repeat(${cols}, 0.3125rem)` }}
    >
      {Array.from({ length: rows * cols }, (_cell, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        const slot = Math.floor(col / 2) * SLOTS_PER_UNIT + row * 2 + (col % 2);
        return (
          <span
            key={slot}
            className={cn(
              "h-[0.3125rem] w-[0.3125rem] rounded-[1px]",
              occupied.has(slot) ? "bg-current" : "bg-current/20",
            )}
          />
        );
      })}
    </span>
  );
}

function WaitingCard({
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
    >
      <Card
        name={displayName(order)}
        tint={noodleColor(order.noodleType)}
        figure={wait.text}
        figureClass={wait.className}
        meta={metaOf(order)}
        table={order.tableId}
        returned={order.interruptedAt !== null}
        className={entry.startAt !== null ? "border-running/50" : undefined}
      />
    </button>
  );
}

/**
 * Boiling のタイムライン。**0s の線**が「いま」で、その下が未来（残り時間）、その上が茹で上がった札の帯である。
 * 走行中の札は 0s から残り時間に比例した高さに置かれ、時刻が進むほど線へ向かって上へ流れ、上がると線を越えて
 * 帯へ移る。帯の中は上がった順（長く放置されているものが左）に横へ並び、幅を超えれば折り返す。
 *
 * 0s から下は 7 分（TIMELINE_WINDOW_SEC）の窓で、それより先の札は窓の下の帯（`7m+`）に上がる順で並べる——0s の上の帯と
 * 同じ形で、時系列の位置を持たない。7 分を切った瞬間に帯を出て窓の最下段に現れ、以後は上へ流れる。
 *
 * 尺度はレーンの実寸を ResizeObserver で測って導き、上下の帯を除いた高さいっぱいを 7 分とする。同じ頃に上がる走行中の札は
 * 横の列へ避ける（timelinePlacements）。札の幅は列数に合わせてレーン幅へ収め、下限を割る並列度だけ横スクロールへ逃がす。
 */
function BoilingTimeline({
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
  const { width: frameWidth, height: frameHeight } = useMeasuredSize(frameRef);
  // 上がった札（上の帯）・窓の中の走行中・7 分より先（下の帯）に分ける。entries は endTime 昇順。
  const boiled = entries.filter((entry) => entry.remainingMs === 0);
  const running = entries.filter(
    (entry) => entry.remainingMs > 0 && entry.remainingMs <= TIMELINE_WINDOW_MS,
  );
  const far = entries.filter((entry) => entry.remainingMs > TIMELINE_WINDOW_MS);

  // 尺度・札の幅・帯の高さは互いに依るので二段で決める。
  //   1 段目: 帯を最大幅の札で見積もった尺度で走行中の列数を数え、その列数と帯の枚数からレーン幅に収まる札の幅を採る
  //           （上限・下限で挟む。下限を割る並列度だけ横スクロールへ逃がす）。
  //   2 段目: その幅で上下の帯の折り返しと高さを確定し、残りの高さいっぱいを 7 分として尺度と配置を確定する。
  const laneWidth = Math.max(frameWidth - AXIS_PX, BOILING_CARD_WIDTH_MIN_PX);
  const rowsOf = (count: number, perRow: number) => Math.ceil(count / Math.max(1, perRow));
  const perRowAtMax = Math.floor(laneWidth / (BOILING_CARD_WIDTH_MAX_PX + GAP_PX));
  const bandOf = (rows: number) => (rows === 0 ? 0 : rows * (BOILING_CARD_PX + GAP_PX));
  const scaleOf = (topBand: number, bottomBand: number) => {
    const between = frameHeight - topBand - bottomBand;
    return between > 0 ? between / TIMELINE_WINDOW_SEC : FALLBACK_PX_PER_SECOND;
  };
  const columns = timelinePlacements(
    running,
    scaleOf(
      bandOf(rowsOf(boiled.length, perRowAtMax)) + ZERO_LINE_PAD_PX,
      bandOf(rowsOf(far.length, perRowAtMax)) + (far.length > 0 ? FAR_LINE_PAD_PX : 0),
    ),
    BOILING_CARD_PX,
    GAP_PX,
  ).columns;
  const lanes = Math.max(1, columns, Math.min(Math.max(boiled.length, far.length), 4));
  const fitted = (laneWidth - (lanes - 1) * GAP_PX) / lanes;
  const cardWidth = Math.round(
    Math.min(BOILING_CARD_WIDTH_MAX_PX, Math.max(BOILING_CARD_WIDTH_MIN_PX, fitted)),
  );
  const stride = cardWidth + GAP_PX;
  const perRow = Math.max(1, Math.floor((laneWidth + GAP_PX) / stride));
  const topBand = bandOf(rowsOf(boiled.length, perRow)) + ZERO_LINE_PAD_PX;
  const bottomBand = far.length > 0 ? FAR_LINE_PAD_PX + bandOf(rowsOf(far.length, perRow)) : 0;
  const pxPerSecond = scaleOf(topBand, bottomBand);
  const placed = timelinePlacements(running, pxPerSecond, BOILING_CARD_PX, GAP_PX).placements;
  const windowPx = Math.max(
    frameHeight - topBand - bottomBand,
    TIMELINE_WINDOW_SEC * pxPerSecond,
    placed.reduce((max, { top }) => Math.max(max, top + BOILING_CARD_PX + GAP_PX), 0),
  );
  const farTop = topBand + windowPx;
  const height = farTop + bottomBand;
  const width =
    Math.max(lanes, Math.min(Math.max(boiled.length, far.length), perRow)) * stride + AXIS_PX;
  const minutes = TIMELINE_WINDOW_SEC / 60;

  /** 帯の中の 1 枚の位置（左から上がる順・幅で折り返す）。 */
  const bandPosition = (index: number) => ({
    top: Math.floor(index / perRow) * (BOILING_CARD_PX + GAP_PX),
    left: AXIS_PX + (index % perRow) * stride,
    width: cardWidth,
    height: BOILING_CARD_PX,
  });

  return (
    <div ref={frameRef} className="min-h-0 flex-1">
      <div className="relative" style={{ height, minWidth: width }}>
        {/* 上の帯：茹で上がった札。0s の線の上に、上がった順で左から並ぶ。 */}
        {boiled.map((entry, index) => (
          <div key={entry.timer.id} className="absolute" style={bandPosition(index)}>
            <BoilingCard
              entry={entry}
              noodleColor={noodleColor}
              unitCount={unitCount}
              onPick={onPick}
            />
          </div>
        ))}
        {/* 0s の線＝いま。上がった札はこの線を越えて帯へ移る。 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 left-0 border-t-2 border-ink/70"
          style={{ top: topBand }}
        >
          <span className="absolute -top-[0.75rem] left-0.5 font-mono text-[0.625rem] font-bold text-ink/80">
            0s
          </span>
        </div>
        {/* 準備帯：0s と準備線（90s）の間。ここに入った丼が棚に並ぶ。 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 left-0 bg-[color-mix(in_oklab,var(--color-ink)_6%,transparent)]"
          style={{ top: topBand, height: (BOWL_PREP_LEAD_MS / 1000) * pxPerSecond }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 left-0 border-t border-ink/50"
          style={{ top: topBand + (BOWL_PREP_LEAD_MS / 1000) * pxPerSecond }}
        >
          <span className="absolute -top-[0.7rem] left-0.5 font-mono text-[0.625rem] text-ink/70">
            {BOWL_PREP_LEAD_MS / 1000}s
          </span>
        </div>
        {/* 時間軸：0s から窓の下端まで、分の目盛りと左端の軸。 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-0 border-l border-line"
          style={{ top: topBand, height: windowPx, width: AXIS_PX }}
        />
        {Array.from({ length: minutes }, (_, k) => k + 1).map((minute) => (
          <div
            key={minute}
            aria-hidden="true"
            className="pointer-events-none absolute right-0 left-0 border-t border-dashed border-line/70"
            style={{ top: topBand + minute * 60 * pxPerSecond }}
          >
            <span className="absolute -top-[0.7rem] left-0.5 font-mono text-[0.625rem] text-muted/70">
              {minute}m
            </span>
          </div>
        ))}
        {/* 走行中の札：0s から残り時間ぶん下。 */}
        {placed.map(({ entry, top, column }) => (
          <div
            key={entry.timer.id}
            className="absolute"
            style={{
              top: topBand + top,
              left: AXIS_PX + column * stride,
              width: cardWidth,
              height: BOILING_CARD_PX,
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
        {/* 下の帯：7 分より先の札。時系列の位置を持たず、上がる順で左から並ぶ。 */}
        {far.length > 0 && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute right-0 left-0 border-t border-dashed border-muted/60"
            style={{ top: farTop }}
          >
            <span className="absolute -top-[0.7rem] left-0.5 font-mono text-[0.625rem] text-muted/70">
              {minutes}m+
            </span>
          </div>
        )}
        {far.map((entry, index) => {
          const position = bandPosition(index);
          return (
            <div
              key={entry.timer.id}
              className="absolute"
              style={{ ...position, top: farTop + FAR_LINE_PAD_PX + position.top }}
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
 * 要素の内寸（px）を ResizeObserver で追う。測れない環境（ResizeObserver 不在）では 0 のまま——呼び手が代替尺度へ落ちる。
 * 値は描画の入力であって導出の芯ではない（尺度・札の幅は毎描画この値から計算し直す）。
 */
export function useMeasuredSize(ref: React.RefObject<HTMLElement | null>): {
  readonly width: number;
  readonly height: number;
} {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Boiling のコンパクトな札。名（卓のバッジ付き）と残り（または上がってからの経過）の 2 行、右下に釜の位置の図。 */
export function BoilingCard({
  entry,
  noodleColor,
  unitCount,
  onPick,
}: {
  readonly entry: BoilingEntry;
  readonly noodleColor: NoodleColor;
  /** 釜の位置の図（SlotGlyph）の幾何。 */
  readonly unitCount: number;
  /** 注文を持つ札のタップで卓を選ぶ。無ければ札は押せない（アドホックは常に押せない）。 */
  readonly onPick?: ((order: OrderItem) => void) | undefined;
}) {
  const boiled = entry.remainingMs === 0;
  const prepping = !boiled && entry.remainingMs <= BOWL_PREP_LEAD_MS;
  const name = entry.order === null ? entry.timer.noodleType : displayName(entry.order);
  const table = entry.order?.tableId ?? null;
  const frame = cn(
    "relative flex h-full w-full flex-col justify-center gap-px rounded-[0.5rem] border bg-panel2 px-2",
    boiled ? "border-danger" : prepping ? "border-ink/60" : "border-running/40",
  );
  const body = (
    <>
      {/* 釜の位置の図は右下に固定（残りの数字の行は右に余白を取って重ねない）。 */}
      <span className="absolute right-1 bottom-1 flex text-muted">
        <SlotGlyph slotIds={entry.timer.slotIds} unitCount={unitCount} />
      </span>
      <span className="flex min-w-0 items-baseline gap-1">
        <TableBadge tableId={table} />
        <span
          className="truncate text-xs leading-tight font-bold"
          style={{ color: noodleColor(entry.timer.noodleType) }}
        >
          {name}
        </span>
      </span>
      <span
        className={cn(
          "pr-7 font-mono text-sm leading-tight tabular-nums",
          boiled ? "animate-badge-blink font-bold text-danger" : "text-running",
        )}
      >
        {boiled ? `UP +${formatRemaining(entry.overdueMs)}` : formatRemaining(entry.remainingMs)}
      </span>
    </>
  );
  const { order } = entry;
  if (onPick !== undefined && order !== null) {
    return (
      <button
        type="button"
        onClick={() => onPick(order)}
        aria-label={`Set table — ${name}`}
        title={name}
        className={cn(frame, "cursor-pointer text-left hover:brightness-110")}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={frame} title={name}>
      {body}
    </div>
  );
}

/**
 * 丼のドック。準備中（上がりまで BOWL_PREP_LEAD_MS 以下）から Done に入るまでの丼を、**右端が最も早い**順で横に並べる
 * （時系列の昇順を右から）。新しい丼は左から入って右へ流れ、上がって盛りつけ中になっても残り、Done の確認で右端から抜ける。
 * 段階は色で分ける——準備中は白い縁、上がり待ちは赤の点滅、盛りつけ中は緑（Plating の札と同じ語彙）。
 *
 * **丼が無いときは細い帯、在るときに広がる。** 高さの変化は盤面の中で起こり（fixed ではなく in-flow）、上のレーンが縮む
 * ——覆って隠さない。タイムラインの尺度は実寸から導くので、広がれば 7 分窓がその分だけ詰まる。
 * 1 タイル = 1 杯。収まらない分は左端に `+n` で畳む——隠れるのは遠い未来だけで、近い丼は隠れない。
 * 盛りつけ中の札だけが押せて Done の確認（onAck）に写る。準備中・上がり待ちは操作を持たない。
 */
export function BowlDock({
  bowls,
  noodleColor,
  onAck,
  grow = false,
}: {
  readonly bowls: readonly Bowl[];
  readonly noodleColor: NoodleColor;
  readonly onAck: (key: ItemKey) => void;
  /** 横並びの行の中で残りの幅を取るか（横版が Done の小片と同じ行に置くときに真）。 */
  readonly grow?: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const { width } = useMeasuredSize(frameRef);
  const stride = SHELF_TILE_WIDTH_PX + SHELF_GAP_PX;
  // 収まる枚数（幅が測れないうちは全部）。溢れるときは 1 枠を `+n` に譲る。
  const capacity =
    width > 0 ? Math.max(1, Math.floor((width + SHELF_GAP_PX) / stride)) : bowls.length;
  const shown = bowls.length > capacity ? bowls.slice(0, capacity - 1) : bowls;
  const hidden = bowls.length - shown.length;
  const open = bowls.length > 0;
  const toConfirm = bowls.filter((bowl) => bowl.kind === "plating").length;
  return (
    <section
      aria-label="Bowls"
      aria-expanded={open}
      className={cn(
        "flex items-stretch gap-3 rounded-[0.875rem] border px-[clamp(0.5rem,1vw,0.75rem)] transition-[height,border-color] duration-300 ease-out",
        grow ? "min-w-0 flex-1" : "flex-none",
        open ? "h-[5.75rem] py-2" : "h-[2.25rem] items-center border-line bg-panel py-0",
        open && (toConfirm > 0 ? "border-boiled/50 bg-panel" : "border-ink/40 bg-panel"),
      )}
    >
      <h2
        className={cn(
          "m-0 flex w-16 flex-none flex-col justify-center text-xs font-bold tracking-wide uppercase",
          toConfirm > 0 ? "text-boiled" : "text-muted",
        )}
      >
        <span>{toConfirm > 0 ? "Done?" : "Bowls"}</span>
        {open && (
          <span className="font-mono text-sm tabular-nums">
            {toConfirm > 0 ? `${toConfirm} / ${bowls.length}` : bowls.length}
          </span>
        )}
      </h2>
      {/* 右端が最も早い丼。DOM の並びは時系列の昇順で、row-reverse が右から左へ置く。 */}
      <div
        ref={frameRef}
        className="flex min-w-0 flex-1 flex-row-reverse items-stretch overflow-hidden"
        style={{ gap: SHELF_GAP_PX }}
      >
        {!open && <p className="m-0 self-center text-xs text-muted">No bowls</p>}
        {open &&
          shown.map((bowl) => (
            <BowlTile key={bowlKey(bowl)} bowl={bowl} noodleColor={noodleColor} onAck={onAck} />
          ))}
        {hidden > 0 && (
          <span
            className="flex flex-none items-center justify-center rounded-[0.5rem] border border-dashed border-line px-2 font-mono text-sm text-muted tabular-nums"
            aria-label={`${hidden} more bowls`}
          >
            +{hidden}
          </span>
        )}
      </div>
    </section>
  );
}

/** 棚のタイルの鍵。Timer と品目は別の空間なので段階の接頭で分ける。 */
function bowlKey(bowl: Bowl): string {
  return bowl.kind === "boiling" ? `t:${bowl.entry.timer.id}` : `o:${itemKeyOf(bowl.entry.order)}`;
}

/**
 * タレの語＝品名。サーバが被せた札（`shortName`）があればそれ、無ければ POS 申告の品名、それも無ければ麺種。
 * 麺量は付けない（棚ではサイズを別の行に大きく出す）。displayName と同じく、札は「あるかもしれないもの」として読む。
 */
function tareName(order: WireOrderItem): string {
  return (order.shortName ?? order.itemName ?? order.noodleType).normalize("NFKC");
}

/**
 * ドックの 1 杯。**サイズが主**（丼を取る動作が先）、次にタレ（品名）と卓、右下に時間。`普通` は消さない——ここでは
 * 「普通の丼」という指示そのものである（釜の札の displayName とは意図的に語を分ける）。注文を持たない Timer（アドホック）
 * は麺種を名に、サイズは `—`。時間は段階で変わる——準備中は上がりまでの残り、上がり待ちは `UP +経過`、盛りつけ中は
 * オーダーからの待ち（Plating の札と同じ数字）。盛りつけ中だけがボタンで、タップが Done の確認になる。
 */
function BowlTile({
  bowl,
  noodleColor,
  onAck,
}: {
  readonly bowl: Bowl;
  readonly noodleColor: NoodleColor;
  readonly onAck: (key: ItemKey) => void;
}) {
  const order = bowl.entry.order;
  const noodleType =
    bowl.kind === "boiling" ? bowl.entry.timer.noodleType : bowl.entry.order.noodleType;
  const phase: "prep" | "up" | "plating" =
    bowl.kind === "plating" ? "plating" : bowl.entry.remainingMs === 0 ? "up" : "prep";
  // サイズの語に玉数を添える（noodle-portions 判断 7）。注文を持たない Timer はどちらも無い。
  const size =
    order === null
      ? "—"
      : `${order.sizeName?.normalize("NFKC") ?? "—"} ${portionsLabel(order.portions)}`;
  const tare = order === null ? noodleType : tareName(order);
  const table = order?.tableId ?? null;
  // 数字と色は段階で決まる——盛りつけ中はオーダーからの待ち（警告の色分けは waitFigure・穏やかなら緑）、
  // 上がり待ちは赤の点滅、準備中は残り。
  const { figure, figureClass } =
    bowl.kind === "plating"
      ? platingFigure(bowl.entry.waitingMs)
      : phase === "up"
        ? {
            figure: `UP +${formatRemaining(bowl.entry.overdueMs)}`,
            figureClass: "animate-badge-blink font-bold text-danger",
          }
        : { figure: formatRemaining(bowl.entry.remainingMs), figureClass: "text-running" };
  const body = (
    <>
      <span className="flex min-w-0 items-baseline gap-1">
        <TableBadge tableId={table} />
        <span className="truncate text-base leading-tight font-extrabold text-ink">{size}</span>
      </span>
      <span
        className="truncate text-xs leading-tight font-bold"
        style={{ color: noodleColor(noodleType) }}
      >
        {tare}
      </span>
      <span className="flex items-baseline justify-end text-[0.6875rem] leading-tight text-muted">
        <span className={cn("flex-none font-mono tabular-nums", figureClass)}>{figure}</span>
      </span>
    </>
  );
  const frame = cn(
    "flex flex-none flex-col justify-between rounded-[0.5rem] border bg-panel2 px-2 py-1",
    phase === "up" ? "border-danger" : phase === "plating" ? "border-boiled/70" : "border-ink/60",
  );
  if (bowl.kind === "plating") {
    const name = displayName(bowl.entry.order);
    return (
      <button
        type="button"
        onClick={() => onAck(itemKeyOf(bowl.entry.order))}
        aria-label={`Mark done — ${name}`}
        className={cn(frame, "cursor-pointer text-left hover:brightness-110 active:scale-[0.98]")}
        style={{ width: SHELF_TILE_WIDTH_PX }}
        title={`${size} ${tare}`}
        data-phase={phase}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      className={frame}
      style={{ width: SHELF_TILE_WIDTH_PX }}
      title={`${size} ${tare}`}
      data-phase={phase}
    >
      {body}
    </div>
  );
}

/** Plating の札。全面がボタンで、タップが「盛りつけ済み」の確認になる。 */
function PlatingCard({
  entry,
  noodleColor,
  onAck,
}: {
  readonly entry: PlatingEntry;
  readonly noodleColor: NoodleColor;
  readonly onAck: () => void;
}) {
  const { order } = entry;
  const name = displayName(order);
  return (
    <button
      type="button"
      onClick={onAck}
      aria-label={`Mark plated — ${name}`}
      className="flex-none cursor-pointer rounded-[0.625rem] border-0 bg-transparent p-0 text-left hover:brightness-110"
    >
      <Card
        name={name}
        tint={noodleColor(order.noodleType)}
        figure={formatRemaining(entry.waitingMs)}
        figureClass="text-boiled"
        meta={metaOf(order)}
        table={order.tableId}
        className="border-boiled/50"
      />
    </button>
  );
}

/** Done のレーン。既定は件数だけの細い帯で、見出しのタップで展開する。 */
export function DoneLane({
  entries,
  open,
  onToggle,
  noodleColor,
}: {
  readonly entries: readonly DoneEntry[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly noodleColor: NoodleColor;
}) {
  return (
    <section
      aria-label="Done"
      className={cn(
        "flex min-h-0 flex-col gap-2 rounded-[0.875rem] border border-line bg-panel p-[clamp(0.5rem,1vw,0.75rem)]",
        !open && "w-12 items-center",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "m-0 flex flex-none cursor-pointer items-baseline gap-2 border-0 bg-transparent p-0 text-xs font-bold tracking-wide text-muted uppercase",
          open ? "w-full justify-between" : "flex-col items-center",
        )}
      >
        <span className={cn(!open && "[writing-mode:vertical-rl]")}>Done</span>
        <span className="font-mono tabular-nums">{entries.length}</span>
      </button>
      {open && (
        <div className="flex min-h-0 flex-1 flex-col gap-[6px] overflow-x-hidden overflow-y-auto overscroll-contain">
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
              className="opacity-70"
            />
          ))}
        </div>
      )}
    </section>
  );
}
