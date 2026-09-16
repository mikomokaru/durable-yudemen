# Implementation Plan: 品目の表示名の短縮（item-display-abbreviation）

## Overview

麺量を固定表で短縮し、商品名は NFKC 正規化した申告名を鍵に辞書から札を引く。表示の語は `displayName` だけが組み立てる。辞書の生成・保存・配信は Worker に置き、POS の取り込み応答を生成待ちにしない。

実装は復号・検査 → KV → 生成・検出 → Worker 配線 → client の順に進める。各段の検証は実装と同じタスクに置く。

**task 1〜8 は「client が辞書を HTTP で取る」旧方式のもとで書かれ、完了した。** 2026-09-15 に配信方式を
「札を品目に載せて DO の通信で届ける」へ変え、task 9 がその実装である。**旧方式に属する記述（`GET
/display/short-names`・`fetchShortNames`・`localStorage`・起動時取得・`Cache-Control`）は履歴として残す**
——下の「配信方式の変更」が何を撤回し何が残ったかを示す。現行の姿は requirements と design を正とする。

**範囲**：札の重複、並行生成の後勝ち、端末間の表示差は許容する。未着手の名前は当該商品の再到着時に再検出する。厨房の事実・ワイヤ・レジストリ・Operation History は変更しない。

## 配信方式の変更（2026-09-15・未完了）

**辞書を client が取得する形から、受信した商品に札を付けて送る形へ変える。** client は `shortName` が在れば
それを表示し、無ければ全名へ戻す。辞書の取得・保持・受け渡しは client から消える。

現時点の記録:

- **タスク 1〜7 は「client が辞書を取得する実装」として完成し、503 件の検査が通っている**（display 87・
  client 386・静的 22＋7・中継 7 ほか）。この数字は**旧方式の検証結果**であり、新方式の達成度ではない。
- 旧方式のうち**そのまま残るもの**: 麺量の例外を `SIZE_LABEL` の定義内へ狭めた修正（要件 13.6 の追記を含む）、
  `src/display/` の純粋層（`short-name.ts` / `dictionary.ts` / `generate.ts` / `detect.ts`）と札の Worker の
  生成・辞書・能力境界。
- 旧方式のうち**不要になるもの**: `src/client/shortNames.ts`（`fetchShortNames` / `SHORT_NAMES_URL`）と
  その検査、`App` の起動時取得、`shortNames` prop の 4 箇所への受け渡し、`displayName` の第 2 引数。
  **公開名として確定しない**（naming ゲートからも外す）。
- **要整合の旧制約 2 つ**: Requirement 8 AC6「ワイヤの種別集合・`ServerMessage` の形を変えない」と、
  AC5 / 判断 0「`StoreTimerDO` が札の Worker を参照しない」。札をワイヤに載せる以上、前者は改める。
  後者は「どこで札を付けるか」の決定に依存する（下記の未決）。
- **未決（requirements を書く前に要る）**: 札を付ける場所。取り込み時に品目へ焼き付けるか、送信の直前に
  被せるか。前者は永続スキーマ（v14）に及び、後者は DO か中継のどちらかが辞書を読む必要がある。

## Tasks（配信方式の変更・2026-09-15 追加）

- [ ] 9. 札をワイヤに載せる
  - [x] 9.1 押し込みの受け口を `StoreTimerDO` に置く（2026-09-15）
    - `applyShortNames(entries)` を RPC として足す。`StoreSnapshot` とは**別のキー**へ永続する（`projection` と同じ形）。`CURRENT_SCHEMA_VERSION` にも `migrate` にも関わらせない。
    - DO は辞書を引かない（KV も札用 Worker も参照しない）。既存の静的検査をそのまま通す。
    - 順序は **マージ → 変化があれば別キーへ保存 → 保存成功後にメモリ反映と再送**。保存に失敗したら従来の札を維持し、**未保存の札を配信しない**。
    - 「`storage.put` を伴わない」は **Timer の `StoreSnapshot` を書き直さない**という意味に限る。札そのものは別キーへ保存する。
    - **休眠からの復帰で保存済みの札を読み戻す**（POS の再観測を待たない）ことをテストする。
    - _Requirements: 7.1, 7.3, 7.4, 7.14, 7.15, 8.5_
  - [x] 9.2 送信を組む時点で札を被せる（2026-09-15）
    - `ServerMessage` の品目に `shortName` を添える。引くのは送信のたびで、到着時刻で固定しない。
    - **被せる処理は 1 箇所に閉じ、通常の Broadcast と接続時 hydration の双方をそこに通す**（二箇所で組むと「レールには札が出るのに開き直すと全名」が生まれる）。
    - `WireOrderItem` をワイヤ側の型として立て、`OrderItem`（永続・engine）は変えない。
    - `toOrderItemFromWire` は `shortName` を任意の非空文字列として読む（空文字は持たないものとして扱う）。
    - _Requirements: 7.5, 7.6, 7.7, 8.1, 8.2, 8.6_
  - [x] 9.3 札用 Worker から押し込む（2026-09-15・テストは未）
    - `wrangler.short-names.jsonc` に `script_name: "yude-men-timer"` の DO binding を足す（`wrangler.solver.jsonc` と同じ形・migrations は置かない）。
    - **通知に載せるのは Store_Code ではなく宛先解決済みの `StoreId`。** 現状その値は `deliverRecords` の内側に閉じているので、店舗ごとの解決結果を外へ渡す形にする（root は店舗ごとに通知する）。押し込み先は観測した店舗だけで、全店 fan-out はしない。
    - **観測したすべての名前**のうち札を持つものを積む（既知も積む）。押し込みの失敗は記録に留め、専用の再送機構を持たない。
    - **収集を 2 巡に分ける。** 1 巡目は在メモリの札だけを集める（I/O 無し・上限も締切も掛からない）。2 巡目で知らない分を上限と締切の下で解く。1 巡にまとめて `break` すると「初出 4 件 → 未登録 1 件 → 既知」の順で最後の既知が積まれず AC 7.11 と矛盾する。**途中の読み取り・生成が失敗しても、そこまでに集めた札は押せる**ことを検証する。
    - 在メモリの索引を `Map<Dictionary_Key, ShortNameEntry>` へ変え、`generateShortName` は確定したエントリを返す形にする。
    - テスト対象に **「別店舗への初回配信」** と **「DO 再生成後の押し直し」** を含める。
    - _Requirements: 7.1, 7.2, 7.10, 7.11, 7.12_
  - [x] 9.4 client から辞書を取り除く（2026-09-15）
    - `src/client/shortNames.ts` と `tests/display/fetchShortNames.example.test.ts`、`tests/client/short-names-wiring.example.test.tsx` を削除する。
    - `App` の起動時取得と `shortNames` prop（`SlotBoard` / `OrderRail` / `SlotCard` / `RadialMenu`）を撤去し、`displayName` を 1 引数へ戻す。
    - 4 箇所の描画テストは「品目が `shortName` を持つとき札が出る」形へ書き換える（非空辞書を渡す形は消える）。
    - _Requirements: 1.2, 1.3, 1.9, 7.8, 7.9_
  - [x] 9.5 公開経路を畳む（2026-09-15）
    - root の `/display/*` 中継と `GET /display/short-names` を撤去する。外部から札の Worker へ届く経路が無くなる。
    - `assets.run_worker_first` から `/display/*` を外し、`tests/worker/display-relay.integration.test.ts` と静的検査の該当項を畳む。
    - _Requirements: 8.5_
  - [x] 9.6 能力グラフの検査へ新しい接続を反映する（2026-09-15）
    - 札用 Worker → `StoreTimerDO` の edge を明示的に検査へ入れる（`cpsat-transport-app` で service binding を足したときと同じ扱い）。
    - _Requirements: 8.5_

## デプロイ（保留・2026-09-15）

**CP-SAT の作業が落ち着いてから一緒に出す。** 本機能の実装と自動検証は完了しているが、この作業ツリー
（`mikomokaru/cpsat-test`）からは出さない。

保留の理由は 3 つで、いずれも本機能の側の問題ではない。

1. **root の `main` が試験入口のまま**（`experiments/cpsat-workers/transport/app.ts`）。設定自身が
   「復帰時は `src/worker.ts` に戻す」と記している。この状態で root を出すと試験の入口が本番になる。
2. **別作業の未コミット変更が engine に入っている**（`admit` / `commit` / `decide` / `effect` / `plan` /
   `project` / `schedule` / `settle` / `lift-group` / `solver`）。CP-SAT 側の作業で、そのテストが 1 件
   落ちたままである（`cpsat-head-slot-stability`）。デプロイ可能な状態かを本 spec からは判断できない。
3. 作業ツリーの変更は 148 件（未追跡 73）で、本機能の分はその一部にすぎない。

**順路**: 本機能だけをコミット → PR → main へマージ → CI がデプロイ。CI には既に
**札用 Worker → root** の順序を入れてある（`.github/workflows/ci-cd.yml`）ので、手順の記憶に頼らない。
root の `main` を戻すかは CP-SAT 側の判断と合わせて main 上で解決する。

**デプロイ前に残る確認**（8.3）: 対象アカウントの Workers Paid 有効化は**確認済み**（2026-09-15・実呼び出し
で `@cf/zai-org/glm-5.3-flash` が動いた）。**未了は iPad 実機の目視だけ**で、これはデプロイ後に行う。

## 既存の失敗（本 spec 起因ではない・2026-09-15 時点）

いずれも**未追跡の作業中ファイル**が原因で、本 spec の変更を入れる前から落ちる。再現手順つきで残す。

- ~~`tests/operation-history/no-backfill.static.test.ts > 未観測期間を埋めるために DO を起こせる scheduled 起動がない`~~
  - **解消済み（2026-09-15）。** 原因は `wrangler.history-probe.jsonc`（未追跡）の `"triggers": { "crons": [...] }` だったが、当該検査が別途更新され（8 → 9 件）通るようになった。本 spec の変更とは無関係。
- `tests/cpsat-head-slot-stability.example.test.ts > **間もなく始まる杯の釜は動かない**（既定の重み）`
  - 原因：テスト本体も `experiments/cpsat-workers/`（実 WASM のハーネス）も未追跡。本 spec が触る経路（`src/display/` / `src/worker.ts` の中継 / 設定）には依存しない。
  - 再現：`pnpm vitest --run tests/cpsat-head-slot-stability.example.test.ts`（約 60〜75 秒）
- `tests/cpsat-head-slot-stability.example.test.ts > **間もなく始まる杯の釜は動かない**（既定の重み）`
  - テスト本体も `experiments/cpsat-workers/`（実 WASM のハーネス）も**未追跡**。本 spec が触る経路には依存しない。
  - 再現：`pnpm vitest --run tests/cpsat-head-slot-stability.example.test.ts`（約 60 秒）
  - 参考：一時期 cpsat 系 5 ファイルが esbuild の `The symbol "waits" has already been declared`（`experiments/cpsat-workers/quality/bill-wait.ts` の行重複）で落ちていたが、別作業で解消された。
- `tests/observe/history-query.example.test.ts > 合成行を明示すれば除外条件を外す`
  - テストも `src/observe/history-query.ts` ほかも**未追跡**（別作業の進行中）。本 spec は `src/observe/` に触れていない。
- 参考：`tests/client/liftGroups.property.test.ts` は 1 度だけ落ちて以後再現しなかった（PBT の種依存の揺れ）。

## Tasks

- [ ] 1. 実装前の確認事項を閉じる
  - [x] 1.1 公開シンボルの命名を確定する（2026-09-15 全件承認）
    - 一覧の正本は [requirements.md の naming ゲート](requirements.md#naming-ゲートnamingmd) と [design.md の naming ゲート](design.md#naming-ゲート未承認)。重複する候補は同じ判断として扱い、承認結果を両文書へ反映する。
    - [命名規律](../../steering/naming.md) の「公開シンボルの命名は実装前にユーザー確認を要する」に従い、対象シンボルの実装前に確認する。タスク分解は承認の代わりにはならない。
    - 完了。`shortNameOf` は**採らない**（Component 1 が使っておらず、1 箇所の 1 式に名を与えない）。辞書は `ReadonlyMap` で渡す。改名 3 件：`ShortNameDictionary` → `ShortNames`、`readAll` / `readOne` / `write` → `readShortNames` / `readShortName` / `writeShortName`、`SYSTEM_PROMPT` → `SHORT_NAME_PROMPT`。
    - _Requirements: 1.1; Design: Components 1, 7, naming ゲート_
  - [x] 1.2 修正済みの設計に残る旧説明を揃える
    - 完了（2026-09-15）。Component 5 の「直列なら残り時間はループの先頭で 1 回引くだけ」を削除し、直列の利点を「着手の可否と budget が同じ 1 本の式から出る」へ置き換えた。`await` ごとに `budgetOf` を引き直す規則は直列でも変わらないことを明記した。
    - 「数リクエストのうちに埋まる」「残るのは一度きりの商品」を削除し、「どれだけの到着で埋まるかはこの設計からは決まらない」＋「着手しなかった名前は何も壊さない」「当該商品が再び届けばそのときの制限のもとで着手される」の 2 点に絞った。
    - Error Handling の 2 行を「**当該商品の**次の到着」へ直した。1 件の budget とリクエスト共通の締切は既に別行として分かれている。
    - _Requirements: 3.10–3.12, 4.10–4.12; Design: Component 5, Error Handling_
  - [ ] 1.3 未決事項の決定先と確認時点を記録する（**残るのは課金経路の確認 1 件**）
    - **完了**: KV namespace（`yude-men-short-names` = `94044a82…10a5` / `-preview` = `f718a306…3cce`・一覧と突き合わせて照合済み・2026-09-15）。`SHORT_NAME_MODEL` = `@cf/zai-org/glm-5.3-flash`（入力・出力の契約は公開スキーマで確認済み）。
    - ~~`Cache-Control` の秒数~~ — 配信経路ごと不要になった（2026-09-15 の方針変更）。
    - **未**: 選定モデルの課金経路と対象アカウントでの利用可否。**KV を作れたことは利用可否を意味しない。** 実 AI 検証（8.3）とデプロイの前に確認する。
    - _Requirements: 4.6, 4.14; Design: 未決の決定 1_

- [ ] 2. 復号・正規化・検査を純粋関数として実装する
  - [x] 2.1 `src/display/short-name.ts` に型と関門を置く（2026-09-15）
    - `ShortNameEntry`、`ShortNameDictionary`、8 コードポイントの上限を定義する。`cloudflare:workers` に依存させない。
    - `toShortNameCandidate(response)` で `choices[0].message.content` を一度だけ読む。refusal、欠落、非文字列、不正 JSON、非オブジェクト、非文字列の `short` は `null` に畳む。
    - `toShortName` は NFKC 正規化した候補について非空・8 コードポイント以内・正規化した元名の部分列を検査し、通った文字列そのものを返す。他の辞書エントリは参照しない。
    - _Requirements: 5.1–5.8; Design: Component 2_
  - [x] 2.2 復号の例テストと検査の PBT を追加する（2026-09-15・22 件・PBT 5 本）
    - 正常な OpenAI 形の応答と、復号が `null` を返す各分岐を検証する。`refusal` は `content` の型判定とは別に踏む。
    - 非 null の返り値が、正規化した元名の部分列・非空・8 コードポイント以下であることを検証する。境界の 8 字・9 字も踏む。
    - 半角カナの揺れを含め、`特味噌ﾈｷﾞﾗｰﾒ` が `特味噌ネギラーメ` として返る反例を残す。生の候補に対して性質を要求しない。
    - 一意性や味・セット種別の保持を機械検査の期待値に追加しない。
    - _Requirements: 5.1–5.8; Design: Testing Strategy_

- [ ] 3. KV の辞書の読み書きを実装する
  - [x] 3.1 `src/display/dictionary.ts` に 3 操作を置く（2026-09-15）
    - `readAll` は `list()` の metadata からエントリを復号し、`list_complete` が偽なら cursor で続きを取得する。全件取得のために value を読まない。
    - `readOne` は `getWithMetadata` で存在とエントリを読む。未登録と `plain` を区別する。
    - `write` は正規化済みキーごとに metadata と監査記録を保存する。記録には生成時刻・モデル ID・生の申告名・落ちた候補を含める。
    - 条件付き上書き、一意性の予約、人による編集・削除の経路は設けない。
    - _Requirements: 3.6–3.7, 6.1–6.6; Design: Component 3_
  - [x] 3.2 永続と配信用読み取りの契約を検証する（2026-09-15・8 件）
    - `short` / `plain` / 未登録、複数ページ、metadata だけによる全件取得、保存失敗を検証する。
    - 正規化済みキーと生の申告名を別々に保持できること、同じキーで `short` と `plain` の双方への上書きを許容することを確認する。
    - _Requirements: 3.6, 4.12, 6.1–6.6_

- [ ] 4. 期限付きの生成を実装する
  - [x] 4.1 `src/display/generate.ts` に生成とプロンプトを置く（2026-09-15）
    - `generateShortName(deps, key, declaredName, budgetMs)` が鍵と生の申告名を受ける。8 字以内の鍵は AI を呼ばず `plain` を保存する。
    - 9 字以上は当該キーだけをモデルへ渡す。味・具・セット・対象客層の区別を優先する固定プロンプトを使い、既存の札一覧は渡さない。
    - `json_schema.name` と `json_schema.schema` を持つ入力を組み、応答を `toShortNameCandidate` → `toShortName` の順に通す。返された正規化済みの札だけを保存する。
    - モデル ID は `vars` 由来の `deps.model` を使い、生の申告名は監査記録へ渡す。
    - _Requirements: 4.1–4.7, 4.14, 5.7–5.8, 6.3; Design: Component 4_
  - [x] 4.2 再試行・打ち切り・保存失敗を実装する（2026-09-15）
    - 1 回の AI 待機は 3,500 ms と残り budget の小さいほうで打ち切る。失敗時は残り時間の範囲内で同じ入力を 1 回だけ再試行する。
    - budget 到達時は再試行の回数によらず `plain` の保存へ進む。遅れて返った AI 結果から追加の保存を起こさない。
    - 保存失敗を検出側へ伝え、未保存の名前を既知集合に入れない。失敗は記録し、POS の取り込み失敗へ伝播させない。
    - _Requirements: 3.8, 4.8–4.13; Design: Components 4–5, Error Handling_
  - [x] 4.3 AI と時計を差し替えて生成を検証する（2026-09-15・14 件）
    - AI 不使用の `plain`、初回成功、復号・検査・呼び出し失敗後の再試行、再試行失敗、期限切れ、保存失敗を検証する。
    - 保存された札が正規化後の値であり、監査記録の申告名は生のままであることを確認する。
    - 確認済みのモデル契約に基づく応答を使い、実 AI の利用はこのテストに含めない。
    - _Requirements: 4.1–4.14, 5.7–5.8, 6.3_

- [ ] 5. バッチ単位の初出検出を実装する
  - [x] 5.1 `src/display/detect.ts` に検出ループと既知集合を置く（2026-09-15）
    - バッチの親品目名を読み、`Map<Dictionary_Key, Declared_Name>` で重複を除く。同じ鍵に複数の表記があれば先頭の生の申告名を残す。名前を読めない品目のために他の品目の検出や取り込みを失敗させない。
    - 共通の絶対締切を検出の先頭で確定し、isolate 初回の `readAll` も計測に含める。既知集合の存在が確認できた名前は KV を読まずに通過する。
    - 未知の名前は `readOne`、なお未登録なら生成へ進む。既知集合への追加は既存エントリの観測後、または保存成功後に限る。
    - _Requirements: 3.4–3.5, 3.9, 4.12–4.13, 6.3; Design: Component 5_
  - [x] 5.2 件数・締切・再検出を組み込む（2026-09-15）
    - リクエスト共通の締切は 20,000 ms、1 件の上限は 8,000 ms、着手の下限残り時間は 1,000 ms、着手件数の上限は 4 件とする。
    - `budgetOf` に残り時間の計算を集約する。KV 読み取りの前後で呼び、生成開始時点の残り時間から budget を決める。
    - 同一バッチ内は直列に実行する。他のリクエスト・isolate との生成の直列化は行わない。
    - 件数・時間制限で未着手の名前には何も書かず、当該商品の再到着時に再検出する。
    - _Requirements: 3.6, 3.10–3.12, 4.10–4.13; Design: Component 5_
  - [x] 5.3 検出の回帰テストを追加する（2026-09-15・14 件）
    - 同名・正規化で同じ鍵になる表記の重複除去、先頭の生表記の保持、既知名だけのバッチで KV を読まないことを検証する。
    - 残り 2 秒で `readOne` に 3 秒かかる場合、初回 `readAll` で残り時間が不足する場合に、生成を開始しないことを検証する。
    - 5 件以上の初出、未着手名の再到着、他商品の到着だけでは再処理されないこと、保存失敗した名前を再検出できることを検証する。
    - 件数上限は着手した件数として数え、保存失敗で上限が抜けないことを確認する。
    - _Requirements: 3.4–3.12, 4.12–4.13, 6.3_

- [ ] 6. Worker の取り込み・配信・設定を配線する（**札の能力は別 Worker `yude-men-short-names` に置く**・2026-09-15 方針変更）
  - [x] 6.1 設定を分ける（2026-09-15）
    - **root には `ai` / `kv_namespaces` を置かない**（観測事実 20）。`wrangler.short-names.jsonc` を新設し、`AI` / `SHORT_NAMES` / `SHORT_NAME_MODEL` はそちらへ置く。root には `SHORT_NAMES_WORKER` service binding と `assets.run_worker_first` の `/display/*` だけを足す。
    - 別 Env 型を生成する（`pnpm short-names:types` → `src/display/worker-configuration.d.ts` の `ShortNamesEnv`）。root は `pnpm cf-typegen` のまま。生成物は両方 gitignore。
    - workerd の test pool に `yude-men-short-names` の代役（202）を置く。binding の相手先が無いと起動しない。
    - KV namespace の実体は作成・照合済み（2026-09-15）。`yude-men-short-names` = `94044a829d6743cb894b1b660e4a10a5` → `kv_namespaces[0].id`、`yude-men-short-names-preview` = `f718a3063f7f427f970d5fdc5a2b3cce` → `preview_id`。`wrangler kv namespace list` の名前と ID を突き合わせて確認し、同名の重複が無いことも確認した。静的検査がプレースホルダのまま通らないことを固定している。
    - _Requirements: 4.14, 7.3, 8.5; Design: Components 6, 8_
  - [x] 6.2 POS 取り込みから検出を起動する（2026-09-15）
    - 受理判定の後に `waitUntil`（`cloudflare:workers` のモジュール API）で札の Worker へ通知する。`fetch` の戻りも失敗も見ない。`ExecutionContext` を `fetch` の引数に足さないのは、既存の `worker.fetch(request, env)` 呼び出しが 45 箇所あり、署名変更の churn に見合わないため。
    - 申告名の抽出は `src/ingress/declared-item-names.ts`（純粋関数）へ置く。payload の構造を知る層は `src/ingress/` に集める。渡すのは `classified.deliverable` の分だけで、毒・隔離された Record の名前で辞書を育てない。
    - Order_Ingress のボディを新たに解釈せず、同経路から生成を起動しない。
    - _Requirements: 3.1–3.3, 3.8; Design: Component 5_
  - [x] 6.3 `GET /display/short-names` を実装する（**旧方式・task 9 で撤回**・2026-09-15）
    - `readAll` の結果から `short` だけを JSON の名前 → 札の対応表にする。監査記録と `plain` は応答に載せない。
    - 認証を要求せず、task 1.3 で確定した短い `Cache-Control` を付ける。読み取り失敗は client が取得失敗として扱える応答にする。
    - _Requirements: 6.4, 7.1–7.5; Design: Component 6_
  - [x] 6.4 HTTP 境界と分離を検証する（2026-09-15）
    - AI が未完了・失敗の状態でも POS 応答が生成待ちにならず、取り込みが成立することを確認する。既存の POS 統合テストも実行する。
    - GET の JSON・キャッシュヘッダー・無認証・配信対象を確認し、アセットの SPA フォールバックに吸われないことを設定込みで検証する。
    - **外部からの要求では service binding を呼ばない検査を置く（2026-09-15 追加・4 件）。** root が中継するのは `GET /display/short-names` の完全一致だけで、`POST /display/observed` を含む他の `/display/*` は 404 で落とし、`SHORT_NAMES_WORKER.fetch` の呼び出し件数を 0 件にする。生成の起動は POS 取り込みの内側の `notifyShortNames` に限る——接頭辞で素通しにすると、POS 認証の外側から任意の商品名で AI 呼び出しと辞書登録ができる（`tests/worker/display-relay.integration.test.ts`）。
    - **完了（2026-09-15）**: `tests/worker/display-relay.integration.test.ts`（7 件）。root が外部の要求のために `SHORT_NAMES_WORKER` を呼ぶのは `GET /display/short-names` の完全一致のときだけで、**外部からの `POST /display/observed` では binding を呼ばない**（404 を返すだけでなく、呼んでいないことを観測する——404 でも binding を呼べば AI 呼び出しと辞書登録は起きる）。フラグメント（`#/../observed`）はサーバへ届かないため迂回路にならないことも固定した。
    - **分離（完了）**: `tests/item-display-abbreviation.static.test.ts`（7 件）。root が `ai` / `kv_namespaces` を持たないこと、それらを持つのは札の Worker だけであること、root から札の Worker へは service binding 1 本だけであること、そして **`store-timer-do.ts` が `SHORT_NAMES_WORKER` / `SHORT_NAMES` / `AI` のいずれも参照しない**こと。前 2 つは型でも閉じるが、service binding は DO の env に現れるためソースで見る（`SOLVER` と同じ範囲）。
    - **配信（完了）**: `tests/display/worker.example.test.ts`（10 件）。`short` だけを返し、**`plain` の鍵・モデル ID・正規化前の申告名・落ちた候補の理由をいずれも本文に含めない**こと、JSON と `public, max-age=300`、読み取り失敗で **503**（200 で空を返すと「空」と「読めなかった」が区別できない）。
    - **設定（完了）**: 同静的検査。`assets.run_worker_first` に `/display/*` が在り配列形（allowlist）であること、札の Worker が `workers_dev` / `preview_urls` を閉じ `routes` を持たないこと、KV の id がプレースホルダでないこと。
    - _Requirements: 3.1–3.3, 3.8, 6.4, 7.1–7.5, 8.5_

- [ ] 7. 表示名と辞書取得を client へ配線する
  - [x] 7.1 `displayName` と呼び出し元を一緒に更新する（2026-09-15）
    - 辞書を明示的な引数で受け、申告名があるときだけ正規化済みキーで札を引く。未登録・空辞書なら全名、申告名が `null` なら正規化した `noodleType` を返す。
    - 麺量を NFKC 正規化して固定表へ引く。`普通` は区切りごと消し、`中盛` / `大盛` / `半玉` は区切りなしの `中` / `大` / `半` にする。未知の麺量は空白区切りで残し、`null` は添えない。
    - docstring を更新する。既存テストの呼び出しも新しい引数へ揃えるが、既存の架空商品名の是正は行わない。
    - _Requirements: 1.1–1.10; Design: Component 1_
  - [x] 7.2 起動時の取得と 4 箇所への受け渡しを実装する（**旧方式・task 9 で撤回**・2026-09-15）
    - `App.tsx` の店舗画面で起動時に一度取得し、メモリの `ShortNameDictionary` として保持する。取得失敗は空辞書に畳む。
    - `SlotBoard` からレール・釜バッジ・ラジアル・提案ラベルへ渡す。可視ラベルと対象の `aria-label` は `displayName` の結果を使う。
    - WS 再接続で取り直さず、localStorage・IndexedDB・`ClientView` に辞書を持ち込まない。
    - _Requirements: 2.1–2.4, 7.6–7.10; Design: Component 7_
  - [x] 7.3 表示と取得の回帰を検証する（**旧方式・task 9 で撤回**・2026-09-15・実機の目視のみ 8.3 へ）
    - 実データの商品名で、札あり・未登録・空辞書・申告名なし・麺量 4 種・未知の麺量・同じ札を持つ複数商品の表示を検証する。
    - 4 箇所と `aria-label` の語が一致すること、取得失敗時の全名表示、WS 再接続で追加取得しないことを確認する。
    - **完了（2026-09-15）**: `tests/display/displayName.example.test.ts`（16 件・実データの名前のみ）。札あり／未登録／空辞書／申告名なし／麺量 4 種／未知の麺量／同じ札を持つ複数商品を踏む。既存の client 実描画テスト 368 件も通過（`slot-card.example.test.tsx` の 7 箇所は `プレ塩 中盛` → `プレ塩中` へ期待値を更新した——麺量が 1 文字＋区切りなしになった帰結であり、正しい失敗だった）。
    - **非空辞書での受け渡し（完了）**: 4 箇所すべてに 1 件ずつ足した——レール（`order-rail`）、釜バッジ（`slot-card`・**可視の語と `aria-label` の双方**）、ラジアルの帯（`radial-queue`・半角カナの鍵を含む）、提案ラベル（`slot-board-suggestions`・可視と `aria-label` の双方）。空辞書では prop が途中で落ちていても同じ見え方になるため、受け渡しは保証できなかった。
    - **取得の検証（完了）**: `tests/display/fetchShortNames.example.test.ts`（7 件）で HTTP エラー（404 / 500 / 503）・通信失敗・壊れた JSON・値が文字列でない項目を踏み、`tests/client/short-names-wiring.example.test.tsx`（3 件）で `App` を実描画して**起動時 1 回だけ取ること**・**再接続の契機で取得が増えないこと**・取得失敗でも描画が続くことを確かめた。取得は `src/client/shortNames.ts` の `fetchShortNames` へ切り出した（効果の中に直書きすると、描画抜きで失敗経路を踏めない）。
    - 検証中に実装の穴が 1 つ出た——配列の本文が `isRecord` を通り、`Object.entries` が添字を鍵にして `{"0": "特味噌ネギ"}` という辞書を作る。`fetchShortNames` で配列を弾くよう直した。
    - **未**: iPad 相当の縦横画面での目視確認（レールの切れ方・釜バッジの行数）。task 8.3 の実 AI 検証と合わせて行う。
    - _Requirements: 1.1–1.10, 2.1–2.4, 7.6–7.10_

- [ ] 8. 文書・全体検証・デプロイ前確認を完了する
  - [x] 8.1 API 文書と設定値の記録を更新する（2026-09-15）
    - `docs/pos-records-ingress-api.md` の親品目の例に実在する `item_name` を追加する。
    - 命名の確定結果、KV namespace、キャッシュ秒数、モデル ID、課金経路の確認結果を requirements / design と揃える。未確認を完了と記録しない。
    - _Requirements: tasks へ落とす作業項目; Design: 未決の決定_
  - [x] 8.2 全体の検証と変更範囲を確認する（2026-09-15）
    - **実行結果（2026-09-15）**
      | ゲート | 結果 |
      | --- | --- |
      | `pnpm typecheck` | 通過 |
      | `pnpm build` | 通過（`tsc --noEmit` ＋ `vite build`・PWA 生成まで） |
      | `pnpm fmt:check` | 本機能の全ファイルが整形済み。残る 2 件は未追跡の `experiments/cpsat-workers/`（`quality/eval-entry.ts` / `tuning/schedule.ts`） |
      | `pnpm lint` | 本機能の全ファイルで指摘なし。全体の警告はすべて本機能の外（`no-map-spread` の `tests/operation-history/**` ほか、`src/client/connection.ts` の `no-shadow` は未変更ファイル） |
      | `pnpm test` | **2305 passed / 1 failed**。唯一の失敗は既存の `cpsat-head-slot-stability`（テスト本体も `experiments/cpsat-workers/` も未追跡） |
    - **変更範囲の確認（差分で検証）**
      | 対象 | 確認結果 |
      | --- | --- |
      | `OrderItem` | **無変更**。`src/domain/order.ts` は 15 行追加・0 行削除で、増えたのは `WireOrderItem` の定義だけ。項目は `externalOrderId` / `itemIndex` / `noodleType` / `firmness` / `tableId` / `arrivalTime` / `slotSpan` / `itemName` / `sizeName` / `completedAt` / `interruptedAt` の 11 個のまま（`shortName` を含まない） |
      | 永続 v13 | `CURRENT_SCHEMA_VERSION = 13` のまま（`src/engine/types.ts` は**差分なし**） |
      | `migrate` | **本機能による変更なし**。`src/engine/migrate.ts` の差分は 5 行追加・0 行削除で、内容は ADR-0015（2026-09-14・釜の重複を移行で直さない判断）の**コメントのみ**——別作業のもので機能変更ゼロ。`shortName` の参照は 0 件 |
      | `digest` | `src/engine/digest.ts` は**差分なし**・`shortName` の参照 0 件 |
      | `StoreSnapshot` | `src/engine/snapshot.ts` は**差分なし**・`shortName` の参照 0 件。札は `SHORT_NAMES_KEY`（別キー）へ保存し、統合テストが適用前後で `activeTimers` の中身が一致することを固定している |
      | `StoreConfig` / `StoreProjection` / レジストリ | 無変更（静的検査が root の `ai` / `kv_namespaces` 不在も併せて閉じる） |
      | ワイヤ | **種別集合は無変更**。増えたのは `snapshot` が運ぶ品目の任意項目 `shortName` 1 つで、`OrderItem` には現れない |
      | Operation History | 無変更（記録内容に札は現れない） |
    - _Requirements: 8.1–8.7_
  - [ ] 8.3 実モデルを使う検証とデプロイ前確認を行う（**利用可否と実 AI 検証は完了・iPad 目視のみ残る＝デプロイ後**）
    - task 1.3 の利用可否確認後、選定モデルで入力・復号・正規化・保存までを本番辞書と分けて確認する。初回と再試行の所要時間を記録し、設計の待機上限で札を生成できるか確認する。
    - 実データの名前についてプロンプトの出力を確認する。一意性の完全保証を合格条件にはしない。
    - binding・vars・ルーティング・全名へのフォールバックを確認し、デプロイに必要な結果をまとめる。本タスクの完了と本番公開の実施は区別する。
    - **利用可否（完了・2026-09-15）**: `@cf/zai-org/glm-5.3-flash` は Yamaokaya アカウント（`305d89a6…cbde`）で呼べる。wrangler は OAuth で `ai (write)` スコープを持つ。使い捨ての最小 Worker を `wrangler dev` で立てて実呼び出しで確認し、probe はリポジトリにも scratchpad にも残していない。
    - **実 AI 検証（完了・2026-09-15）**: 実プロンプトで実データ 24 件（NFKC 後 9 字以上）を流し、**全件が機械検査（非空・8 コードポイント以内・部分列）を通過**。セット種別 A/B/C は 15 件すべてで保たれ、味の系統と具の区別も残った。合計 68.0 Neurons（無料枠 10,000/日）。
    - **ここで欠陥が 2 件出た**（下の 9.9 で修正済み）。
      1. **推論モデルだった。** 既定のままだと 1 件 18,449ms・33.6 Neurons（推論 1,730 文字）。`enable_thinking: false` で 3,269ms・4.8 Neurons。実装はこれを渡していなかった。
      2. **待機の上限が小さすぎた。** 所要は中央 1,399ms だが裾が 26,569ms まで伸びる。当初の 3,500ms では 6 件が中断され、訂正の経路が無い以上その商品は恒久的に全名になる。
    - 札の質について（人が読んだ所見）: 揺れはある——`味噌Aセ` / `味噌B` / `味噌Cセ`（セ の有無が不揃い）、`お子様ラーメン味噌 → 子味噌` と `お子様ラーメン醤油 → お子醤`（同系統で形が違う）。判断 21 で「良し悪しはプロンプトへ預ける」と決めた範囲として受け入れる。
    - **残り（未）**: **iPad 相当の縦横画面での目視**（レールの切れ方・釜バッジの行数）。デプロイ後に行う。

  - [x] 9.9 実測に基づく修正（2026-09-15）
    - `chat_template_kwargs: { enable_thinking: false }` を渡す。**モデルを差し替えるときはこの指定が効くかを確認し直す。**
    - 待機の上限を実測から引き直した: `SHORT_NAME_CALL_TIMEOUT_MS` 3,500 → **11,000**、`SHORT_NAME_DEADLINE_MS` 8,000 → **24,000**、`SHORT_NAME_REQUEST_DEADLINE_MS` 20,000 → **24,000**、`SHORT_NAME_MAX_PER_REQUEST` 4 → **1**（1 件 11 秒 × 2 回＋書き込みを `waitUntil` の 30 秒へ収める）。
    - **生成の指示に既存の札の一覧を渡す**（判断 7 の改訂・判断 30）。当初これを退けた理由（同じ商品の派生コードが別の札にされる）は、キーを商品コードから申告名へ変えた時点で消えていた。在メモリの辞書から取るので追加の I/O は無い。実測で、衝突する札を渡した 4 ケースすべてが別の札を返した（`特味噌ネギラーメン` + `特味噌ネギ` → `特味噌ラーメン`、`味噌ラーメンAセット` + `味噌A` → `味噌ラーメンA`）。**一意性の保証ではない。**
    - _Requirements: 4.3, 4.6, 4.10, 4.11; 判断 7・30・31・32; 観測事実 25・26_

  - [x] 9.10 札の作り方の規則を指示へ追加（2026-09-15・判断 33）
    - `ラーメン` は積極的に省く／`チャーシュー`・`チャーシューメン` は `チャー`／`A`・`B`・`C` セットはアルファベットを先頭へ移す／**`お子様` と `ピリ辛` は略さない**。
    - **3 つ目のために機械検査を緩めた**: 部分列（順序を保つ）→ **多重集合の包含**（元名にある文字を元名にある回数まで・並びは自由）。`isSubsequence` → `usesOnlyCharactersOf`。`A味噌` は並べ替えなので、緩めなければセット 15 件がすべて `plain` へ落ちる。守っている芯（元名に無い文字を使わせない）は残る。
    - **その後の調整（2026-09-15）**: `ラーメン` を「必ず省く」へ強め、麺量は 1 文字（`中`）から**語のまま**（`中盛`）へ戻した（`醤油中盛` / `味噌大盛`）。さらに**具を落とさない**規則を足した——`塩ネギチャーシュー → 塩チャー` は 3 条件を通るのに、実在する別商品 `塩チャーシュー`（全名で出る）と読み違える。**機械検査では捕まらない類**で、直せるのは指示だけだった。強めた後の実測は 24/24 通過・重複 0 件・具の保持 5/5・全名商品と一致する札 0 件。
    - 麺量を語に戻した副作用: レール（実測 6 字）に全部入るのが 23/24 → 16/24 になった。切れるのは麺量の側で品名は残る。釜バッジ・提案ラベル・ラジアルでは全部入る。
    - **実測（2026-09-15・強化前）**: 24 件中 **23 件が通過・重複 0 件**。落ちた 1 件は `塩ネギチャーシュー` → `塩葱?` で、**元名に無い `葱` と `?` を使ったため関門が捕らえた**（芯が働いた実例）。`お子様` は 3 件すべてで保たれた（`お子様味噌` ほか）。`ピリ辛` は実データではすべて 8 字以下で AI を通らないため、将来の名前に効く規則である。
    - _Requirements: 3.2, 4.2–4.14, 5.7–5.8, 7.3; Design: Component 4, 未決の決定_
