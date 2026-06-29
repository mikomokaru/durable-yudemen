# Yude-men Timer — React/TSX 部品（Tailwind 版）

プレーンCSS版を **Tailwind v4** に書き直したもの。見た目・挙動は同一です。

- **上部固定バー**に タイトル / Synced / 設定
- **スロット領域は画面いっぱい・スクロールなし**（`auto-rows-fr`）
- **Start タッチ → 麺の種類を円形展開 → 自動スタート**

## ファイル

| ファイル | 役割 |
|---|---|
| `yude-men-timer.css` | Tailwind 読み込み＋`@theme` トークン＋点滅 keyframes＋base |
| `types.ts` | 共有型（`Noodle` / `SlotStatus` / `SlotState`） |
| `cn.ts` | className 連結ヘルパ |
| `RadialMenu.tsx` | 円形展開セレクタ（単体可） |
| `SlotCard.tsx` | スロットカード |
| `YudeMenTimer.tsx` | 全部入り（固定バー＋設定＋グリッド＋state＋カウントダウン＋ラジアル） |
| `App.example.tsx` | 設定で 6/12 スロット切替まで配線した使用例 |

## セットアップ（Tailwind v4）

```bash
npm i react react-dom
npm i -D tailwindcss @tailwindcss/vite
```

`vite.config.ts`：
```ts
import tailwindcss from "@tailwindcss/vite";
export default { plugins: [tailwindcss()] };
```

エントリで CSS を読み込む（`main.tsx`）：
```ts
import "./components/yude-men-timer.css";
```

> v4 は設定ファイル不要・自動でソースを走査します。カラーやフォントは
> `yude-men-timer.css` の `@theme` で定義 → `bg-panel` `text-muted` `text-running`
> `border-line` `animate-boiled` などのユーティリティが自動生成されます。

## 使い方

```tsx
import App from "./components/App.example"; // そのまま試すなら
// または
import { YudeMenTimer } from "./components/YudeMenTimer";

<YudeMenTimer slotCount={6} noodles={NOODLES} status="Synced" settings={/* … */} />
```

`settings` を省略すると「Settings」ボタンは出ません。`status={null}` で Synced も非表示。

## 設計メモ（Tailwind 版の方針）

- **トークンは `@theme`** に集約。色を変えたいときは CSS 1か所だけ。
- **状態の色分けは条件付きクラス**（`text-running` / `text-boiled` / `border-l-boiled`）。
  CSS 変数 `--state` は使わず、TSX 側で出し分け。
- **点滅グローだけ keyframes**（`@keyframes boiledPulse` → `animate-boiled`）。
  `color-mix` を含む複数 box-shadow はユーティリティ化が辛いため CSS に残しています。
- **花びらの座標は動的なのでインライン `style`**（`transform` / `transitionDelay`）。
  Tailwind でも“実行時に変わる値”はインライン or CSS 変数が正解で、無理にクラス化しません。
- `prefers-reduced-motion` で `animate-boiled` を停止。

## 既存アプリへ差し込む（部品だけ）

`SlotCard` と `RadialMenu` は単体で使えます。`YudeMenTimer.tsx` の `cells`
（`endsAt` ベース）を、あなたの共有状態 / サーバ同期に置き換えてください。
残り時間は `endsAt` から都度計算しているので再描画やタブ復帰でズレません。

## 注意

- `@layer base` で `html, body` にフルスクリーン用スタイルを当てています。
  他ページと共存させる場合は、ラッパー（`YudeMenTimer` のルート div）側に
  移すなど調整してください。
- フォント（Manrope / DM Mono）は CSS の `@import`。CSP で外部フォントが使えない
  場合はセルフホスト or `@theme` の `--font-*` を差し替え。
