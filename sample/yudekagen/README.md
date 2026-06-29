# 茹で加減コントロール（角ボタン）— Kiro 実装用サンプル

boiling 相のスロットカードに置く「左下・角融合ボタン → 右へスライド展開 → 選んで即確定」
の茹で加減セレクタです。**デフォルト（ふつう）のままなら無操作**でよく、こだわる時だけ触る設計。

## ファイル

| ファイル | 役割 |
|---|---|
| `firmness.ts` | 硬さモデル（4段・時間増減・デフォルト・`endsAt` 再計算ヘルパ） |
| `FirmnessCornerControl.tsx` | boiling カードに乗せる UI（角ボタン＋右スライド展開＋カバー） |

`react` のみ依存。**インラインスタイル**で書いてあるので Tailwind の有無に関わらず動きます。
（Tailwind 化したい場合はクラスへ置き換え可。色 `#e8c07a` 等は麺種アクセント色に合わせる）

## 仕様（Kiro へのスペック）

1. 硬さは4段：**バリカタ / かため / ふつう / やわめ**、デフォルト **ふつう**。
2. 並び順は **左=硬い → 右=柔らかい**（`FIRMNESS_LEVELS` の順）。
3. boiling 相のみ表示。角ボタンには**現在の硬さ**を常時表示。
4. 角ボタンをタップ → 4段が**右へスライド展開**。角ボタンはフェードし先頭(バリカタ)が席を引き継ぐ。
5. 選択肢タップ → **即確定して閉じる**（確定ボタンなし）。
6. 硬さは**茹で時間を増減**：バリカタ −20s / かため −10s / ふつう ±0 / やわめ +15s（値は要調整）。
7. 変更時は**残り時間が即再計算**される（経過はそのまま、総時間が変わる）。
8. 展開中は **STOP ボタンを隠す**（衝突回避）。背景タップ / Esc で閉じる。
9. ふつう以外を選んだ角ボタンは**明度/枠を上げて**「デフォルトでない」を示す。

## 組み込み例

残り時間は `endsAt`（終了時刻）から都度計算する前提（再描画やタブ復帰でズレない）。
硬さ変更は **`endsAt` を引き直すだけ**で残り時間に反映されます。

```tsx
import { useState } from "react";
import { FirmnessCornerControl } from "./FirmnessCornerControl";
import { endsAtFor, DEFAULT_FIRMNESS, type Firmness } from "./firmness";

function BoilingCard({
  startedAt,     // 茹で開始時刻(ms)
  baseSec,       // その麺種の「ふつう」総茹で時間(秒)
  noodleColor,   // 麺種アクセント色
  onUpdate,      // (endsAt, firmness) を親state/サーバ同期へ
}: {
  startedAt: number;
  baseSec: number;
  noodleColor: string;
  onUpdate: (endsAt: number, firmness: Firmness) => void;
}) {
  const [firmness, setFirmness] = useState<Firmness>(DEFAULT_FIRMNESS);
  const [menuOpen, setMenuOpen] = useState(false);

  const applyFirmness = (next: Firmness) => {
    setFirmness(next);
    // ★ ここが肝：endsAt を引き直す → 残り時間が即再計算される
    onUpdate(endsAtFor(startedAt, baseSec, next), next);
  };

  return (
    <article style={{ position: "relative", /* ...カードのスタイル... */ }}>
      {/* ...進捗バー / 麺種 / 残り時間... */}

      {/* 展開中は STOP を隠す（衝突回避） */}
      {!menuOpen && <StopButton onClick={/* stop */ () => {}} />}

      <FirmnessCornerControl
        value={firmness}
        onChange={applyFirmness}
        onOpenChange={setMenuOpen}
        accent={noodleColor}
      />
    </article>
  );
}
```

## 注意 / 調整ポイント

- **増減秒（−20 / −10 / +15）は仮値**。実際の麺種ごとの茹で時間差に合わせて `firmness.ts` の `deltaSec` を調整してください。
- 角ボタンのサイズ（126×92）・選択肢（90×78）は 430×330 想定のカードに合わせた値。
  カードサイズが違う場合は `FirmnessCornerControl.tsx` 上部の定数（`W/H/GAP/LEFT0/BOTTOM`）と
  角ボタンの `width/height/borderRadius` を比率に合わせて調整。
- `borderRadius: "0 20px 0 16px"` が「角融合」の肝：外側(左下)はカード角と一致、内側(右上)だけ丸める。
  カードの角丸(22px)を変えたら左下の値も合わせると馴染みます。
- アクセシビリティ：タッチターゲットは選択肢 90×78 / 角ボタン 126×92 と十分大きい（44px 以上）。
