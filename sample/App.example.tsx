import { useState } from "react";
import { YudeMenTimer } from "./YudeMenTimer";
import type { Noodle } from "./types";

const NOODLES: Noodle[] = [
  { id: "thin", name: "Thin", sec: 60 },
  { id: "medium", name: "Medium", sec: 90 },
  { id: "thick", name: "Thick", sec: 120 },
  { id: "extra-thin", name: "Extra thin", sec: 45 },
  { id: "flat", name: "Flat", sec: 100 },
];

// 設定ポップオーバー内のフォームは Tailwind 環境だと reset で素っ気なくなるので、
// 軽くユーティリティで体裁を整えています。
const fieldset = "m-0 mb-[10px] flex flex-wrap items-center gap-x-[18px] gap-y-2 rounded-xl border border-line p-[10px_14px] last:mb-0";
const legend = "px-[6px] text-[12px] font-bold uppercase tracking-[.04em] text-muted";
const label = "inline-flex cursor-pointer items-center gap-2 text-[15px] text-ink";
const radio = "h-[18px] w-[18px] accent-running";

export default function App() {
  const [slotCount, setSlotCount] = useState(6);

  return (
    <YudeMenTimer
      slotCount={slotCount}
      noodles={NOODLES}
      status="Synced"
      settings={
        <>
          <fieldset className={fieldset}>
            <legend className={legend}>Units</legend>
            <label className={label}>
              <input type="radio" name="unit-count" className={radio}
                checked={slotCount === 6} onChange={() => setSlotCount(6)} />
              1 unit (6 slots)
            </label>
            <label className={label}>
              <input type="radio" name="unit-count" className={radio}
                checked={slotCount === 12} onChange={() => setSlotCount(12)} />
              2 units (12 slots)
            </label>
          </fieldset>

          <fieldset className={fieldset}>
            <legend className={legend}>Start unit</legend>
            <label className={label}>
              <input type="radio" name="unit-base" className={radio} defaultChecked />
              Unit 0 (slots 0-5)
            </label>
            <label className={label}>
              <input type="radio" name="unit-base" className={radio} />
              Unit 1 (slots 6-11)
            </label>
          </fieldset>
        </>
      }
    />
  );
}
