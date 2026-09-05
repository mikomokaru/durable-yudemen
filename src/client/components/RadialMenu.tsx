// client/components/RadialMenu.tsx — タッチ地点を中心に麺種プリセットを円弧状に展開するセレクタ。
// 「Start タッチ → 種類を円形展開 → 選んで自動スタート」フローの選択段を担う。選択＝開始であり、
// このコンポーネント自身は状態を持たない（開閉アニメの shown だけがローカルな表示都合）。表示は
// 受信した noodlePresets（サーバ権威の StoreConfig 由来）をそのまま咲かせ、選んだ preset を onSelect で
// 親へ返すだけ。花びらの背景は noodleType からの導出色（noodleColor）で麺ごとに個性を出し、文字は統一の暗色。
// createPortal で body 直下に描き、スロットの overflow / スタッキングに縛られない。
//
// 花びら（アドホック開始）の反対側に、店舗全体の待ち行列を縦の帯として並べる（lift-group-display
// Requirement 4）。提案されていない品目も釜から品目として始められ、待ち行列に品目が残らない。帯の行は
// 押した釜から組めた釜の集合（slotIds）を親から受け取るだけで、ここでは占有も距離も判定しない——組めない
// 行（null）は選べない形で示し、押しても何も起きない（AC 4.5 / 4.9）。degraded では親が空を渡し、帯は
// 描かれない（AC 4.8）。花びらの項目数と幾何は変えない（AC 4.6）。
//
// 花びらと帯の座標は実行時に変わるためインライン style（transform / transitionDelay / left / right / top / bottom）で渡す。
// Tailwind でも「実行時に変わる値」はインラインが正解で、無理にクラス化しない（design-system の方針）。

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../cn";
import type { PendingOrder } from "../../domain/order";
import type { NoodlePreset } from "../../domain/store";
import type { NonEmptyArray } from "../../domain/timer";
import { FIRMNESS_LABEL } from "./firmness";
import type { NoodleColor } from "./noodleColor";
import { displayName } from "./queueDisplay";

/** 待ち行列の帯の 1 行。品目の事実と、押した釜から組めた釜の集合。 */
export interface RadialQueueItem {
  readonly order: PendingOrder;
  /**
   * 押した釜から組めた釜の集合（起点の釜を先頭に slotSpan 個）。null は組めない（選べない形で示す）。
   *
   * 起点の釜が埋まった・許容距離の内側に空きが足りない、のどちらも null に畳む——理由の内訳を現場へ
   * 持ち出さない（提案なしの行と同じ判断）。導出は親（pairSlots）が描画ごとに view から行う。
   */
  readonly slotIds: NonEmptyArray<string> | null;
}

interface RadialMenuProps {
  /** タッチした地点（ビューポート座標の中心）。null で閉じる。 */
  readonly anchor: { readonly x: number; readonly y: number } | null;
  /** 円弧状に展開する麺種プリセット（3〜6 個を想定）。 */
  readonly presets: readonly NoodlePreset[];
  /** noodleType → 背景色の resolver（花びらの背景塗りに用いる。SlotCard と同じ割り当てを共有する）。 */
  readonly colorOf: NoodleColor;
  /** 店舗全体の待ち行列（到着順）。degraded では空を渡す（帯を描かない・AC 4.8）。 */
  readonly queue: readonly RadialQueueItem[];
  /** 中心ハブの上に出すラベル（例: "Slot 0"）。 */
  readonly label?: string | undefined;
  /** 展開半径(px)。既定 132。 */
  readonly radius?: number;
  /** プリセットを選んだとき（＝そのまま自動スタート）。 */
  readonly onSelect: (preset: NoodlePreset) => void;
  /**
   * 待ち行列の品目を選んだとき（＝組めた釜で品目として開始）。
   *
   * 受け取るのは組めた行だけ——slotIds を非空へ絞った形で渡すので、親は null を検査しない（帯が組めない行を
   * 呼ばないことと、親が null を受けないことが、一つの型で言われる）。
   */
  readonly onSelectItem: (
    item: RadialQueueItem & { readonly slotIds: NonEmptyArray<string> },
  ) => void;
  /** キャンセル（背景タップ / ×ハブ / Esc）。 */
  readonly onClose: () => void;
}

/** 花びらの半径（rem）。花びらのボタンは 5.75rem 四方で、その中心が半径 radius の円周に載る。 */
const PETAL_RADIUS_REM = 2.875;
/** 帯の幅の上限（rem）。レール（w-32 = 8rem）より広いのは、帯が卓まで 1 行に収める語を持つため。 */
const COLUMN_MAX_WIDTH_REM = 12;
/** 帯の幅の下限（rem）。反対側の余白がこれに満たなければ帯を弧の上下へ逃がす。 */
const COLUMN_MIN_WIDTH_REM = 8;

/**
 * 帯の配置。花びらの反対側の余白に収まるなら側に、収まらなければ弧の上下の広い側に置く。
 *
 * どちらも「画面端からの inset」と「弧に沿う軸の位置」と「余白いっぱいの高さ」で言う。値はすべて px で持ち、
 * 帯の内側の縁（edge 側）だけ花びらの半径（rem）を calc で足す——花びらは rem で描かれており、px に写せば
 * ルートのフォントサイズが変わったときに帯が花びらへ食い込む。
 */
type ColumnLayout =
  | {
      readonly at: "side";
      readonly edge: "left" | "right";
      readonly inset: number;
      readonly top: number;
      readonly height: number;
      readonly width: number;
    }
  | {
      readonly at: "vertical";
      readonly edge: "top" | "bottom";
      readonly inset: number;
      readonly left: number;
      readonly height: number;
      readonly width: number;
    };

/**
 * タッチした地点を中心に麺種を円弧状に展開するラジアルメニュー。
 * 項目数(3〜6)に応じて弧の広がりが変わり、画面端では内側に開く。
 */
export function RadialMenu({
  anchor,
  presets,
  colorOf,
  queue,
  label,
  radius = 132,
  onSelect,
  onSelectItem,
  onClose,
}: RadialMenuProps) {
  const [shown, setShown] = useState(false);

  // マウント後に開く（中心 → 放射のアニメ）。
  useEffect(() => {
    if (!anchor) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [anchor]);

  // Esc で閉じる。
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anchor, onClose]);

  const layout = useMemo(() => {
    if (!anchor) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const n = presets.length;
    const margin = radius + 60;
    // 咲く余白を確保するため、中心を画面内にクランプ。
    const cx = Math.max(margin, Math.min(vw - margin, anchor.x));
    const cy = Math.max(margin, Math.min(vh - margin, anchor.y));
    // 右半分なら左へ、左半分なら右へ開く（画面端で切れない）。
    const base = anchor.x > vw / 2 ? Math.PI : 0;
    const spread = Math.min(Math.PI * 1.5, (n - 1) * 0.62 + 0.4);
    const petals = presets.map((preset, k) => {
      const ang = base + (n > 1 ? (k - (n - 1) / 2) * (spread / (n - 1)) : 0);
      return {
        preset,
        x: Math.cos(ang) * radius,
        y: Math.sin(ang) * radius,
        delay: k * 35,
      };
    });
    // 帯は花びらの反対側——右へ咲く（base === 0）なら左、左へ咲くなら右。配置は base から導き、判定を
    // 二度書かない。反対側の余白は画面端から弧の外縁（radius + 花びらの半径）まで。
    const rem = rootFontSizePx();
    const petalRadius = PETAL_RADIUS_REM * rem;
    const room = base === 0 ? cx - radius - petalRadius : vw - (cx + radius + petalRadius);
    const column: ColumnLayout =
      room >= COLUMN_MIN_WIDTH_REM * rem
        ? {
            at: "side",
            edge: base === 0 ? "right" : "left",
            inset: base === 0 ? vw - (cx - radius) : cx + radius,
            top: cy - radius - petalRadius,
            height: 2 * (radius + petalRadius),
            width: Math.min(COLUMN_MAX_WIDTH_REM * rem, room),
          }
        : verticalColumn(
            cx,
            cy,
            radius,
            petalRadius,
            Math.min(COLUMN_MAX_WIDTH_REM * rem, vw),
            vw,
            vh,
          );
    return { cx, cy, petals, column };
  }, [anchor, presets, radius]);

  if (!anchor || !layout) return null;

  const { column } = layout;

  return createPortal(
    <div
      className="fixed inset-0 z-[60]"
      role="dialog"
      aria-modal="true"
      aria-label="Select noodle"
    >
      {/* 背景 */}
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-[rgba(8,6,4,.55)] backdrop-blur-[0.1875rem] transition-opacity duration-150",
          shown ? "opacity-100" : "opacity-0",
        )}
      />

      {/* ラベル */}
      {label && (
        <div
          style={{ left: layout.cx, top: layout.cy - radius - 30 }}
          className={cn(
            "absolute -translate-x-1/2 -translate-y-1/2 text-[0.75rem] font-bold whitespace-nowrap",
            "tracking-[.06em] text-muted uppercase transition-opacity delay-[50ms] duration-200",
            shown ? "opacity-100" : "opacity-0",
          )}
        >
          {label}
        </div>
      )}

      {/* 中心ハブ（キャンセル） */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Cancel"
        style={{ left: layout.cx, top: layout.cy }}
        className={cn(
          "absolute -mt-[1.8125rem] -ml-[1.8125rem] grid h-[3.625rem] w-[3.625rem] place-items-center rounded-full",
          "cursor-pointer border border-line bg-panel text-2xl font-bold text-muted",
          "shadow-[0_0.375rem_1.25rem_rgba(0,0,0,.45)] transition duration-200 ease-[cubic-bezier(.2,.9,.3,1.3)]",
          shown ? "scale-100 opacity-100" : "scale-[.4] opacity-0",
        )}
      >
        ×
      </button>

      {/* 放射状に咲く選択肢 */}
      {layout.petals.map(({ preset, x, y, delay }) => (
        <button
          key={preset.noodleType}
          type="button"
          onClick={() => onSelect(preset)}
          style={{
            left: layout.cx,
            top: layout.cy,
            backgroundColor: colorOf(preset.noodleType),
            transitionDelay: `${delay}ms`,
            transform: shown ? `translate(${x}px, ${y}px) scale(1)` : "translate(0, 0) scale(0.3)",
          }}
          className={cn(
            "absolute top-0 left-0 -mt-[2.875rem] -ml-[2.875rem] flex h-[5.75rem] w-[5.75rem] flex-col items-center justify-center gap-0.5",
            "cursor-pointer rounded-full border border-line text-[#15120c]",
            "shadow-[0_0.5rem_1.375rem_rgba(0,0,0,.4)] hover:border-ink active:brightness-105",
            "transition-[transform,opacity,border-color] duration-[260ms] ease-[cubic-bezier(.2,.9,.3,1.25)]",
            shown ? "opacity-100" : "opacity-0",
          )}
        >
          {/* 花びらの背景が麺のキャラクター色、文字は統一の暗色（前景は統一・背景で識別）。 */}
          <span className="text-[1rem] leading-none font-extrabold">{preset.noodleType}</span>
          <span className="font-mono text-[0.8125rem] font-medium opacity-70">
            {preset.boilSeconds.normal}s
          </span>
        </button>
      ))}

      {/* 待ち行列の帯。0 件（待ち行列が空・degraded）は帯そのものが不在——描くか否かはこの 1 箇所で決める。 */}
      {queue.length > 0 && (
        <ul
          aria-label="Waiting orders"
          style={
            column.at === "side"
              ? {
                  [column.edge]: `calc(${column.inset}px + ${PETAL_RADIUS_REM}rem)`,
                  top: column.top,
                  maxHeight: column.height,
                  width: column.width,
                }
              : {
                  [column.edge]: `calc(${column.inset}px + ${PETAL_RADIUS_REM}rem)`,
                  left: column.left,
                  maxHeight: column.height,
                  width: column.width,
                }
          }
          className={cn(
            "absolute m-0 flex list-none flex-col gap-1 p-0",
            "overflow-x-hidden overflow-y-auto overscroll-contain",
            "transition-opacity delay-[50ms] duration-200",
            shown ? "opacity-100" : "opacity-0",
          )}
        >
          {queue.map((item) => (
            <QueueRow
              key={`${item.order.externalOrderId}-${item.order.itemIndex}`}
              item={item}
              colorOf={colorOf}
              onSelectItem={onSelectItem}
            />
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}

/**
 * 待ち行列の帯の 1 行。品目名（麺量）・茹で加減・卓を、レールと同じ語で示す（時刻は出さない）。
 *
 * 組めない行は aria-disabled と薄い塗りで「選べない」を示し、押しても何も起きない（AC 4.5 / 4.9）。
 * 開始されない品目を選べる形で示さない、の裏返しである。
 */
function QueueRow({
  item,
  colorOf,
  onSelectItem,
}: {
  readonly item: RadialQueueItem;
  readonly colorOf: NoodleColor;
  readonly onSelectItem: RadialMenuProps["onSelectItem"];
}) {
  const { order, slotIds } = item;
  const selectable = slotIds !== null;
  return (
    <li className="flex-none">
      {/* 組めない行は onClick を持たない——押しても何も起きないのは分岐ではなく口の不在による。 */}
      <button
        type="button"
        aria-disabled={!selectable}
        onClick={selectable ? () => onSelectItem({ order, slotIds }) : undefined}
        className={cn(
          "block w-full rounded-[0.625rem] border border-line bg-panel px-3 py-[0.4375rem] text-left text-sm leading-tight",
          "shadow-[0_0.375rem_1.25rem_rgba(0,0,0,.45)]",
          selectable
            ? "cursor-pointer hover:border-ink active:brightness-105"
            : "cursor-default opacity-40",
        )}
      >
        {/* 麺種色はインライン style で与える。色の出所は釜カード・花びらと共有する resolver だけである。 */}
        <span className="font-bold" style={{ color: colorOf(order.noodleType) }}>
          {displayName(order)}
        </span>
        <span className="text-muted">
          {` · ${FIRMNESS_LABEL[order.firmness]}`}
          {order.tableId !== null && ` · Table ${order.tableId}`}
        </span>
      </button>
    </li>
  );
}

/**
 * 弧の上下の配置。上下の余白（画面端から弧の外縁まで）を比べ、広い側に置く。帯は中心に揃え、画面の横幅から
 * 出ないように寄せる。
 *
 * 「下」に固定してはならない。中心は margin（radius + 60）で画面内へクランプされるだけなので、下段の釜から
 * 開けば弧の下に残るのは margin − radius − 花びらの半径 ≈ 14px で、帯は 1 行も描けない（側の余白を margin と
 * 読んだときと同じ罠が縦軸に移る）。上下の余白の和は画面の高さから弧の直径を引いた分で一定ゆえ、広い側は
 * 常にその半分以上を持つ。弧の広がりは最大 1.5π で base の反対側は上下とも空くため、どちらに置いても花びらと
 * 重ならない。帯は弧の側の縁を弧の外縁に揃える（下なら top・上なら bottom）ので、行が少なくても先頭の行は
 * 弧の近くに来る（上に置いたとき、行が画面の上端へ離れない）。
 */
function verticalColumn(
  cx: number,
  cy: number,
  radius: number,
  petalRadius: number,
  width: number,
  vw: number,
  vh: number,
): ColumnLayout {
  const left = Math.min(Math.max(cx - width / 2, 0), vw - width);
  const above = cy - radius - petalRadius;
  const below = vh - (cy + radius + petalRadius);
  return below >= above
    ? { at: "vertical", edge: "top", inset: cy + radius, left, height: below, width }
    : { at: "vertical", edge: "bottom", inset: vh - (cy - radius), left, height: above, width };
}

/** ルートのフォントサイズ（px）。rem で描かれた花びらの寸法を px の座標系に写すために読む。読めなければ 16。 */
function rootFontSizePx(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}
