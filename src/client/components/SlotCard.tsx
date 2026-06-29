// client/components/SlotCard.tsx — 担当スロット 1 つの表示と操作。
// 開始・キャンセル・完了の操作 UI は担当スロットに対してのみ描画される（このコンポーネントは
// 担当スロットの表示状態 SlotDisplay からのみ生成されるため、担当外には現れない／要件12.3）。
// 残りは導出済みの値を受け取って整形するだけ。00:00 固定・負なしは format/clock 側で担保（要件5.6）。
//
// 状態機械: idle（カード全体が開始ボタン・タップでラジアル）→ running（Cancel で中断）→ boiled
// （Complete で明示消し込み）。boiled は「ユーザーが消し込むべき状態」で、Complete までカードに残る。
// 完了後、当該スロットは idle に戻り、直前の調理結果（noodleType）をベストエフォートで一定時間表示する。

import { type CSSProperties, type MouseEvent, useState } from "react";
import { remainingParts } from "../format";
import { cn } from "../cn";
import type { TimerFact } from "../../domain/timer";
import type { SlotDisplay } from "./slotDisplay";
import type { NoodleColor } from "./noodleColor";
import { PlayIcon, StopIcon, LiftIcon } from "./icons";
import { FirmnessCornerControl } from "./FirmnessCornerControl";
import type { Firmness } from "../../domain/firmness";

/** ラジアルメニューを開く中心座標（ビューポート）。 */
type Center = { readonly x: number; readonly y: number };

interface SlotCardProps {
  readonly display: SlotDisplay;
  /** Start タッチ。center = ラジアルメニューを開く中心座標（ビューポート）。 */
  readonly onStart: (slot: number, center: Center) => void;
  readonly onCancel: (timerId: string) => void;
  /** boiled の明示完了（消し込み）。直前結果の記録は親が担う。 */
  readonly onComplete: (slot: number, timer: TimerFact) => void;
  /** idle のときに表示する直前の調理結果（noodleType）。無ければ通常の Ready 表示。 */
  readonly lastResultNoodle?: string | undefined;
  /** noodleType → 前景色の resolver（メニュー順割り当て）。麺名テキストの着色に用いる。 */
  readonly noodleColor: NoodleColor;
  /** 走行中の茹で加減変更（boiling のみ）。サーバが endTime を引き直す。 */
  readonly onAdjust: (timerId: string, firmness: Firmness) => void;
}

/** 要素の矩形中心（ビューポート座標）を返す。ラジアルの展開中心に使う。 */
function centerOf(el: HTMLElement): Center {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

const cardBase = cn(
  "@container relative min-h-0 grid content-center gap-[clamp(0.25rem,1vh,0.625rem)]",
  "rounded-[0.875rem] border border-line bg-panel",
  "p-[clamp(0.625rem,1.6vh,1.125rem)_clamp(0.875rem,1.8vw,1.25rem)]",
  "shadow-[0_0.0625rem_0_rgba(255,255,255,.03)_inset,0_0.5rem_1.5rem_rgba(0,0,0,.35)]",
  "transition-[border-color,box-shadow] duration-200",
);

/** 操作スタック: カード右下に固定。真円ボタン（＋リング）の下に小さなラベルを縦に並べる。 */
const actionStack = cn(
  "absolute bottom-[clamp(0.625rem,1.6vh,1.125rem)] right-[clamp(0.625rem,1.6vw,1.125rem)]",
  "flex flex-col items-center gap-[clamp(0.125rem,0.5vh,0.375rem)]",
);
/** 操作エリア: ボタン＋インジケータを収める正方形。全状態で同形にし、帯を常に確保する（boiling か否かで不変）。 */
const actionSlot = cn(
  "relative grid aspect-square h-[clamp(6rem,13.5vh,7.875rem)] place-items-center",
);
/** ボタン下の操作ラベル（Start / Stop / Complete）。小さく控えめに。 */
const actionLabel =
  "text-[clamp(0.625rem,1.3vh,0.8125rem)] font-bold uppercase tracking-[.08em] leading-none text-muted";
/** 操作ボタン: 操作エリア内に収まる真円。リング内縁と接する大きさ（88%）にして両者の間に隙間を作らない。 */
const actionBtn = cn(
  "grid aspect-square h-[88%] place-items-center rounded-full",
  "cursor-pointer transition active:scale-95",
);
/** 真円ボタン内のピクトグラムの大きさ（円に対して余白を残す）。 */
const actionIcon = "h-[clamp(2.5rem,6vh,3.625rem)] w-auto";
/** 操作エリア（右下の枠）を避けるための本文右余白。テキストが枠の下へ潜らないようにする。 */
const contentPadRight = "pr-[clamp(7rem,15vh,9.125rem)]";

const slotTime = cn(
  "m-0 font-clock font-black leading-[.95] tabular-nums tracking-[.01em]",
);
/** 分=大、秒=分の黄金比（÷φ≒×0.618）。コロンは秒のさらに黄金比倍（小さく）。
 *  可変項はカード幅基準（cqi）。カードをコンテナ化し、向き（縦/横）に依らずカードに対する比率を一定に保つ。 */
const timeBig = "text-[clamp(2.7rem,35cqi,8.4rem)] tracking-[-0.04em]";
const timeSmall = "text-[clamp(1.668rem,21.6cqi,5.19rem)]";
const timeColon = "text-[clamp(1.031rem,13.35cqi,3.21rem)]";
/** 時計の小さな付帯記号（コロン / ↑ / s）の色。麺色（--glow）を muted と混ぜ彩度を落とす。 */
const AFFIX_COLOR = "color-mix(in oklab, var(--glow) 50%, var(--color-muted))";

/** 残り 1 分のしきい（boiling の遠近を分ける）。 */
const NEAR_MS = 60_000;

/** boiled の超過リングが一周し切る猶予窓（ミリ秒）。これを超えると数字をやめ「OVER」表示へ切り替える。 */
const OVERDUE_FULL_MS = 99_000;

/**
 * 状態を表すスロット背景色（oklch・ダーク維持）。麺の identity は前景が担うので、背景は状態を示す。
 * ready はアプリ背景（--color-bg）より僅かに明るいだけのダークで「空き」をそっと示す。boilingFar はモノクロのダーク、
 * boilingNear（≤60s）は黄の成分、boiled は赤の成分を、いずれも暗いまま控えめに導入して「残り少」「上がり」を色でも示す。
 */
const STATE_BG = {
  ready: "oklch(0.215 0.006 80)", // 待機（空き＝アプリ背景より一段だけ明るいダーク）
  boilingFar: "oklch(0.275 0.006 80)", // 茹で中・残り潤沢（>60s・モノクロ）
  boilingNear: "oklch(0.32 0.018 95)", // 茹で中・残り僅か（≤60s・かすかな黄）
  boiled: "oklch(0.34 0.022 30)", // 茹で上がり（かすかな赤）
} as const;
const slotState = "m-0 inline-flex min-w-0 items-center gap-2 text-[clamp(0.8125rem,1.8vh,1rem)] font-bold";

/**
 * 残り時間を分・秒のサイズ差つきで描く（分=大・秒=小／1 分未満は秒だけ大・比率およそ 2:1）。
 * 色・レイアウト（flex/baseline）は親（SlotCard）が持ち、ここは数字のサイズ分けだけを担う。
 */
function RemainingTime({ remainingMs }: { readonly remainingMs: number }) {
  const parts = remainingParts(remainingMs);
  if (parts.kind === "withMinutes") {
    return (
      <>
        <span className={timeBig}>{parts.minutes}</span>
        {/* コロンは秒の黄金比倍（小さく）。付帯記号の彩度を落とした色で沈める。負マージンで詰める。 */}
        <span className={cn(timeColon, "mx-[-0.12em] font-bold")} style={{ color: AFFIX_COLOR }}>
          :
        </span>
        <span className={cn(timeSmall, "font-bold")}>{parts.seconds}</span>
      </>
    );
  }
  return <span className={timeBig}>{parts.seconds}</span>;
}

/**
 * ボタン外周の円形プログレスリング。fraction（0..1）を時計回りに満たし、stroke 色で描く。
 * トラックは stroke を黒寄りに落とした淡色。1s の transition で滑らかに進む。装飾ゆえ pointer-events-none。
 * 枠（actionSlot）に inset-0 で重なり、ボタンと同心になる。
 *   - running: 経過割合（麺色を 1 段暗くした stroke）。
 *   - boiled : 超過割合（danger 色＝超過タイマーと同色）。
 */
function ProgressRing({ fraction, stroke }: { readonly fraction: number; readonly stroke: string }) {
  const circumference = 2 * Math.PI * 46; // r=46（viewBox 100×100）
  return (
    // -rotate-90 で起点を 12 時に置き、stroke-dashoffset = C(1−fraction) で時計回りに満ちる。
    <svg viewBox="0 0 100 100" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full -rotate-90">
      <circle cx="50" cy="50" r="46" fill="none" strokeWidth="6" stroke={`color-mix(in oklab, ${stroke} 26%, black)`} />
      <circle
        cx="50"
        cy="50"
        r="46"
        fill="none"
        strokeWidth="6"
        strokeLinecap="round"
        stroke={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        className="transition-[stroke-dashoffset] duration-1000 ease-linear"
      />
    </svg>
  );
}

/** 表示状態に応じてスロットを描画する。開始/キャンセル/完了の口はここにのみ存在する。 */
export function SlotCard({ display, onStart, onCancel, onComplete, lastResultNoodle, noodleColor, onAdjust }: SlotCardProps) {
  const { slot } = display;
  // 茹で加減メニューの開閉（boiling のみ）。展開中は操作ボタンを隠す（衝突回避）。現在の硬さは Timer の事実から読む。
  // フック規則上、早期 return より前に置く。
  const [firmnessMenuOpen, setFirmnessMenuOpen] = useState(false);

  // 空きスロット。Play ピクトグラムの真円ボタン（他状態と同じ右下位置）でラジアルを開く。直前結果があれば併記。
  if (display.kind === "idle") {
    return (
      <article
        aria-label={`Slot ${slot}`}
        // READY は空き＝アプリ背景より僅かに明るいダークで縁取り（ボーダーは cardBase）。
        style={{ backgroundColor: STATE_BG.ready }}
        className={cn(cardBase)}
      >
        {lastResultNoodle && (
          <span className={cn(contentPadRight, "truncate text-[clamp(0.75rem,1.6vh,0.875rem)] font-bold text-muted")}>
            Last: {lastResultNoodle}
          </span>
        )}
        <div className={actionStack}>
          <div className={actionSlot}>
            <button
              type="button"
              aria-label={`Slot ${slot} — Start`}
              onClick={(e: MouseEvent<HTMLButtonElement>) => onStart(slot, centerOf(e.currentTarget))}
              className={cn(actionBtn, "bg-[oklch(0.78_0.006_80)] text-[#15120c] hover:brightness-95")}
            >
              <PlayIcon className={actionIcon} />
            </button>
          </div>
          <span className={actionLabel}>Start</span>
        </div>
      </article>
    );
  }

  if (display.kind === "unreceived") {
    return (
      <article aria-label={`Slot ${slot}`} className={cn(cardBase, "border-dashed opacity-80")}>
        <span className="text-[clamp(0.75rem,1.6vh,0.8125rem)] font-bold text-muted opacity-85">
          Remaining time not received
        </span>
      </article>
    );
  }

  const isBoiled = display.kind === "boiled";
  // 麺のキャラクター色。時間・ボタンをこの 1 色へ揃える（色＝麺の identity）。
  const tint = noodleColor(display.timer.noodleType);
  // 状態は背景色で示す（ダーク維持の控えめな差）。boiled / boiling 遠 / boiling 近 を分ける。
  const stateBg = isBoiled
    ? STATE_BG.boiled
    : display.remainingMs <= NEAR_MS
      ? STATE_BG.boilingNear
      : STATE_BG.boilingFar;
  // ボタン外周リング。running は経過割合（麺色を 1 段暗く）、boiled は超過割合（danger 色＝超過タイマーと同色）。
  const total = display.timer.endTime - display.timer.startTime;
  const ringFraction = isBoiled
    ? Math.min(display.overdueMs / OVERDUE_FULL_MS, 1)
    : total > 0
      ? Math.min(Math.max(1 - display.remainingMs / total, 0), 1)
      : 0;
  const ringStroke = isBoiled ? "var(--color-danger)" : "color-mix(in oklab, var(--glow) 68%, black)";
  return (
    <article
      aria-label={`Slot ${slot}`}
      // --glow に麺色を注入し、boiled のグロー点滅（animate-boiled）を麺のキャラクター色で明滅させる。
      style={{ backgroundColor: stateBg, "--glow": tint } as CSSProperties}
      className={cn(cardBase, isBoiled && "animate-boiled")}
    >
      {/* 上段：残り時間。スロット左上からの相対位置に固定（ボタンの右下固定と対）。
          running は麺色の秒読み（MM:SS）。boiled は超過秒を「↑Ns」で danger 色表示（早く上げろ）。
          ↑ と s はコロンと同じ扱い（小さく・付帯記号色）。 */}
      <p
        className={cn(
          slotTime,
          "absolute left-[clamp(0.875rem,1.8vw,1.25rem)] top-[clamp(0.625rem,1.6vh,1.125rem)] flex items-baseline",
        )}
        style={{ color: isBoiled ? "var(--color-danger)" : tint }}
      >
        {isBoiled ? (
          display.overdueMs >= OVERDUE_FULL_MS ? (
            // 超過が猶予窓（リング満杯）を超えたら、大きすぎる数字をやめ「OVER」で示す（モチベーションを削がない）。
            <span className={cn(timeBig, "animate-badge-blink")}>OVER</span>
          ) : (
            <>
              <span className={cn(timeColon, "mr-[-0.05em] font-bold")} style={{ color: AFFIX_COLOR }}>
                ↑
              </span>
              <span className={timeBig}>{Math.floor(display.overdueMs / 1000)}</span>
              <span className={cn(timeColon, "ml-[-0.02em] font-bold")} style={{ color: AFFIX_COLOR }}>
                s
              </span>
            </>
          )
        ) : (
          <RemainingTime remainingMs={display.remainingMs} />
        )}
      </p>

      {/* 下段：状態。boiled は ✓ ＋ 麺名（麺色）、running は「Boiling — 麺名」。 */}
      {isBoiled ? (
        <p className={cn(slotState, contentPadRight, "text-muted tracking-[.04em]")}>
          <span
            className="grid h-[1.375rem] w-[1.375rem] place-items-center rounded-full animate-badge-blink"
            style={{ backgroundColor: "color-mix(in oklab, var(--glow) 24%, transparent)", color: tint }}
          >
            ✓
          </span>
          {/* 麺名はここ（boiled の状態ラベル位置）へ移動。状態は背景色/グロー/バッジ/アイコン形状が担う。 */}
          <span className="truncate" style={{ color: tint }}>
            {display.timer.noodleType}
          </span>
        </p>
      ) : (
        <p className={cn(slotState, contentPadRight, "text-muted")}>
          <span className="truncate">
            Boiling — <span style={{ color: tint }}>{display.timer.noodleType}</span>
          </span>
        </p>
      )}

      {/* 操作スタック：右下に固定。茹で加減メニュー展開中（running）は隠す（衝突回避）。 */}
      {(isBoiled || !firmnessMenuOpen) && (
        <div className={actionStack}>
          <div className={actionSlot}>
            <ProgressRing fraction={ringFraction} stroke={ringStroke} />
            {isBoiled ? (
              <button
                type="button"
                aria-label="Complete"
                onClick={() => onComplete(slot, display.timer)}
                style={{ backgroundColor: tint }}
                className={cn(actionBtn, "text-[#15120c] hover:brightness-105")}
              >
                <LiftIcon className={actionIcon} />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Cancel"
                onClick={() => onCancel(display.timer.id)}
                style={{ backgroundColor: tint }}
                className={cn(actionBtn, "text-[#15120c] hover:brightness-105")}
              >
                <StopIcon className={actionIcon} />
              </button>
            )}
          </div>
          <span className={actionLabel}>{isBoiled ? "Up" : "Cancel"}</span>
        </div>
      )}

      {/* 茹で加減コントロール。左下・角融合 → 右スライド展開。選択でサーバへ adjust を送る。
          boiled では現在の硬さを表示したまま操作不能にする（変更に意味がないため）。 */}
      <FirmnessCornerControl
        value={display.timer.firmness}
        onChange={(next) => onAdjust(display.timer.id, next)}
        onOpenChange={setFirmnessMenuOpen}
        accent={tint}
        disabled={isBoiled}
      />
    </article>
  );
}
