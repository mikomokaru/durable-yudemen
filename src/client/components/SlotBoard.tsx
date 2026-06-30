// client/components/SlotBoard.tsx — 担当スロットの一覧表示と操作の配線。
// 接続の外部ストアを useSyncExternalStore で購読してビューを得る（受信・接続状態の変化で再描画）。
// 残りの秒読みはビュー変化では起きないため、毎秒＋復帰時に再レンダーを促す拍をこのボードが持ち、
// 描画時点の Date.now() を読んで slotDisplay の純粋導出で残りを算出し直す（要件10.5）。現在時刻は
// キャッシュせず（どの経路の再レンダーでも実時刻で算出）、残り秒も状態に持たない。
//
// レイアウトの外殻（フルスクリーンの .ymt / 上部バー）と同期インジケータは App / ConnectionStatus が担う。
// ここはボード本体——エラー帯・スロットグリッド・ラジアルメニュー——だけを描く。
//
// 直前の調理結果（残滓）は接続ビューの client 専用フィールド view.lastResults が持つ（明示完了 completed /
// LocalComplete で除去直前に記録される）。ここはそれを idle スロットに LAST_RESULT_TTL_MS だけ提示するだけ。
// 記録ロジックを decideView 側へ寄せたことで、自端末完了・リモート完了の双方で残滓が出る（表示は導出のみ）。

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TimerConnection } from "../connection";
import { assignedSlotDisplays } from "./slotDisplay";
import { SlotCard } from "./SlotCard";
import { RadialMenu } from "./RadialMenu";
import { noodleColors } from "./noodleColor";

interface SlotBoardProps {
  readonly connection: TimerConnection;
  readonly units: readonly number[];
}

/** ラジアルメニューの開閉状態。どのスロットを、画面のどこを中心に開くか。閉のとき null。 */
interface PickerAnchor {
  readonly slot: number;
  readonly x: number;
  readonly y: number;
}

/** 直前結果を idle に提示し続ける時間（ミリ秒）。経過後は通常の Ready 表示へ戻る（クライアント制御）。 */
const LAST_RESULT_TTL_MS = 30_000;

/** 担当ユニットの Timer を秒読み表示し、担当スロットにのみ開始/キャンセル/完了操作を提示する。 */
export function SlotBoard({ connection, units }: SlotBoardProps) {
  // ビューは受信・接続状態変化でのみ更新される外部ストア。残り秒は持たない。
  const view = useSyncExternalStore(connection.subscribe, connection.getView);
  // 秒読み用の再レンダーの拍。値は持たず bump するだけ——毎秒＋復帰時に再レンダーを促し、時刻は描画時点の
  // Date.now() で読む（現在時刻をキャッシュせず、どの経路の再レンダーでも実時刻で算出する）。
  const [, beat] = useState(0);
  useEffect(() => {
    const tick = () => beat((n) => n + 1);
    const id = setInterval(tick, 1000);
    // バックグラウンド中は setInterval がスロットル/停止する。復帰の瞬間に即時再レンダーして止まっていた分を解消。
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
  // 現在時刻は端のここで一度だけ読み、純粋導出（slotDisplay）へ引数で渡す。
  const now = Date.now();
  // 保持は全量・表示は導出。担当外スロットはここで構造的に除外される（要件12.2）。
  const displays = assignedSlotDisplays(view, units, now);
  // ラジアルメニューの開閉。ボード内で一つだけ持ち、RadialMenu も一つだけ描画する。
  const [picker, setPicker] = useState<PickerAnchor | null>(null);
  // 麺色の resolver。メニュー順に重複なく色を割り当てる（config 受信時のみ再構築・毎ティックでは作り直さない）。
  const colorOf = useMemo(() => noodleColors(view.noodlePresets.map((preset) => preset.noodleType)), [view.noodlePresets]);

  // slotId はスロット番号の文字列表現（slotOf = Number(slotId) の逆／要件12.5）。
  // UI はスロット単位なので 1 スロットを駆動する Timer として開始する（slotIds は 1 件）。
  const startOnSlot = (slot: number, noodleType: string, boilSeconds: number) => {
    connection.start([String(slot)], noodleType, boilSeconds);
  };

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
      {/* ユニットごとに 2col×3row のブロックを作り、ユニットを横並び（縦画面=1ユニットは単独ブロック、
          横画面=2ユニットは左右に並ぶ）。外枠 grid-flow-col + auto-cols-fr が各ユニットを等幅の列にする。 */}
      <div className="grid min-h-0 flex-1 auto-cols-fr grid-flow-col gap-[clamp(0.75rem,1.8vw,1.375rem)]">
        {[...units]
          .sort((a, b) => a - b)
          .map((unit) => (
            <div key={unit} className="grid min-h-0 auto-rows-fr grid-cols-2 gap-[clamp(0.5rem,1.2vw,0.875rem)]">
              {displays
                .filter((display) => Math.floor(display.slot / 6) === unit)
                .map((display) => {
                  // 直前結果は idle スロットにのみ、記録から LAST_RESULT_TTL_MS の間だけ提示する（要件13.5）。
                  const recorded =
                    display.kind === "idle" ? view.lastResults.get(String(display.slot)) : undefined;
                  const lastResultNoodle =
                    recorded && now - recorded.at < LAST_RESULT_TTL_MS ? recorded.noodleType : undefined;
                  return (
                    <SlotCard
                      key={display.slot}
                      display={display}
                      onStart={(slot, center) => setPicker({ slot, ...center })}
                      onCancel={connection.cancel}
                      onComplete={(_slot, timer) => connection.complete(timer.id)}
                      lastResultNoodle={lastResultNoodle}
                      noodleColor={colorOf}
                      onAdjust={connection.adjust}
                    />
                  );
                })}
            </div>
          ))}
      </div>
      <RadialMenu
        anchor={picker ? { x: picker.x, y: picker.y } : null}
        presets={view.noodlePresets}
        colorOf={colorOf}
        label={picker ? `Slot ${picker.slot}` : undefined}
        onSelect={(preset) => {
          if (picker) startOnSlot(picker.slot, preset.noodleType, preset.boilSeconds.normal);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
    </>
  );
}
