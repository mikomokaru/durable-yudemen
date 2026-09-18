// client/components/TablePicker.tsx — 品目の卓を選ぶダイアログ（Orders 画面・2026-09-17）。
//
// 卓番のボタン一覧（ユーザー確定）。範囲は当面 1〜TABLE_COUNT の定数——店舗ごとの卓の並びが要るようになったら
// StoreConfig へ上げる。「No table」で卓なしに戻せる。選ぶと onPick を一度呼んで閉じる。外側タップ / Esc で閉じる。
// 状態は開閉と対象だけで、卓の事実はサーバが確定させる（snapshot で戻ってくる）。

import { useEffect, useRef } from "react";
import type { OrderItem } from "../../domain/order";
import { displayName } from "./queueDisplay";
import { cn } from "../cn";

/** 卓番の選択肢の数（1〜TABLE_COUNT）。当面の定数。 */
export const TABLE_COUNT = 20;

export function TablePicker({
  order,
  onPick,
  onClose,
}: {
  readonly order: OrderItem;
  readonly onPick: (tableId: string | null) => void;
  readonly onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(event) => {
        if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`Table for ${displayName(order)}`}
        className="w-[min(30rem,100%)] rounded-[0.875rem] border border-line bg-panel p-4 shadow-[0_1.125rem_3.125rem_rgba(0,0,0,.55)]"
      >
        <p className="m-0 mb-3 flex items-baseline justify-between text-sm text-muted">
          <span className="font-bold text-ink">{displayName(order)}</span>
          <span>{order.tableId === null ? "No table" : `Table ${order.tableId}`}</span>
        </p>
        <div className="grid grid-cols-5 gap-2">
          {Array.from({ length: TABLE_COUNT }, (_, k) => String(k + 1)).map((tableId) => {
            const current = order.tableId === tableId;
            return (
              <button
                key={tableId}
                type="button"
                aria-pressed={current}
                onClick={() => onPick(tableId)}
                className={cn(
                  "h-12 cursor-pointer rounded-[0.625rem] border text-base font-bold",
                  current
                    ? "border-brand bg-panel2 text-brand"
                    : "border-line bg-panel2 text-ink hover:border-muted",
                )}
              >
                {tableId}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex justify-between">
          <button
            type="button"
            onClick={() => onPick(null)}
            className="h-10 cursor-pointer rounded-[0.625rem] border border-line bg-panel2 px-4 text-sm font-bold text-muted hover:text-ink"
          >
            No table
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-10 cursor-pointer rounded-[0.625rem] border border-line bg-panel2 px-4 text-sm font-bold text-ink hover:border-muted"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
