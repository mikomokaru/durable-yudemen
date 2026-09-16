# console から Iceberg までの覚え書き（2026-09-16）

観測基盤の実装と本番投入で分かったことを、判断の理由ごと残す。仕様の正本は [operation-history-log](../../.kiro/specs/operation-history-log/design.md) と [lift-delay-log](../../.kiro/specs/lift-delay-log/design.md)。ここは「なぜそうなっているか」を短く引ける場所である。

## 経路

```
Worker が console.log（記録の形をした文字列）
  → Cloudflare が別実行として Tail Worker へ渡す（tail_consumers を設定した Worker だけ）
  → Tail が選り分け、dataset ごとの Pipelines Stream へ送る
  → Pipelines が 60 秒ごとに Iceberg へ書く
  → R2 SQL / Snowflake / 共通 CLI が読む
```

## Tail が選り分ける条件

| 条件 | 落ちるもの |
| --- | --- |
| script が許可一覧にある | 他の Worker のログ |
| `console.log` である | `console.warn` / `error` |
| 引数が 1 つの文字列 | 複数引数、オブジェクト |
| 改行を含まない | 複数行のログ |
| 形式を名乗っている | 普通のアプリログ |
| codec で読めて canonical と byte 一致 | 壊れた行、整形の違う行 |
| 物理 schema の型・値域・サイズを満たす | 型違反、超過 |

名乗りは、操作履歴が `operationKind` の存在、遅延が `recordType` の値。**名乗らない行は失敗として数えない。**

2026-09-16 の午前、この名乗りが無かったために本番の普通の構造化ログが全て「壊れた操作記録」として数えられ、毎分約 200 件の警告が出ていた。数が問題なのではなく、**本物の codec 失敗と区別できなくなることが問題**だった。品質指標の分母が濁る。

## 何を console へ渡すか（文字列からオブジェクトへ）

**Tail はオブジェクトをオブジェクトのまま受け取れる**（2026-09-16 に実測）。プローブから
`console.log({ shapeCheck: "object", nested: { n: 1, list: [1, 2] } })` を出し、tail event の
`logs[].message[0]` が入れ子も配列も構造のまま届くことを確認した。「文字列しか運べない」のではない。

当初は文字列を選んでいた。理由は 2 つで、どちらも実測の後に成り立たなくなった。

1. **切り詰めを検出できる**（と考えていた）。受け取った文字列を記録へ戻し、canonical を出し直して byte 比較する。途中で切れていれば弾かれる。——**下の実測で崩れた**。値は途中で切れないので、この比較が捕まえる壊れ方は実際には起きない。
2. **保存するのが原文だから。** 分析の根拠は canonical payload である。——**弱い**。canonical の出力は決定的なので、Tail 側で出し直しても同じ byte 列になる。同じ事実が常に同じ byte 列になり、複製を内容で見分けられる性質は、どちらでも保たれる。

### 切り詰めの実測（2026-09-16）

使い捨ての Producer と Tail を 1 組だけ配備して測り、確認後に両方と KV を削除した。

| 送ったもの | 届いた姿 | `truncated` |
| --- | --- | --- |
| 文字列 1,000 / 16,000 / 200,000 字 | いずれも**全長そのまま** | true |
| 配列 5,000 要素 | 5,000 要素・末尾 4999 まで | true |
| 入れ子 40 段 / 200 段 | 40 段 / 200 段のまま | true |
| 小さい行 3 本だけ（対照） | 3 本とも全部 | **false** |

分かったこと 2 つ。

1. **値は途中で切れない。** 200 KB の文字列も 5,000 要素の配列も 200 段の入れ子も、欠けずに届く。
   よって「オブジェクトで渡すと欠けた値が正しい canonical として保存され得る」という上の懸念は、
   **この platform では起きない**。
2. **切り詰めは行ごと丸ごと落とす形で起きる。** 大きい走では 7 行出して 6 行しか届かず、最後の 1 行が
   消えた。そして消えたとき event の `truncated` が **true** になる。対照の小さい走では false。
   つまり**旗は意味を持っている**——常時 true ではない。

我々は既に `truncated` を三値（detected / not-detected / unknown）で列に残している。落ちた行そのものは
取り戻せないが、**落ちた事実は分かる**。

### 実測を受けて、オブジェクト＋Tail 検査へ移した（2026-09-16）

文字列で渡す理由は 2 つ挙げていたが、**1 つ目は消えた**。2 つ目（保存するのが Producer の原文である）
も弱い——canonical の出力は決定的なので、Tail 側で出し直しても同じ byte 列になる。複製を内容で
見分ける性質は、どちらでも保たれる。そこで移した。

| | 文字列（旧） | オブジェクト＋Tail 検査（現） |
| --- | --- | --- |
| 名乗りの判定 | `line.includes('"operationKind"')` という**部分一致の当て推量** | `typeof value.operationKind === "string"` という**場の検査** |
| 検査 | 手書きの parser（重複キー検出のため JSON 文字列を自前で走査） | Zod の schema。kind ごとに閉じた `strictObject` |
| 切り詰め | byte 比較（実測では**空振り**） | `truncated` 旗（実測で**有効**） |
| canonical payload | Producer の byte 列 | Tail が出し直した byte 列（同一） |
| 直列化できない値 | Producer が組む途中で例外になり、その 1 件が消える | Tail まで届き、**理由付きで弾かれる** |

置き場所は次のとおり。

- `src/data-platform/record-schema.ts` — **Zod を使ってよい唯一の file**。3 つの schema と、失敗を
  短い語の列にする関数だけを持つ。
- `src/data-platform/console-lines.ts` — 封筒。オブジェクトと文字列の**両方**を通す。
- `src/operation-history/tail.ts`・`src/lift-delay/tail.ts` — 名乗りと検査。
- `src/operation-history/codec.ts`・`src/lift-delay/codec.ts` — `*Payload()` が Producer の出口。
  **参照ではなく作り直したオブジェクト**を返す（ログした後に呼び出し側が書き換える窓を閉じる）。

**Zod の禁を狭めた。** `src/` 全体で schema 検証ライブラリを禁じる静的検査があり、その理由は POS
素通し（ベンダーが項目を 1 つ足しただけで受信が止まらないこと・「検証の側が先に壊れる」）である。
**我々が両端を書く telemetry 記録にはこの理屈が当たらない**ので、例外を上の 1 file に開けた。
directory ではなく file 単位で挙げるので、増やせば diff に出る。ingress と Producer の codec は
禁のまま残し、それを検査で固定した。

**Producer の bundle に Zod を載せない。** Producer は店舗 DO（`StoreTimerDO`）と同じ bundle に載る
ので、そこへ検証ライブラリが入ると厨房操作の経路が観測の都合で太る。`tests/data-platform/
schema-placement.static.test.ts` が import graph を辿り、Producer から検証 file へ到達しないことと、
Tail からは到達することの両方を固定する。ビルド後の `dist/yude_men_timer/index.js` に `zod` の語は
0 件である。

**判定を Producer へ戻さない。** 直列化できない値を持つ記録は、以前は Producer で例外になって消えて
いた。いまは console へ出て、Tail の検査が理由付きで弾く。判定を二箇所に置かないためである。

## 本番での確認（2026-09-16 09:26〜09:40 UTC）

Tail → プローブ → 業務 Producer の順に配備し、各段で確かめた。

| 確かめたこと | 方法 | 結果 |
| --- | --- | --- |
| 新 Tail が**文字列**を受け続ける | 新 Tail 配備後、旧のままのプローブ行が届くか | 09:28:12 に取込。**落ちない** |
| 新 Tail が**オブジェクト**を受ける | プローブをオブジェクト出力へ替えて配備 | 09:32:12 に取込。operation・lift-delay の両 dataset |
| canonical payload が変わらない | 切替前後のプローブ行の鍵の並びを比較 | **完全一致**（`storeId,timerId,operationKind,eventTime,slotIds,noodleType,firmness`） |
| `truncation` が記録される | 取込行の sourceMetadata | `not-detected` / basis `trace-item` |
| **名乗らないログを失敗に数えない** | Tail の 800 invocation を採取 | **診断 0 件・例外 0 件**。同じ時間に Producer は 379 件の構造化ログ（全て `cpsat-store-not-sampled`）を出していた |

最後の行が一番の要点である。2026-09-16 午前の事故は、まさにこの種のログが毎分約 200 件の「壊れた操作
記録」として数えられたものだった。**同じ負荷で、いま 0 件である。**

### 業務 Producer の確認（09:44〜09:53 UTC・4 店舗の実操作）

実店舗で操作してもらい、Producer の console 出力を採取したうえで Iceberg と突き合わせた。

| | 結果 |
| --- | --- |
| Producer が出した姿 | 操作 91 件・遅延 51 件が**全てオブジェクト**。文字列は **0 件** |
| 店舗・種別 | 4 店舗（1102・1105・1108・1263）、`boil-started` `boiled` `adjusted` `completed` の 4 種、遅延は開始・終端の両方 |
| 取りこぼし | **0 件**。遅延は eventId で 1 対 1、操作は canonical 文字列の多重集合で照合 |
| payload と保存 canonical の byte 一致 | **不一致 0 件**。日本語の麺種（`つけ` `朝麺` `プレ`）もそのまま |
| 検査の失敗 | `faults` 0・`conflicts` 0 |

**同じ終端を 2 回出した例が 1 件あった**（`yamaokaya-1108:52612667-…:completed`）。内容は同一で、raw は
2 行とも残り、読み出しで 1 件へ収束し競合にならなかった。設計どおりである（要件 5.2）。

kind ごとに閉じた属性集合も、出た姿のまま確認できた。

```
completed    storeId,timerId,operationKind,eventTime,slotIds,noodleType,firmness
boil-started 上記 + startTime,endTime
adjusted     上記 + endTime
boiled       上記 + endTime,boiledAt
```

### 読み出しで分かったこと：遅延の統計に古い Timer が混ざる

この窓の終端 24 件のうち、**開始と終端が揃っているのは 8 件だけ**だった。残る 16 件は以前から残って
いた Timer の片付けで、`dueAt` からの経過が 1.8〜31.4 時間ある。

- 本当に茹でた 8 件の遅れ: **25.0 / 27.2 / 27.2 / 33.3 / 36.8 / 36.9 / 80.3 / 80.3 秒**（中央値 35.1 秒）
- CLI の要約が出した中央値: **4.75 時間**

要約は `contextUnknown: 16` と正しく申告しているが、**分位点は文脈不明の終端も込みで計算している**ので、
見出しの数字が「茹で遅れ」として読めない。不明を 0 で埋めてはいないが、混ぜてはいる。`byBackorder` は
既に文脈のある終端だけを使っているので、**分位点も同じ線を引くかどうかが次の判断**である。要件 6 の
決めごとに関わるため、ここでは直していない。

## 注文到着の dataset（2026-09-16 追加）

3 本目の dataset。POS が届けた注文そのものを記録する。root worker の `/pos/records` から出す
——注文取り込みと同じ Worker なので、新しい Worker も新しい tail attachment も要らなかった。

**封筒だけを検査する。** Zod が見るのは我々の場と、上流が観測から付与したメタデータ
（`arrivalTimestampMs` / `sequenceNumber` / `path`）だけである。これらが素通し原則の対象外だと
要件が明示している（pos-order-ingress 要件 14.10・14.11）。`rawPayload` は `z.string()` で、
中身も長さも問わない。**`order_items` 以下には触れない。**

**相関の鍵は既にあった。** `externalOrderId` は `toUniqueKey(payload)` の結果で、
`src/shell/store-timer-do.ts` が注文品目に与えるのと同じ値である。遅延ログの開始記録に
`orderItem`（payload 版 2 で追加）を載せたので、注文と麺が対応表なしで突き合う。

### 実測（本番 386 件・149 店舗）

| | 値 |
| --- | --- |
| payload の大きさ | 最小 445 / 中央 920 / 最大 3,738 バイト |
| 物理行の上限 | 16,384 バイト |
| 上限を超えた件数 | **0 件** |

上限に対して最大でも 4.4 倍の余裕がある。生ペイロードをそのまま載せて問題ない。

### 踏んだ落とし穴 2 つ

**eventId の判定に dataset を通していなかった。** 物理検証が「`eventId` を持つのは lift-delay
だけ」と書いていたため、注文到着の行が**本番で全て弾かれた**（386 件出して 0 件保存）。
持つ側を列挙する形をやめ、**持たない側（operation）を挙げる**形に直した。dataset を足したときに
既定で「持つ」に入る。回帰検査は `tests/data-platform/arrival.example.test.ts`。

**生ペイロードに `customer_id` が入っている。** 416 件中 **85 件（約 20%）が非空**だった。
このリポジトリの調理計画サンプルは、これを「顧客ID（計画に不要な個人情報）」として除外している。
気づいた時点で旗を落として蓄積を止め、扱いを確認した。

**判断（2026-09-16・利用者）: そのまま流す。** この `customer_id` では個人を特定できない、という
事実の申告による。ゆえに生ペイロードから項目を取り除かない——取り除けば素通しでなくなり、「何を
落としたか」を別に管理する必要が生まれる。サンプル側が除外していたのは計画に不要だったからで、
特定可能だからではない。

## 配備の順序

**payload の形を変えるときは Tail を先に出す。**

現在の Tail は**オブジェクトと文字列の両方**を受けるので、Producer をどちらの向きへ動かしても行が
落ちない。落ちるのは古い Tail にオブジェクトを送ったときで、これは黙って落ちる（封筒で弾かれ、
失敗としても数えない）。

2026-09-16 に逆順で踏んだ。遅延記録から `completionAction` を外し、Producer とプローブだけを配備した。Tail は古いまま必須属性として読み続け、**約 20 分、遅延の行が全て弾かれた**。行は正しく、読み方が古かった。best-effort なので失われた分は戻らない。

## wrangler の設定の出所

`wrangler deploy` は `.wrangler/deploy/config.json` があると、そこが指す **ビルド生成物**（`dist/yude_men_timer/wrangler.json`）を設定として読む。`@cloudflare/vite-plugin` の `vite build` が置く転送ファイルである。

`wrangler.jsonc` を直接編集しても、**ビルドし直さなければ配備に反映されない**。新しい変数が配備後の binding 一覧に現れないことで気づいた。

本番配備は CI と同じ `--var` 上書きが必須。リポジトリの設定は `ACCESS_REQUIRED` が `"0"` でドメインもプレースホルダのため、**上書きを忘れると Access の保護が外れる**。

```sh
pnpm build
pnpm wrangler deploy \
  --var ACCESS_REQUIRED:1 \
  --var TEAM_DOMAIN:https://ymoky.cloudflareaccess.com \
  --var POLICY_AUD:<CI と同じ値>
```

## 貯める場所の使い分け

| 置き場 | 何を置くか | 制約 |
| --- | --- | --- |
| Iceberg（R2） | 過去の記録。分析の材料 | 期間削除なし。実質の上限なし |
| 店舗 DO の snapshot | **次の判断に使う材料だけ** | key と value 合わせて 2 MB。超えると厨房操作が失敗する |

遅延ログの開始文脈は当初 DO へ預ける設計だったが、満杯時に厨房操作を止め得る唯一の経路になっていた。**開始の瞬間に 1 行出す**形に変え、預けるのをやめた。代償は「開始の行が落ちた麺は文脈不明」だが、実測の突合率は 100%（2026-09-16・本番 4 件）。

店舗 DO に残っているのは全て次の判断に要るもの（動いている Timer、注文品目、採用した計画、端末ごとの最終受理番号）。唯一の緩みは端末ごとの番号表に寿命が無いこと。

## 実データ（2026-09-16 時点）

- 操作履歴: 本番稼働中。実店舗の行が溜まり続けている。
- 遅延ログ: 本番稼働中。最初の 4 件で中央値 6.4 秒、最大 67.6 秒。
- 完了の 70% が 1 秒以内に他の完了と並ぶ（**推測であり、同一操作の証拠ではない**）。一括完了の相関申告は不採用（[lift-delay-log 要件 3](../../.kiro/specs/lift-delay-log/requirements.md)）。
- 操作から R2 SQL で読めるまで約 95 秒（roll interval 60 秒の設定）。
