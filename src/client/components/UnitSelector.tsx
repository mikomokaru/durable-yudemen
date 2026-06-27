// client/components/UnitSelector.tsx — 担当ユニットのユーザー明示指定 UI。
// 担当範囲はユーザーの明示的な再指定でのみ更新する（要件12.4）。接続台数の増減を契機に
// 変化させない——この規律は App 側で units を接続から独立した state として保持することで守られ、
// ここはその state を変える唯一のユーザー操作の口である。
//
// 担当は 1 ユニット（6 スロット）または 2 ユニット（12 スロット）（要件12.1）。連続するユニットを
// base から count 個割り当てる。スロット採番は 0 始まり、unit u は slot 6u..6u+5（要件12.5）。

// 店舗のユニット総数（最大 18 スロット = 3 ユニット）。
const TOTAL_UNITS = 3;

/** base から count（1 or 2）個の連続ユニットを、範囲内へクランプして組み立てる。 */
export function unitsFrom(base: number, count: 1 | 2): readonly number[] {
  const safeBase = Math.min(Math.max(base, 0), TOTAL_UNITS - count);
  return count === 1 ? [safeBase] : [safeBase, safeBase + 1];
}

interface UnitSelectorProps {
  readonly units: readonly number[];
  readonly onChange: (units: readonly number[]) => void;
}

/** 担当ユニット数（1/2）と開始ユニットを選ぶ。選択は即座に onChange で確定する。 */
export function UnitSelector({ units, onChange }: UnitSelectorProps) {
  const count: 1 | 2 = units.length >= 2 ? 2 : 1;
  const base = units.length > 0 ? Math.min(...units) : 0;
  const baseChoices = Array.from({ length: TOTAL_UNITS - count + 1 }, (_, index) => index);

  return (
    <section aria-label="Assignment">
      <h2>Assignment</h2>
      <fieldset>
        <legend>Units</legend>
        {([1, 2] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="unit-count"
              checked={count === value}
              onChange={() => onChange(unitsFrom(base, value))}
            />
            {value === 1 ? "1 unit (6 slots)" : "2 units (12 slots)"}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Start unit</legend>
        {baseChoices.map((choice) => (
          <label key={choice}>
            <input
              type="radio"
              name="unit-base"
              checked={base === choice}
              onChange={() => onChange(unitsFrom(choice, count))}
            />
            {`Unit ${choice} (slots ${choice * 6}-${choice * 6 + 5})`}
          </label>
        ))}
      </fieldset>
    </section>
  );
}
