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
import { mode, type TimerConnection } from "../connection";
import { correctedNow } from "../clock";
import { FIRMNESS_LABEL } from "./firmness";
import { isNonEmpty } from "../../domain/timer";
import { assignedSlotDisplays } from "./slotDisplay";
import { displayName, orderQueueEntries } from "./queueDisplay";
import {
  liftGroups,
  pairSlots,
  slotSuggestions,
  visibleGroups,
  type SlotSuggestion,
} from "./liftGroups";
import { SlotCard, type SuggestionView } from "./SlotCard";
import { OrderRail } from "./OrderRail";
import { RadialMenu, type RadialQueueItem } from "./RadialMenu";
import { noodleColors } from "./noodleColor";

interface SlotBoardProps {
  readonly connection: TimerConnection;
  readonly units: readonly number[];
  /** 指定操作（Start 押下/麺選択確定/Cancel/Complete/茹で加減変更）に相乗りさせる Touch_Cue の再生口。best-effort・no-op しうる（要件1）。 */
  readonly playTouchCue: () => void;
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
export function SlotBoard({ connection, units, playTouchCue }: SlotBoardProps) {
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
  // 現在時刻は端のここで一度だけ読み、純粋導出（slotDisplay / liftGroups）へ引数で渡す。補正後現在時刻も
  // ここで一度だけ組む——群の開始（走行中の判定）と提案の相（薄 / 濃）が同じ瞬間を読む。
  const now = Date.now();
  const corrected = correctedNow(view.offset, now);
  // 待ち行列（レール用・到着順）。件数は絞らない——計画対象の上限を超える分も並び、提案が付かないだけである。
  const queue = orderQueueEntries(view, units, now);
  // 釜カードの提案は、受信した推奨の全量から群 → 表示できる群 → 釜ごとの提案の順に導く。担当範囲で絞るのは
  // 表示（assignedSlotDisplays）だけで、群・開始・連鎖・全釜 idle は店舗全体で判定する——どの端末を見ても
  // 同じ「次」が見える（lift-group-display AC 1.6 / 2.12）。群も先頭もビューに保持しない（AC 1.5）。
  const bySlot = slotSuggestions(visibleGroups(liftGroups(view, corrected)), view, corrected);
  // 保持は全量・表示は導出。担当外スロットはここで構造的に除外される（要件12.2）。
  const displays = assignedSlotDisplays(view, units, now, bySlot);
  // レールを描くかは 1 箇所でだけ判定する。非空なら型が NonEmptyArray<QueueEntry> へ絞られ、
  // そのまま OrderRail の props を満たす（0 件のレールは構築不能）。
  const waiting = isNonEmpty(queue) ? queue : null;
  // ラジアルメニューの開閉。ボード内で一つだけ持ち、RadialMenu も一つだけ描画する。
  const [picker, setPicker] = useState<PickerAnchor | null>(null);
  // ラジアルの待ち行列の帯。レールと同じ到着順の行に、押した釜から組めた釜の集合を付ける（lift-group-display
  // AC 4.1 / 4.4）。毎描画 view から導くので、開いたまま snapshot で起点の釜が埋まれば行は自動的に不活性になる
  // （AC 4.9・状態に写さない）。degraded では空——選んでも開始されない品目を選べる形で示さない（AC 4.8 / 4.9）。
  const radialQueue: readonly RadialQueueItem[] =
    picker !== null && mode(view) === "live"
      ? queue.map(({ order }) => ({ order, slotIds: pairSlots(picker.slot, order.slotSpan, view) }))
      : [];
  // 麺色の resolver。メニュー順に重複なく色を割り当てる（config 受信時のみ再構築・毎ティックでは作り直さない）。
  const colorOf = useMemo(
    () => noodleColors(view.noodlePresets.map((preset) => preset.noodleType)),
    [view.noodlePresets],
  );

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
      {/* 下段: 左に待ちオーダーのレール、右に釜グリッド。既定の align-items: stretch で上下端が揃う。
          gap は置かない——区切りはレール側の pr と border-r が作り、釜カードの幅を 1px も削らない。 */}
      <div className="flex min-h-0 flex-1">
        {/* 待ち行列と提案のレール。未着手オーダーが無い店（POS 連携前）では描かれず、盤面は従来のままになる。 */}
        {waiting !== null && <OrderRail entries={waiting} noodleColor={colorOf} />}
        {/* ユニットごとに 2col×3row のブロックを作り、ユニットを横並び（縦画面=1ユニットは単独ブロック、
            横画面=2ユニットは左右に並ぶ）。外枠 grid-flow-col + auto-cols-fr が各ユニットを等幅の列にする。
            左 padding を持たない。Board_Area の幅の変化はこの flex-1 が吸収する（JS で寸法を測らない）。 */}
        <div className="grid min-h-0 min-w-0 flex-1 auto-cols-fr grid-flow-col gap-[clamp(0.75rem,1.8vw,1.375rem)]">
          {[...units]
            .sort((a, b) => a - b)
            .map((unit) => (
              <div
                key={unit}
                className="grid min-h-0 auto-rows-fr grid-cols-2 gap-[clamp(0.5rem,1.2vw,0.875rem)]"
              >
                {displays
                  .filter((display) => Math.floor(display.slot / 6) === unit)
                  .map((display) => {
                    // 直前結果は idle スロットにのみ、記録から LAST_RESULT_TTL_MS の間だけ提示する（要件13.5）。
                    const recorded =
                      display.kind === "idle"
                        ? view.lastResults.get(String(display.slot))
                        : undefined;
                    const lastResultNoodle =
                      recorded && now - recorded.at < LAST_RESULT_TTL_MS
                        ? recorded.noodleType
                        : undefined;
                    return (
                      <SlotCard
                        key={display.slot}
                        display={display}
                        suggestionOf={(suggestion) =>
                          suggestionOf(suggestion, display.slot, colorOf)
                        }
                        onStartSuggested={({ order, suggestion }) => {
                          // 品目を指して開始する。麺種・茹で加減・茹で秒は送らない——サーバが待ち行列の
                          // 当該品目と noodlePresets から導く（slot-suggested-start 判断 6）。釜は推奨の
                          // slotIds 全体（lift-group-display AC 3.1）。
                          connection.startOrderItem(suggestion.slotIds, {
                            externalOrderId: order.externalOrderId,
                            itemIndex: order.itemIndex,
                          });
                          playTouchCue();
                        }}
                        onStart={(slot, center) => {
                          // Start ボタン押下（ラジアルを開く操作）にも Touch_Cue を相乗りさせる。開く動作は変えない
                          // （best-effort・no-op しうる・要件1.1/1.4/1.5）。麺選択確定時にも別途鳴る（タップごとの反応）。
                          setPicker({ slot, ...center });
                          playTouchCue();
                        }}
                        onCancel={(timerId) => {
                          // 指定操作（Cancel）に Touch_Cue を相乗りさせる。再生は副作用として加えるだけで、
                          // 本来のキャンセル動作は変えない（best-effort・no-op しうる・要件1.4/1.5）。
                          connection.cancel(timerId);
                          playTouchCue();
                        }}
                        onComplete={(_slot, timer) => {
                          // 指定操作（Complete＝消し込み）に Touch_Cue を相乗りさせる。
                          connection.complete(timer.id);
                          playTouchCue();
                        }}
                        lastResultNoodle={lastResultNoodle}
                        noodleColor={colorOf}
                        onAdjust={(timerId, firmness) => {
                          // 茹で加減変更（指定操作）にも Touch_Cue を相乗りさせる。サーバへの adjust 本体は変えない
                          // （best-effort・no-op しうる・要件1.4/1.5）。
                          connection.adjust(timerId, firmness);
                          playTouchCue();
                        }}
                      />
                    );
                  })}
              </div>
            ))}
        </div>
      </div>
      <RadialMenu
        anchor={picker ? { x: picker.x, y: picker.y } : null}
        presets={view.noodlePresets}
        colorOf={colorOf}
        label={picker ? `Slot ${picker.slot}` : undefined}
        queue={radialQueue}
        onSelectItem={({ order, slotIds }) => {
          // 品目を指して開始する（提案からの開始と同じ口・AC 4.2）。釜は押した釜から組んだ集合——slotSpan 1 は
          // 押した釜だけ（AC 4.3）、2 以上は許容距離の内側で最も近い idle の釜を足したもの（AC 4.4）。
          connection.startOrderItem(slotIds, {
            externalOrderId: order.externalOrderId,
            itemIndex: order.itemIndex,
          });
          setPicker(null);
          playTouchCue();
        }}
        onSelect={(preset) => {
          // 麺選択確定＝Start。指定操作に Touch_Cue を相乗りさせる（開始動作は変えない・要件1.1/1.4/1.5）。
          if (picker) startOnSlot(picker.slot, preset.noodleType, preset.boilSeconds.normal);
          setPicker(null);
          playTouchCue();
        }}
        onClose={() => setPicker(null)}
      />
    </>
  );
}

/**
 * 提案の見え方（ラベル・aria-label・塗り）を組む。
 *
 * 表示語彙をここに集める。品目の名はレール・ラジアルの帯と同じ displayName で呼び（商品名の代替・NFKC 正規化・
 * 麺量はそこにだけ在る）、カードへ散らすと二つの真実になる。可視のラベルも aria-label も同じ名を置く——麺量の
 * 違う同名の品目は別の品目で、支援技術にだけ麺量を落とす理由が無い（design Component 5 の実装注記）。カードは
 * 受け取った文字列を描くだけである。
 *
 * 時期を組まず、語だけを組む。可視の語は空か `now` の 2 つだけで、時刻（`in m:ss` / `+m:ss` / 壁時計 /
 * 秒読み）は描かない（lift-group-display AC 2.5 / 3.3 / 6.4）——順序は出現の順が語り、押せる先頭は薄くても
 * 押せる。aria-label だけが `soon`（薄い先頭）/ `queued`（押せない仲間）で薄・押せないを語る（AC 3.4 / 3.7）。
 * 可視の `now` は aria-label の相の語から導く——同じ一語から二つの文を組むので、食い違う状態が表現できない。
 *
 * 返すのは文字列と色だけで、判別（`role` / `phase`）は返さない。押せるか・濃いかは `SlotCard` が導出の
 * 判別から直接読む（見え方に写せば二つ目の真実になる・`SuggestionView` の doc）。
 *
 * 固定文言は英語（`now` / `Table {n}`）。#24 がレールの固定文言を英語に固定し、カードの操作ラベルも
 * `Start` / `Cancel` / `Complete` である——調理母語は硬さだけが `FIRMNESS_LABEL` 経由で入る。
 */
function suggestionOf(
  suggestion: SlotSuggestion,
  slot: number,
  colorOf: (noodleType: string) => string,
): SuggestionView {
  const { order } = suggestion.item;
  const name = displayName(order);
  const firmness = FIRMNESS_LABEL[order.firmness];
  const table = order.tableId === null ? undefined : `Table ${order.tableId}`;
  // 相の語。先頭は startAt を迎えたら `now`・手前は `soon`、仲間は常に `queued`（startAt が過ぎても・AC 2.4）。
  const phrase =
    suggestion.role === "head" ? (suggestion.phase === "solid" ? "now" : "soon") : "queued";
  const parts = [name, firmness, table, phrase === "now" ? phrase : undefined];
  const label = parts.filter((part) => part !== undefined).join(" · ");
  // 命令形を用いない（AC 3.3）。提案であること・品目・釜・相をこの順で語る。
  const ariaLabel = `Suggested — ${name} · Slot ${slot} · ${phrase}`;
  return { label, ariaLabel, tint: colorOf(order.noodleType) };
}
