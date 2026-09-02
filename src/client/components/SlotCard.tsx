// client/components/SlotCard.tsx — 担当スロット 1 つの表示と操作。
// 開始・キャンセル・完了の操作 UI は担当スロットに対してのみ描画される（このコンポーネントは
// 担当スロットの表示状態 SlotDisplay からのみ生成されるため、担当外には現れない／要件12.3）。
// 残りは導出済みの値を受け取って整形するだけ。00:00 固定・負なしは format/clock 側で担保（要件5.6）。
//
// 状態機械: idle（カード全体が開始ボタン・タップでラジアル）→ running（Cancel で中断）→ boiled
// （Complete で明示消し込み）。boiled は「ユーザーが消し込むべき状態」で、Complete までカードに残る。
// 完了後、当該スロットは idle に戻り、直前の調理結果（noodleType）をベストエフォートで一定時間表示する。

import { type CSSProperties, type MouseEvent, useEffect, useRef, useState } from "react";
import { remainingParts } from "../format";
import { cn } from "../cn";
import type { TimerFact } from "../../domain/timer";
import type { SlotDisplay } from "./slotDisplay";
import type { NoodleColor } from "./noodleColor";
import { PlayIcon, StopIcon, LiftIcon } from "./icons";
import { FirmnessCornerControl } from "./FirmnessCornerControl";
import {
  CANCEL_GUARD_THRESHOLD_MS,
  CANCEL_ARMED_BOUNCE_MS,
  decideCancelTap,
  isCancelArmed,
} from "./cancelGuard";
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
  "@container relative grid min-h-0 content-center gap-[clamp(0.25rem,1vh,0.625rem)]",
  "rounded-[0.875rem] border border-line bg-panel",
  "p-[clamp(0.625rem,1.6vh,1.125rem)_clamp(0.875rem,1.8vw,1.25rem)]",
  "shadow-[0_0.0625rem_0_rgba(255,255,255,.03)_inset,0_0.5rem_1.5rem_rgba(0,0,0,.35)]",
  "transition-[border-color,box-shadow] duration-200",
);

/** 操作スタック: カード右下に固定。真円ボタン（＋リング）の下に小さなラベルを縦に並べる。 */
const actionStack = cn(
  "absolute right-[clamp(0.625rem,1.6vw,1.125rem)] bottom-[clamp(0.625rem,1.6vh,1.125rem)]",
  "flex flex-col items-center gap-[clamp(0.125rem,0.5vh,0.375rem)]",
);
/** 操作エリア: ボタン＋インジケータを収める正方形。全状態で同形にし、帯を常に確保する（boiling か否かで不変）。
 *  寸法はカード幅基準（cqi）。vh 基準だと iPhone の狭いカードに対して過大になり他コントロールと被るため、
 *  クロック・茹で加減コントロールと同じくカード幅へ追従させる（iPad は cap で従来の大きさを維持）。 */
const actionSlot = cn(
  "relative grid aspect-square h-[clamp(3.5rem,39cqi,7.875rem)] place-items-center",
);
/** ボタン下の操作ラベル（Start / Stop / Complete）。小さく控えめに。 */
const actionLabel =
  "text-[clamp(0.625rem,1.3vh,0.8125rem)] font-bold uppercase tracking-[.08em] leading-none text-muted";
/** 操作ボタン: 操作エリア内に収まる真円。リング内縁と接する大きさ（88%）にして両者の間に隙間を作らない。 */
const actionBtn = cn(
  "grid aspect-square h-[88%] place-items-center rounded-full",
  "cursor-pointer transition active:scale-95",
);
/** 真円ボタン内のピクトグラムの大きさ（ボタンに比例＝カード幅基準 cqi）。 */
const actionIcon = "h-[clamp(1.4rem,18cqi,3.625rem)] w-auto";

const slotTime = cn("m-0 font-clock leading-[.95] font-black tracking-[.01em] tabular-nums");
/** 分=大、秒=分の黄金比（÷φ≒×0.618）。コロンは秒のさらに黄金比倍（小さく）。
 *  可変項はカード幅基準（cqi）。カードをコンテナ化し、向き（縦/横）に依らずカードに対する比率を一定に保つ。 */
const timeBig = "text-[clamp(2.7rem,35cqi,8.4rem)] tracking-[-0.04em]";
const timeSmall = "text-[clamp(1.668rem,21.6cqi,5.19rem)]";
const timeColon = "text-[clamp(1.031rem,13.35cqi,3.21rem)]";
/** 時計の小さな付帯記号（コロン / ↑ / s）の色。麺色（--glow）を muted と混ぜ彩度を落とす。 */
const AFFIX_COLOR = "color-mix(in oklab, var(--glow) 50%, var(--color-muted))";

/** 残り 1 分のしきい（boiling の遠近を分ける）。 */
const NEAR_MS = 60_000;
// Cancel 誤タップ保険のしきい・窓・バウンスは cancelGuard.ts（純粋な決定ロジックの正本）に集約する。

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
function ProgressRing({
  fraction,
  stroke,
}: {
  readonly fraction: number;
  readonly stroke: string;
}) {
  const circumference = 2 * Math.PI * 46; // r=46（viewBox 100×100）
  return (
    // -rotate-90 で起点を 12 時に置き、stroke-dashoffset = C(1−fraction) で時計回りに満ちる。
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
    >
      <circle
        cx="50"
        cy="50"
        r="46"
        fill="none"
        strokeWidth="6"
        stroke={`color-mix(in oklab, ${stroke} 26%, black)`}
      />
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

/**
 * 麺種を表す色付きピル（塗り）。色＝種類の identity を担う全相共通の表現（running / boiled / idle 残滓）。
 * 背景はアクセント（時間・リング・「ふつう」タグと同色）、文字はアクセント上で読める濃色（#15120c）。
 * 長い名称はカード幅からリング領域を引いた max-width で折り返す（省略記号は使わない）。faded は idle 残滓
 * （過去の結果・best-effort）を淡く示すため。実行時に変わる色だけインライン、寸法・折返しはクラス。
 */
/**
 * バッジ prefix のマーカー。相ごとに状態を 1 記号で示す（identity は色、状態はこのマーカー）。
 * - boiling: 走行中＝点滅する live ドット（monochrome・絵文字非依存）。
 * - ready  : 茹で上がり（上がり待ち）＝✓。
 * - last   : idle の直前結果（過去・best-effort）＝✓。
 * - none   : マーカーなし。
 */
type BadgeMarker = "none" | "boiling" | "ready" | "last";

function NoodleBadge({
  noodleType,
  tint,
  faded = false,
  marker = "none",
  className,
}: {
  readonly noodleType: string;
  readonly tint: string;
  readonly faded?: boolean;
  readonly marker?: BadgeMarker;
  readonly className?: string;
}) {
  const ariaPrefix =
    marker === "last"
      ? "Last: "
      : marker === "ready"
        ? "Ready: "
        : marker === "boiling"
          ? "Boiling: "
          : "";
  return (
    <span
      aria-label={`${ariaPrefix}${noodleType}`}
      className={cn(
        // 常にカード幅いっぱい（親コラム幅の 100%）。狭カード(iPhone)で max-width により縦長化するのを避ける。
        // relative z-[7]: 茹で加減の 2×2 オーバーレイ（暗幕 z-4 / グリッド z-5）より前面に出し、選択中もバッジを見せる。
        "relative z-[7] block w-full rounded-full leading-[1.25] font-bold [overflow-wrap:anywhere]",
        "px-[1.375rem] py-[0.5625rem] text-[clamp(1.0625rem,6.4cqi,1.4375rem)]",
        faded && "opacity-60",
        className,
      )}
      style={{ backgroundColor: tint, color: "#15120c" }}
    >
      {/* 走行中は点滅ドット（bg-current = 濃色文字色）、上がり/前回結果は ✓。いずれも色＝種類とは独立の状態記号。 */}
      {marker === "boiling" && (
        <span
          aria-hidden="true"
          className="mr-[0.4em] inline-block h-[0.5em] w-[0.5em] animate-pulse rounded-full bg-current align-middle"
        />
      )}
      {(marker === "ready" || marker === "last") && (
        <span aria-hidden="true" className="mr-[0.35em]">
          ✓
        </span>
      )}
      {noodleType}
    </span>
  );
}

/** 表示状態に応じてスロットを描画する。開始/キャンセル/完了の口はここにのみ存在する。 */
export function SlotCard({
  display,
  onStart,
  onCancel,
  onComplete,
  lastResultNoodle,
  noodleColor,
  onAdjust,
}: SlotCardProps) {
  const { slot } = display;
  // 茹で加減メニューの開閉（boiling のみ）。展開中は操作ボタンを隠す（衝突回避）。現在の硬さは Timer の事実から読む。
  // フック規則上、早期 return より前に置く。
  const [firmnessMenuOpen, setFirmnessMenuOpen] = useState(false);
  // Cancel 誤タップ保険の armed 状態。保持する事実は「armed に入った絶対時刻」ひとつだけ（残り秒と同じく、
  // armed か否かは armedAt + 3 秒窓 + 現在時刻からの導出値であって状態に昇格させない）。フック規則上、早期 return より前。
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // 前提（running かつ 残り ≥ しきい）が崩れたら armed を黙って解除する。残り < しきい・boiled/idle への遷移・
  // snapshot からの消失は、いずれも display.kind / remainingMs の変化として現れ、この導出が false へ落ちる。
  const cancelGuardEligible =
    display.kind === "running" && display.remainingMs >= CANCEL_GUARD_THRESHOLD_MS;
  useEffect(() => {
    if (!cancelGuardEligible) setArmedAt(null);
  }, [cancelGuardEligible]);

  // 盤面の他所タップで解除する（自 Cancel ボタン上のタップは 2 タップ目＝commit 経路に委ねる）。
  // armed 直後 CANCEL_ARMED_BOUNCE_MS は入力を無視し、バウンス連打での即解除／即確定を防ぐ。
  useEffect(() => {
    if (armedAt === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (Date.now() - armedAt < CANCEL_ARMED_BOUNCE_MS) return;
      if (cancelBtnRef.current?.contains(event.target as Node)) return;
      setArmedAt(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [armedAt]);

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
          // 直前の調理結果（残滓）も同じバッジ方針で。過去の best-effort 情報ゆえ faded で淡く示す。
          <div className="absolute top-[clamp(0.625rem,1.6vh,1.125rem)] right-[clamp(0.4375rem,0.9vw,0.625rem)] left-[clamp(0.4375rem,0.9vw,0.625rem)]">
            <NoodleBadge
              noodleType={lastResultNoodle}
              tint={noodleColor(lastResultNoodle)}
              faded
              marker="last"
            />
          </div>
        )}
        <div className={actionStack}>
          <div className={actionSlot}>
            <button
              type="button"
              aria-label={`Slot ${slot} — Start`}
              onClick={(e: MouseEvent<HTMLButtonElement>) =>
                onStart(slot, centerOf(e.currentTarget))
              }
              className={cn(
                actionBtn,
                "bg-[oklch(0.78_0.006_80)] text-[#15120c] hover:brightness-95",
              )}
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
  // 枠線で緊急度を示す（麺色から解放された枠の新役割）。ゆであがり=danger（赤）、残り1分以内=warn（黄琥珀）、
  // それ以外は cardBase の border-line のまま（undefined で上書きしない）。
  const stateBorder = isBoiled
    ? "var(--color-danger)"
    : display.remainingMs <= NEAR_MS
      ? "var(--color-warn)"
      : undefined;
  // ボタン外周リング。running は経過割合（麺色を 1 段暗く）、boiled は超過割合（danger 色＝超過タイマーと同色）。
  const total = display.timer.endTime - display.timer.startTime;
  const ringFraction = isBoiled
    ? Math.min(display.overdueMs / OVERDUE_FULL_MS, 1)
    : total > 0
      ? Math.min(Math.max(1 - display.remainingMs / total, 0), 1)
      : 0;
  const ringStroke = isBoiled
    ? "var(--color-danger)"
    : "color-mix(in oklab, var(--glow) 68%, black)";

  // armed か否かは armedAt + 3 秒窓 + 現在時刻からの導出（描画 tick で再評価）。ボタンの幾何は不変で、色・ラベルだけ警告表現にする。
  const cancelArmed =
    display.kind === "running" &&
    isCancelArmed({ remainingMs: display.remainingMs, armedAt, now: Date.now() });
  // Cancel タップ。決定は純粋関数（cancelGuard）に委ね、ここは決定に応じた作用（送信・armed 更新）だけを行う。
  const onCancelTap = () => {
    if (display.kind !== "running") return; // このボタンは running のみ描画（型絞り込み）
    const decision = decideCancelTap({
      remainingMs: display.remainingMs,
      armedAt,
      now: Date.now(),
    });
    switch (decision.kind) {
      case "cancel":
        onCancel(display.timer.id);
        setArmedAt(null);
        break;
      case "arm":
        setArmedAt(decision.at);
        break;
      case "ignore":
        break;
    }
  };
  return (
    <article
      aria-label={`Slot ${slot}`}
      // 起源（Provisional_Timer か server-confirmed か）は事実である。事実を描画の側で落とす理由がないので
      // DOM に残す。だが画面には出さない——確定させる操作が UI に無く（サーバへの書き戻しはスコープ外）、
      // クロスデバイスの二重起動も受容済みゆえ、この区別は厨房スタッフの行動を一切変えない。行動を変えない
      // 差異を見た目に出せば、現場の注意を無為に奪う。ゆえに running の見た目は server-confirmed と同一に保つ。
      // 値は "true" / "false" を書く：属性の有無で表すと「確定済み」と「そもそも走行中でない」が区別できない。
      data-unconfirmed={display.kind === "running" ? String(display.unconfirmed) : undefined}
      // --glow に麺色を注入し、boiled のグロー点滅（animate-boiled）を麺のキャラクター色で明滅させる。
      // 枠線（borderColor）は緊急度を示す：warn（残り1分以内）/ danger（ゆであがり）。
      style={
        { backgroundColor: stateBg, borderColor: stateBorder, "--glow": tint } as CSSProperties
      }
      className={cn(cardBase, isBoiled && "animate-boiled")}
    >
      {/* 左上：麺種バッジ（色＝identity）→ 直下に大きな残り時間。状態は背景/枠/リングが担う。
          running は麺色の秒読み（MM:SS）。boiled は超過秒を「↑Ns」で danger 色表示（早く上げろ）。
          ↑ と s はコロンと同じ扱い（小さく・付帯記号色）。 */}
      <div
        className={cn(
          "absolute top-[clamp(0.625rem,1.6vh,1.125rem)] right-[clamp(0.4375rem,0.9vw,0.625rem)] left-[clamp(0.4375rem,0.9vw,0.625rem)] flex flex-col items-start gap-[clamp(0.25rem,1vh,0.5rem)]",
          // iPhone(狭カード)で茹で加減 2×2 展開中だけ、バッジ＋クロックを横一列にしてオーバーレイ前面(z-7)へ。
          // クロックはバッジ右端へ寄せる（下の 2×2 と重ねず、背後を透かさずに残り時間を見せる）。
          firmnessMenuOpen &&
            "@max-[240px]:z-[7] @max-[240px]:flex-row @max-[240px]:items-center @max-[240px]:gap-[0.5rem]",
        )}
      >
        <NoodleBadge
          noodleType={display.timer.noodleType}
          tint={tint}
          marker={isBoiled ? "ready" : "boiling"}
          className={
            firmnessMenuOpen ? "@max-[240px]:w-auto @max-[240px]:min-w-0 @max-[240px]:flex-1" : ""
          }
        />
        <p
          className={cn(
            slotTime,
            "flex items-baseline",
            // 展開中(iPhone)は右端へ寄せ、巨大な秒読みを小さく畳んで一列に収める（このときだけ）。
            firmnessMenuOpen &&
              "@max-[240px]:ml-auto @max-[240px]:shrink-0 @max-[240px]:[&_span]:text-[1.375rem]",
          )}
          style={{ color: isBoiled ? "var(--color-danger)" : tint }}
        >
          {isBoiled ? (
            display.overdueMs >= OVERDUE_FULL_MS ? (
              // 超過が猶予窓（リング満杯）を超えたら、大きすぎる数字をやめ「OVER」で示す（モチベーションを削がない）。
              <span className={cn(timeBig, "animate-badge-blink")}>OVER</span>
            ) : (
              <>
                <span
                  className={cn(timeColon, "mr-[-0.05em] font-bold")}
                  style={{ color: AFFIX_COLOR }}
                >
                  ↑
                </span>
                <span className={timeBig}>{Math.floor(display.overdueMs / 1000)}</span>
                <span
                  className={cn(timeColon, "ml-[-0.02em] font-bold")}
                  style={{ color: AFFIX_COLOR }}
                >
                  s
                </span>
              </>
            )
          ) : (
            <RemainingTime remainingMs={display.remainingMs} />
          )}
        </p>
      </div>

      {/* 状態ラベルは持たない：identity は左上バッジ、状態はバッジの prefix マーカー（✓/ドット）と背景/枠/リングが担う。 */}

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
                ref={cancelBtnRef}
                type="button"
                aria-label={cancelArmed ? "Tap again to cancel" : "Cancel"}
                onClick={onCancelTap}
                // 幾何（サイズ・位置・円形・進捗リング）は不変。armed のときだけ背景を danger・文字を白の警告表現にする。
                style={{
                  backgroundColor: cancelArmed ? "var(--color-danger)" : tint,
                  color: cancelArmed ? "#fff" : "#15120c",
                }}
                className={cn(actionBtn, "hover:brightness-105")}
              >
                <StopIcon className={actionIcon} />
              </button>
            )}
          </div>
          <span
            className={actionLabel}
            style={cancelArmed ? { color: "var(--color-danger)" } : undefined}
          >
            {isBoiled ? "Up" : cancelArmed ? "Tap again" : "Cancel"}
          </span>
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
