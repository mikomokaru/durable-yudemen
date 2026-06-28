// client/components/SlotCard.tsx — 担当スロット 1 つの表示と操作。
// 開始・キャンセル操作 UI は担当スロットに対してのみ描画される（このコンポーネントは
// 担当スロットの表示状態 SlotDisplay からのみ生成されるため、担当外には現れない／要件12.3）。
// 残りは導出済みの値を受け取って整形するだけ。00:00 固定・負なしは format/clock 側で担保（要件5.6）。

import { useState } from "react";
import { formatRemaining } from "../format";
import { NOODLE_PRESETS } from "./noodlePresets";
import type { SlotDisplay } from "./slotDisplay";

interface SlotCardProps {
  readonly display: SlotDisplay;
  readonly onStart: (slot: number, noodleType: string, boilSeconds: number) => void;
  readonly onCancel: (timerId: string) => void;
}

/** 表示状態に応じてスロットを描画する。開始/キャンセルの口はここにのみ存在する。 */
export function SlotCard({ display, onStart, onCancel }: SlotCardProps) {
  const { slot } = display;
  return (
    <article className={`slot slot--${display.kind}`} aria-label={`Slot ${slot}`}>
      <header className="slot__name">Slot {slot}</header>
      {display.kind === "running" && (
        <>
          <p className="slot__time">{formatRemaining(display.remainingMs)}</p>
          {display.remainingMs <= 0 && <p className="slot__badge">Boiled!</p>}
          <button type="button" className="btn btn--cancel" onClick={() => onCancel(display.timer.id)}>
            Cancel
          </button>
        </>
      )}
      {display.kind === "boiled" && (
        <>
          <p className="slot__time">00:00</p>
          <p className="slot__badge">Boiled!</p>
          <StartControl slot={slot} onStart={onStart} />
        </>
      )}
      {display.kind === "idle" && (
        <>
          <p className="slot__hint">Ready</p>
          <StartControl slot={slot} onStart={onStart} />
        </>
      )}
      {display.kind === "unreceived" && (
        <p className="slot__hint slot__hint--muted">Remaining time not received</p>
      )}
    </article>
  );
}

interface StartControlProps {
  readonly slot: number;
  readonly onStart: (slot: number, noodleType: string, boilSeconds: number) => void;
}

/** 麺種プリセットを選んで開始する。開始操作の入力を検証済みの選択肢に閉じ込める。 */
function StartControl({ slot, onStart }: StartControlProps) {
  const [presetIndex, setPresetIndex] = useState(0);
  // presetIndex は select の有効な index のみが入るため実行時は常に定義済み。型上の保険として guard する。
  const preset = NOODLE_PRESETS[presetIndex];
  if (!preset) return null;
  return (
    <div className="start">
      <label>
        Noodle
        <select
          className="start__select"
          value={presetIndex}
          onChange={(event) => setPresetIndex(Number(event.target.value))}
        >
          {NOODLE_PRESETS.map((option, index) => (
            <option key={option.noodleType} value={index}>
              {`${option.noodleType} (${option.boilSeconds}s)`}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn btn--start"
        onClick={() => onStart(slot, preset.noodleType, preset.boilSeconds)}
      >
        Start
      </button>
    </div>
  );
}
