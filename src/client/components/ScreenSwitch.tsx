// client/components/ScreenSwitch.tsx — 画面の切替（セグメント式トグル）。上部バーの中央に固定で置く。
//
// 店舗パスの配下にある画面は 3 つになる予定で、どの画面に居ても同じ位置・同じ並びで出す（位置が動けば指が迷う）。
//   Timer  … 釜のタイマー（`/s/{storeId}/`）
//   Orders … オーダーの流れ（`/s/{storeId}/flow/`）
//   Take   … オーダーテイク（iPhone で席へ行き、食券の QR を読んで卓と食券を結ぶ・**未実装**）
// Take は枠だけ先に置き、押せない（aria-disabled）。行き先の無いリンクを置かず、予定を形で示すだけにする。
//
// 切替は全遷移（アンカー）。画面ごとに接続を開き直す既存の形（App / OrderFlow がそれぞれ openTimerConnection を
// マウント中だけ持つ）に合わせ、SPA 内の遷移機構は持ち込まない。

import { orderFlowPath, storePath } from "../connection";
import { cn } from "../cn";

export type Screen = "timer" | "orders" | "take";

const SEGMENT_CLASS =
  "inline-flex h-8 items-center justify-center rounded-[0.5rem] px-3 text-sm font-bold no-underline";

export function ScreenSwitch({
  storeId,
  current,
}: {
  readonly storeId: string;
  readonly current: Screen;
}) {
  const segments: readonly {
    readonly screen: Screen;
    readonly label: string;
    readonly href: string | null;
  }[] = [
    { screen: "timer", label: "Timer", href: storePath(storeId) },
    { screen: "orders", label: "Orders", href: orderFlowPath(storeId) },
    { screen: "take", label: "Take", href: null },
  ];
  return (
    <nav
      aria-label="Screens"
      className="inline-flex items-center gap-1 rounded-[0.6875rem] border border-line bg-panel2 p-1"
    >
      {segments.map(({ screen, label, href }) => {
        const active = screen === current;
        if (href === null) {
          return (
            <span
              key={screen}
              aria-disabled="true"
              title="Order take — coming soon"
              className={cn(SEGMENT_CLASS, "cursor-not-allowed text-muted/50")}
            >
              {label}
            </span>
          );
        }
        return (
          <a
            key={screen}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              SEGMENT_CLASS,
              active
                ? "bg-panel text-ink shadow-[inset_0_0_0_1px_var(--color-line)]"
                : "text-muted hover:text-ink",
            )}
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}
