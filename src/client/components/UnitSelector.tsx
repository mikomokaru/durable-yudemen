// client/components/UnitSelector.tsx — 担当ユニット窓のユーザー明示指定 UI。
//
// 担当窓は (アンカー b, 長さ k) で決まる。長さ k は viewport の向き（縦=1 / 横=2・useUnitCount）が決め、
// このセレクタは現在の k で取りうる窓（アンカー b の選択肢）からユーザーが 1 つ選ぶ口である。
//   - 縦画面（k=1）: A, B, C …（単ユニット窓）
//   - 横画面（k=2）: AB, BC …（連続 2 ユニット窓）
// 選択は接続台数の増減では変わらず、向きの変化（=ユーザー操作）とこのセレクタ操作でのみ動く（要件12.4）。
//
// 総数 totalUnits はサーバ権威の店舗設定（StoreConfig.unitCount）。窓長は min(k, totalUnits) に畳む
// （総数 1 で横画面でも 2 ユニットは取れない）。アンカーの可行域は [0, totalUnits - 窓長]。

interface UnitSelectorProps {
  readonly units: readonly number[];
  readonly totalUnits: number;
  /** viewport が決める表示ユニット数（窓長 k）。縦=1 / 横=2。 */
  readonly count: 1 | 2;
  readonly onChange: (units: readonly number[]) => void;
}

/** ユニット index を表示ラベル（A,B,C…）へ写す。0→A。 */
function unitLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** 設定ポップオーバー内のフォーム体裁（Tailwind reset 後の素っ気なさを軽く整える）。 */
const fieldset =
  "m-0 flex flex-wrap items-center gap-x-[1.125rem] gap-y-2 rounded-xl border border-line p-[0.625rem_0.875rem]";
const legend = "px-[0.375rem] text-[0.75rem] font-bold uppercase tracking-[.04em] text-muted";
const label = "inline-flex cursor-pointer items-center gap-2 text-[0.9375rem] text-ink min-h-10";
const radio = "h-[1.125rem] w-[1.125rem] accent-running";

/**
 * 現在の窓長（count）で取りうる担当窓を選ぶ。選択は即座に onChange で確定する。
 * 窓長そのものは viewport の向きが決めるため、ここには出さない（アンカーの選択だけを担う）。
 */
export function UnitSelector({ units, totalUnits, count, onChange }: UnitSelectorProps) {
  const total = Math.max(1, totalUnits);
  const length = Math.min(count, total);
  // 可行なアンカー [0, total - length] それぞれから長さ length の連続窓を組む。
  const windows = Array.from({ length: total - length + 1 }, (_unused, anchor) =>
    Array.from({ length }, (_offset, offset) => anchor + offset),
  );
  const currentAnchor = units.length > 0 ? Math.min(...units) : 0;

  return (
    <section aria-label="Assignment">
      <h2 className="sr-only">Assignment</h2>
      <fieldset className={fieldset}>
        <legend className={legend}>{length === 1 ? "Unit" : "Units"}</legend>
        {windows.map((window) => {
          const anchor = window[0]!;
          const slotsLabel = `slots ${anchor * 6}–${(anchor + length) * 6 - 1}`;
          return (
            <label key={anchor} className={label}>
              <input
                type="radio"
                name="unit-window"
                className={radio}
                checked={anchor === currentAnchor}
                onChange={() => onChange(window)}
              />
              <span className="font-bold">{window.map(unitLetter).join("")}</span>
              <span className="text-[0.75rem] text-muted">{slotsLabel}</span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}
