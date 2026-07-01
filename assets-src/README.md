# アイコン素材（生成元）

アプリアイコンのモチーフ＝俯瞰した鍋（琥珀のリング）と麺の三点。配色はブランド金 `#e4ba76`
（`styles.css` の `@theme --color-brand` に対応）とダークな地色。

## マスター（正本）

- `public/favicon.svg` — 角丸版。ブラウザの favicon と PWA の `any` アイコン（角丸を持つ）の元。
- `assets-src/icon-square.svg` — 全面ダーク版（角丸なし）。iOS ホーム画面と Android `maskable` の元。
  角丸は OS 側が付与するため丸めない。リングと三点は maskable の安全域（中心 80%）に収めてある。

## PNG 再生成（rsvg-convert）

```sh
rsvg-convert -w 192 -h 192 public/favicon.svg           -o public/pwa-192x192.png
rsvg-convert -w 512 -h 512 public/favicon.svg           -o public/pwa-512x512.png
rsvg-convert -w 180 -h 180 assets-src/icon-square.svg   -o public/apple-touch-icon.png
rsvg-convert -w 512 -h 512 assets-src/icon-square.svg   -o public/pwa-maskable-512x512.png
```
