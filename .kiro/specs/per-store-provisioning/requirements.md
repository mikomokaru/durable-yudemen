# Requirements Document

## Introduction

本機能は、これまで単一の固定店舗（`DEFAULT_STORE_ID = "default"`）に束ねていた `StoreTimerDO` を、**チェーン／店舗の階層を持つマルチテナント**へ拡張する骨格である。店舗は**明示プロビジョニング**（認可付き API への登録）によってのみ存在し、店舗の設定（`StoreConfig`）は**レジストリ DO が保持するイデア（正本）から合成・注入**される。

本ドキュメントの設計判断（確定済み）:

- **透過的生成を廃し、明示プロビジョニングへ転換する。** 登録（Provisioning_API への投入）だけが店舗の生成の起点。未登録 storeId ではいかなるリソースも生まれない。
- **イデアの置き場は KV ではなく Store_Registry_DO（シングルトン DO）とする。** KV には書き込みトリガが無く、結果整合（~60 秒）の但し書きが要り、DO と KV の二正本化を招く。レジストリ DO なら「イデアの put → 店舗 DO への押し込み → 失敗時の Alarm 再送」が一箇所で直列化され、既存の Alarm リトライ規律をそのまま再利用できる。レジストリから店舗 DO への参照は storeId の永続で足りる（`idFromName` は決定的であり、名前がポインタ。スタブは毎回の lookup で動的に生成する）。
- **チェーンの統制・地域差（例: 地域によって採用する麺が違う）は、階層をスキーマに焼き込まず、Policy の合成で表現する。** 階層・統制はイデア空間（レジストリ）に閉じ、具現空間（店舗 DO・ワイヤ・クライアント）はフラットな完全 `StoreConfig` しか知らない。
- **同定（addressing）と認可（authorization）を分離する。** URL パスが「どの店舗か」（宛先）を運び、認証は「その identity がその店舗に入ってよいか」（許可）だけを判定する。identity から店舗を導出しない（SV・本部など 1 identity : N 店舗で破綻するため）。
- **名簿（店舗に入れる identity のリスト）もイデアの一部**とし、正引き（店舗→identity）は投影として店舗 DO へ配り、逆引き（identity→店舗）はレジストリ内のインデックスに残す。接続時の認可判定は店舗 DO がローカルで行い、起動時の行き先解決（低頻度）だけレジストリに照会する。
- **storeId はレジストリが採番するランダムスラッグを既定**とし、URL に意味のある名前を漏らさない。Access 導入前の暫定期は、この推測困難な URL 自体を合鍵（capability）として扱う。
- **env シード（`STORE_UNIT_COUNT` / `STORE_ARMS` / `STORE_TOLERANCE_RATIO` / `STORE_NOODLE_PRESETS`）は廃止する。**
- **既存 `"default"` 店は移行せず廃棄する。** 試験はプロビジョニングした新店舗で行う。

本機能の主眼は shell（`StoreTimerDO`）・`Worker`・新設レジストリ・クライアントの接続導線にあり、`src/engine`（純粋な状態遷移）と `src/domain` の Timer 契約は**変更しない**（構造の主権）。`StoreConfig` の型・検証関数（`toUnitCount` / `toArms` / `toToleranceRatio` / `toNoodlePresets`）は**そのまま再利用**する。

> 未決事項は `[Q7]`（iPad の identity 運用）のみで、これは IdP 側の決定であり設計をブロックしない。命名規律（`naming.md`）に従い、新規公開シンボル候補は「命名候補（要確認）」に列挙してあり、**実装前に命名の確定を要する**。

## Glossary

- **Worker**: `src/worker.ts` の極薄エントリポイント。リクエストを対象店舗の `StoreTimerDO`・レジストリ・静的アセット（`ASSETS`）へ振り分ける。
- **StoreTimerDO**: 店舗の全タイマー状態の正本を保持する Durable Object クラス。チェーン・Policy を一切知らず、計算済みの投影（`StoreConfig` + Roster）を受け取るのみ。
- **Store_Registry_DO**: 全チェーン・Policy・店舗・名簿の**イデア（正本）**を保持するシングルトンの Durable Object（新設）。Provisioning_API の受け口であり、Effective_Config の合成・店舗 DO への収束・identity 逆引きを担う。WS の接続・再接続経路には乗らない。
- **イデア**: レジストリが永続する「望ましい設定」の正本。店舗 DO が持つのはその投影であり、レジストリが収束を保証する。
- **Chain**: 店舗を束ねる組織単位。**個人店も店舗 1 のチェーンとして表す**（同型・特別扱いなし）。
- **Policy**: Chain に属する名前付きの部分設定。`priority` と、フィールドごとの mode（**enforced** = 統制・後の層は上書き不可 / **default** = 既定の供給・後の層が上書き可）を持つ。地域差・業態差は Policy の割当として表現する。
- **Store_Override**: 店舗の個別値（部分設定）。合成の最終層。
- **Effective_Config**: Chain の Policy 群と Store_Override から**単一の純粋関数**で合成される、完全な `StoreConfig`。
- **Roster（名簿）**: 店舗への接続を許可する identity（Access が認証したメール等）の集合。チェーン名簿（全店共通: 本部・SV 等）と店舗名簿の和集合が店舗の実効名簿となる。**ワイヤ（`config` メッセージ）には決して出さない。**
- **投影（Projection）**: 店舗 DO へ押し込まれ、店舗 DO が自身のストレージに永続する Effective_Config と実効 Roster の組。
- **収束（Convergence）**: イデア変更後、影響する全店舗の投影を最新に一致させる過程。失敗分は Alarm 再送で at-least-once に続行する。
- **Entry（入口）**: 共通 URL `/`。PWA の start_url であり配布単位。認証済み identity の行き先（店舗パス）をレジストリの逆引きで解決し、リダイレクトする。
- **Store_Path**: 店舗の宛先パス `/s/{storeId}/`（画面）および `/s/{storeId}/ws`（WebSocket）。宛先の唯一の運搬方法。
- **storeId（スラッグ）**: 店舗 DO の名前（`idFromName` のキー）かつ URL の宛先。レジストリが採番するランダム文字列を既定とし、グローバル一意。
- **Provisioning_API**: 外部システム（店舗マスタの真の正本）がチェーン・Policy・店舗・名簿を登録／更新する認可付き API。設定投入の**唯一の経路**。
- **ADMIN_TOKEN**: Provisioning_API の Bearer 認可に用いる env secret。未設定（空）なら常に不許可。
- **Access**: Cloudflare Access。アプリ全体を覆う単一アプリケーションとして認証を担い、認可（店舗ごとの可否）は担わない。
- **Access_Required_Flag**: Access 統合の有効化フラグ（env）。OFF の暫定期は合鍵 URL（推測困難な Store_Path の直叩き）のみで接続でき、ON で JWT 検証と Roster 判定が必須になる。

## Requirements

### Requirement 1: 宛先の運搬（Store_Path）

**User Story:** 利用者として、URL を見ればどの店舗に接続するかが一意に決まり、同じ URL をブックマーク・PWA 起動・再接続で使い続けたい。

#### Acceptance Criteria

1. THE Worker SHALL 店舗の宛先をパス `/s/{storeId}/ws`（WebSocket）および `/s/{storeId}/`（画面・SPA フォールバック）でのみ受け取る（宛先を identity から導出しない）。
2. THE Worker SHALL storeId が許容文字集合（`[a-z0-9-]`）かつ長さ 1〜64 文字であることを検証し、違反または導出不能は HTTP 400 で DO へ到達させない（`DEFAULT_STORE_ID` へのフォールバックは行わない）。
3. THE iPad_Client SHALL 自身の URL パスから storeId を読み取り、同一の storeId で `/s/{storeId}/ws` へ接続する。
4. THE Worker SHALL 店舗 DO のスタブ取得に `locationHint: "apac-ne"` を付与する（初回 materialize 時に効く。現行の配置規律を維持する）。
5. THE iPad_Client SHALL オフライン縮退のローカル永続（`yudemen.offline.view.v1`）を常に storeId でスコープし、現在の storeId にスコープされていない永続ビューを再水和しない（スコープは条件付きではなく必須。店舗を跨いだビューの漏洩＝前店舗の表示が次店舗に出ることを防ぐ）。
6. IF 永続ビュー（`yudemen.offline.view.v1`）が storeId でスコープされていない、または現在の storeId と一致しないとき、THEN THE iPad_Client SHALL 当該永続ビューを空として扱い、前店舗のビューを再水和せずフェイルセーフに初期化する。

### Requirement 2: 明示プロビジョニングと storeId の採番

**User Story:** 運用者として、店舗はマスタへの登録によってのみ存在し、URL に載る ID から店舗を推測されたくない。開発者としては、試験用に簡単な ID も使いたい。

#### Acceptance Criteria

1. THE Store_Registry_DO SHALL Provisioning_API による店舗登録を、店舗が存在するための唯一の起点とする。
2. WHEN 店舗登録を受理したとき、THE Store_Registry_DO SHALL storeId として推測困難なランダムスラッグを採番し、応答で投入元へ返す（外部システムの店舗コードはイデアのメタデータとして別に保持し、URL に意味のある名前を漏らさない）。
3. WHERE 登録要求が storeId を明示指定するとき、THE Store_Registry_DO SHALL 検証（許容文字集合・長さ・未使用）を通過した場合にのみこれを受理する（開発・試験用途。例: `1234`。本番店舗は採番を用いる運用とする）。
4. IF 明示指定された storeId が許容文字集合・長さに反するか、既に使用済みであるとき、THEN THE Store_Registry_DO SHALL 当該登録を HTTP 400 で拒否し、イデアを変更しない（別 ID の自動採番による代替受理も行わない — 呼び出し元の指定と異なる ID で店舗が生まれると外部マスタとの対応が黙って壊れるため）。
5. WHEN 店舗登録を受理したとき、THE Store_Registry_DO SHALL イデアを自ストレージへ put し（確定の起点）、その成功の上で当該店舗の `StoreTimerDO` へ投影を注入して materialize する。
6. WHEN 未プロビジョニングの storeId への `/s/{storeId}/ws` 接続要求を受けたとき、THE StoreTimerDO SHALL 接続を拒否し、自身のストレージへ一切書き込まない（書き込みゼロの DO は消滅し、痕跡を残さない）。
7. THE StoreTimerDO SHALL env シードによる `storeConfig` の自動確立を行わない（`ensureConfigLoaded` の seed 分岐と env の `STORE_*` 変数を撤去する）。
8. THE Worker SHALL 設定投入の経路を Provisioning_API → Store_Registry_DO → StoreTimerDO の一本とし、Worker から `StoreTimerDO` への直接の設定投入経路（現行 `PUT /admin/config` の直接委譲）を撤去する。
9. THE Store_Registry_DO SHALL ローカル開発環境でも本番と同一の Provisioning_API 経路で店舗登録を受ける（試験用の別経路を設けない）。
10. THE Store_Registry_DO SHALL イデアの読み出し（チェーン・店舗の一覧および個別取得）を Provisioning_API と同一の認可（ADMIN_TOKEN）で提供する（外部マスタとの突き合わせ・採番スラッグの再確認用の最小の GET）。

### Requirement 3: イデアのモデル（Chain / Policy / Store_Override / Roster）

**User Story:** 運用者として、10 店のチェーン・100 店のチェーン・個人店を同じ機構で管理し、チェーン統制・地域差・接続を許可する人の管理を一箇所で行いたい。

#### Acceptance Criteria

1. THE Store_Registry_DO SHALL Chain・Policy・Store（所属 chainId・Policy 割当リスト・Store_Override・店舗 Roster）・チェーン Roster をイデアとして自ストレージに永続する。
2. THE Store_Registry_DO SHALL 個人店を店舗 1 のチェーンとして表現し、チェーン有無による処理分岐を持たない（同型性）。
3. THE Store_Registry_DO SHALL Policy を「名前・priority・フィールドごとの mode（enforced | default）と値」として保持する。地域・業態などの分類は Policy の割当として表現し、階層構造をスキーマに追加しない。
4. IF 同一店舗に対し、同一 priority の複数 Policy が同一フィールドを主張する割当が投入されたとき、THEN THE Store_Registry_DO SHALL 当該投入を検証エラー（HTTP 400）で拒否する（曖昧な統制を表現可能にしない）。
5. THE Store_Registry_DO SHALL 店舗の実効 Roster をチェーン Roster と店舗 Roster の和集合として導出する（Roster に priority / enforced の統制意味論は適用しない）。和集合のみであり、チェーン名簿の identity を特定店舗だけ除外する deny 手段は持たない（除外が必要な場合は、チェーン名簿から外して必要な店舗名簿へ載せ直す＝名簿の構成で表現する）。
6. THE Store_Registry_DO SHALL identity → 接続可能店舗リストの逆引きインデックスを、名簿の書き込み時に事前計算して保持する（Entry の行き先解決は保持済みインデックスの単一読み出しで完結し、ログイン時に全チェーン・全店舗の名簿を走査しない。正本はあくまでイデアであり、インデックスは名簿変更で必ず再導出される導出値）。
7. WHEN Chain・Policy・割当・Store_Override・Roster のいずれかが変更されたとき、THE Store_Registry_DO SHALL 影響する全店舗を逆引きし、各店舗の投影を再合成して収束（Requirement 5）を開始する。
8. THE Store_Registry_DO SHALL storeId をチェーン名前空間に埋め込まず、グローバル一意の識別子として扱う（チェーン所属はイデアのメタデータ。店舗の移籍がイデアの書き換えだけで済み、DO 名・接続 URL に波及しない）。
9. THE Store_Registry_DO SHALL Store に活性状態（active / deactivated）を持たせる。閉店は deactivated への更新（イデアの変更）であり、収束（Requirement 5）により店舗 DO へ投影される。

### Requirement 4: Effective_Config の合成（単一の純粋関数）

**User Story:** 保守者として、統制・地域差・店舗個別値の重ね合わせの結果が、一箇所の検証可能な純粋関数だけで決まってほしい。

#### Acceptance Criteria

1. THE Store_Registry_DO SHALL Effective_Config を単一の純粋関数 `(Chain の Policy 群, Store_Override) → StoreConfig` で合成する（作用を含まず、同じ入力に同じ出力）。
2. THE 合成関数 SHALL Policy を priority 昇順に畳み、最後に Store_Override を適用する。mode = default のフィールドは後の層が上書きでき、mode = enforced のフィールドはその層で確定して後の層（Store_Override 含む）に無視される。
3. WHERE 複数の層が同一フィールドを enforced で主張するとき、THE 合成関数 SHALL 上位（priority が小さい層＝全社統制）の値を採用する。地域例外は、全社が当該フィールドの統制を外すか、地域 Policy 自体を本部が定義することで表現する。
4. THE 合成関数 SHALL 各フィールドを不可分の値として合成する。配列フィールド（noodlePresets）は層ごとの丸ごと置換とし、要素レベルのマージを行わない。
5. THE Store_Registry_DO SHALL 合成結果が完全な `StoreConfig`（unitCount / arms / toleranceRatio / noodlePresets の全フィールド）であり、既存検証関数の値域に収まることを保証する。
6. IF Provisioning_API への投入が検証に反する（必須フィールド欠落・型不一致・値域外・未知フィールド）とき、THEN THE Store_Registry_DO SHALL HTTP 400 で拒否し、イデアを変更しない（黙って既定値へ畳まない — 機械間 API では畳み込みが投入元の誤りを隠蔽するため。店舗 DO 側の受け口は計算済みの健全な投影しか受けないため現行のままとする）。
7. WHEN 統制（enforced）が解除されたとき、THE Store_Registry_DO SHALL 保持されていた Store_Override を再び有効にする（統制中も店舗個別値は消さず、無視するに留める — 解除で店舗値が復活するのが最も驚きが少ない）。

### Requirement 5: 投影と収束（イデア → 店舗 DO）

**User Story:** 運用者として、マスタの変更（設定・名簿とも）が稼働中の全該当店舗へ確実に届き、一時的な失敗があっても自動回復してほしい。

#### Acceptance Criteria

1. WHEN イデアの put が成功したとき、THE Store_Registry_DO SHALL 影響店舗の `StoreTimerDO` へ投影（Effective_Config + 実効 Roster）を押し込む（put 成功の前に外部へ真実を主張しない — SSOT 規律）。
2. WHEN 投影の押し込みを受けたとき、THE StoreTimerDO SHALL 受領した投影を永続し、`StoreConfig` の変化を接続中の全クライアントへ `config` メッセージで再配信する（既存 `applyStoreConfig` の経路を継承する）。
3. THE StoreTimerDO SHALL Roster をワイヤ（`ServerMessage`）に一切出さない。保証は送信時のフィルタではなく型の構造で行う — `ServerMessage` に Roster を表現できるフィールドを設けず、投影の型を「配信可能な `StoreConfig`」と「サーバ内部の Roster」に分離して、漏洩を構築不能にする（受信側の検査は不要: クライアント入力は既存の許可リスト方式パースが未知フィールドを構造的に読まない）。
4. IF 押し込みが失敗したとき、THEN THE Store_Registry_DO SHALL Alarm による再送で収束を続行する（at-least-once・冪等）。再送は常にその時点の**最新イデアから再合成した**投影を押す（last-write-wins で自然収束し、履歴の順序管理を持たない）。
5. THE Store_Registry_DO SHALL Policy・Roster → 割当店舗の逆引きを保持し、チェーン規模（100 店程度）の fan-out を直列の押し込みと Alarm 継続で完了する。
6. THE Store_Registry_DO SHALL イデアに updatedAt（または単調増加のバージョン）を持たせ、投影との突き合わせを観測可能にする。
7. THE Store_Registry_DO SHALL 店舗 DO への参照を storeId の永続のみで保持し、スタブは押し込みの都度 `idFromName(storeId)` から動的に生成する（スタブの長期保持・永続化を行わない）。
8. THE Store_Registry_DO SHALL 収束の fan-out を Alarm をまたぐ継続として実行できるものとし、1 回の Alarm 実行内での全店完了を前提としない（未完了分を残作業として永続し、次の Alarm で続行する。DO の実行時間制限に対する境界）。
9. WHEN 投影の押し込みを受理したとき、THE StoreTimerDO SHALL 受領した投影のバージョンを応答で返す。THE Store_Registry_DO SHALL 店舗ごとの収束済みバージョンを記録し、イデアの updatedAt（本 Requirement 6 項）と突き合わせて収束状態を観測可能にする。

### Requirement 6: 店舗 DO の自立性と接続時認可

**User Story:** 厨房スタッフとして、レジストリの状態に関わらず稼働中の店舗のタイマー機能が自立して動き続けてほしい。運用者として、名簿にない人の接続はその場で拒否されてほしい。

#### Acceptance Criteria

1. THE StoreTimerDO SHALL 投影を自身のストレージに永続し続け、hibernate 復帰（rehydrate）時にレジストリへの越境読みを行わない（復帰ホットパスは店舗 DO 内で閉じる）。
2. WHILE Store_Registry_DO が不達・停止しているとき、THE StoreTimerDO SHALL 最後に受領した投影で稼働を継続する（タイマー機能・接続時認可はレジストリの可用性に依存しない）。
3. WHERE Access_Required_Flag が ON のとき、WHEN `/s/{storeId}/ws` の接続要求を受けたとき、THE StoreTimerDO SHALL Worker が検証済みの identity を受け取り、自身の実効 Roster に照合して不一致なら接続を拒否する（判定は投影のみで完結し、レジストリへ照会しない）。
4. WHERE Access_Required_Flag が OFF（暫定期）のとき、THE StoreTimerDO SHALL Roster 照合を行わず、プロビジョニング済みであることのみを接続の条件とする（推測困難な storeId が合鍵として機能する。パイロット限定のリスク受容）。
5. THE StoreTimerDO SHALL Chain・Policy・priority の概念を一切保持しない（受け取るのは計算済みの投影のみ。階層はイデア空間に閉じ、ワイヤ・クライアントへ漏れない）。
6. WHEN 保持する投影が非活性（deactivated）を示すとき、THE StoreTimerDO SHALL 新規接続を拒否し、接続中の WebSocket を閉じる。タイマー状態・投影は保持し、物理削除は行わない（コスト根拠は Requirement 9.6）。

### Requirement 7: 入口（Entry）と行き先解決

**User Story:** 利用者として、配布された共通の URL（PWA）を開くだけで、自分の店舗の画面に着きたい。複数店舗を担当する SV・本部は、店舗を切り替えられるようにしたい。

#### Acceptance Criteria

1. THE Worker SHALL 共通 URL `/` を Entry とし、PWA の start_url・配布単位をこの 1 個に固定する（店舗パス `/s/{storeId}/` はスコープ `/` 内にあり、PWA・Service Worker の構成は店舗数に依存しない）。
2. WHERE Access_Required_Flag が ON のとき、WHEN 認証済み identity が Entry へ到達したとき、THE Worker SHALL レジストリの逆引き（identity → 店舗リスト）で行き先を解決する。
3. IF 逆引きの結果が 1 店舗であるとき、THEN THE Worker SHALL 当該店舗の Store_Path へリダイレクトする。
4. IF 逆引きの結果が複数店舗であるとき、THEN THE Worker SHALL 既定の店舗（登録順の先頭）へリダイレクトし、店舗リストをクライアントへ渡して設定画面での店舗切替を可能にする（次回以降は 7.6 の前回使用店の記憶が優先される）。
5. IF 逆引きの結果が 0 店舗であるとき、THEN THE Worker SHALL 接続先なしを示す応答を返す（いかなる店舗へもフォールバックしない）。
6. THE iPad_Client SHALL 前回使用した店舗の Store_Path を記憶して次回起動時に直行してよい。WHEN 店舗 DO に接続を拒否されたとき、THE iPad_Client SHALL Entry へ戻って行き先を解決し直す。
7. THE Worker SHALL Entry の逆引き照会（起動時・低頻度）に限りレジストリへの照会を許し、WS の接続・再接続経路（高頻度）ではレジストリを経由しない（ホットパス分離。Requirement 8.5）。
8. WHERE Access_Required_Flag が OFF（暫定期）のとき、THE Worker SHALL Entry での行き先解決を提供せず、利用者は合鍵 URL（Store_Path 直叩き）で接続する。

### Requirement 8: 認証・認可

**User Story:** 運用者として、イデアの書き込み口が無認可で晒されず、クライアント認証が全店舗で一貫した単一の仕組みで動くことを保証してほしい。

#### Acceptance Criteria

1. WHEN Provisioning_API へのリクエストを受信したとき、THE Worker SHALL `ADMIN_TOKEN` と `Authorization: Bearer <token>` を定数時間比較で照合する（現行 `isAdminAuthorized` を維持する）。
2. IF `ADMIN_TOKEN` が未設定（空）であるとき、THEN THE Worker SHALL Provisioning_API を常に不許可（HTTP 401）とする。
3. IF 認可に失敗したとき、THEN THE Worker SHALL HTTP 401 応答を返し、当該リクエストをレジストリへ到達させない。
4. THE Worker SHALL `ADMIN_TOKEN` を単一とし、呼び出し元を外部システム 1 者と前提する（チェーン別・地域本部別のトークン／API アクセスはスコープ外）。
5. THE Worker SHALL Access を単一アプリケーション（アプリ全体を覆う）として構成し、店舗別の Access アプリ／ポリシーを作らない（店舗別の可否は Roster＝イデアの責務。IdP・Access 側に店舗マスタの写しを作らない）。
6. WHERE Access_Required_Flag が ON のとき、THE Worker SHALL `Cf-Access-Jwt-Assertion` を JWKS（キャッシュ付き）で署名検証し、検証済み identity のみを店舗 DO へ引き渡す（未検証ヘッダを信用しない — Worker 直叩きによる Access バイパスへの防御）。
7. WHERE Access_Required_Flag が OFF（暫定期）のとき、THE Worker SHALL JWT 検証・identity 引き渡しを行わない。フラグの切替は env で行い、コード変更を要しない。

### Requirement 9: スコープ境界と既存資産の扱い

**User Story:** 保守者として、本機能が触ってよい層と触らない層、捨てるもの・残すものを明確にしたい。

#### Acceptance Criteria

1. 本機能は `src/engine`（純粋な状態遷移）を変更しない。
2. 本機能は `src/domain` の Timer 契約（`TimerFact` ほか）を変更せず、`StoreConfig` 型と検証関数（`toUnitCount` / `toArms` / `toToleranceRatio` / `toNoodlePresets`）を再利用する。
3. 本機能は既存 `"default"` 店を移行しない。`DEFAULT_STORE_ID` の配線と env シードを撤去し、既存 DO の状態は引き継がず廃棄する。試験はプロビジョニングした新店舗で行う。
4. 本機能は店舗マスタの真の正本を外部システムに置き、レジストリをその写し（イデア）とする。外部システムがレジストリを迂回して状態を作る経路（Cloudflare API による直接操作等）は設けない。
5. iPad の identity 運用（スタッフ個人アカウントか店舗端末アカウントか）は IdP・労務運用の判断でありスコープ外とする。Roster は不透明な identity 文字列の集合であり、どちらの運用でも同一機構で受ける。identity の正準形は Access が発行する JWT のクレーム（文字列）であり、IdP 固有の表現差は Access という境界で吸収される — Roster を identity モデルへ適応させる可変機構は設けない。正準クレームの選定（email / sub）と正規化規則は設計時に確定する。 `[Q7]`
6. 閉店は Store の非活性化（Requirement 3.9・6.6）で表現し、物理削除（イデアからの抹消・店舗 DO の `deleteAll`）はスコープ外とする（非活性 DO の維持コストは実質ゼロであり、データが残ることで監査・再開にも耐える）。
7. 課金メーター（店舗 DO 内の正確な利用カウンタ）と店舗別観測（Workers Analytics Engine）は本 spec のスコープ外とし、後続 spec で扱う。

## 要確認事項（設計へ進む前に解決が必要な Q 項目）

- **[Q7] iPad の identity 運用**: スタッフ個人アカウントか店舗端末アカウントか（IdP・労務運用側の決定。Roster はどちらでも同一機構で受けるため、**設計・実装をブロックしない**）。

### 解決済み（確定）

- ~~Q1: パス形~~ → Store_Path `/s/{storeId}/`・`/s/{storeId}/ws`。Entry は共通 URL `/`（Requirement 1・7）。
- ~~Q2: /ws のアクセス制御と Access 統合~~ → 同定と認可の分離。Access は単一アプリで認証のみ、認可は店舗 DO が投影 Roster で判定。暫定期は合鍵 URL、切替は Access_Required_Flag（Requirement 6〜8）。
- ~~Q3: enforced の縦の衝突~~ → 全社（上位 priority）が勝つ。地域例外は全社が統制を外すか、地域 Policy を本部が定義して表現（Requirement 4.3）。
- ~~Q4: 閉店・削除~~ → 非活性化（deactivated）を本 spec に含め、物理削除はスコープ外（Requirement 3.9・6.6・9.6）。非活性 DO はリクエストが無ければ計算課金ゼロ・ストレージ数 KB のみ。
- ~~Q5: 読み出し API~~ → 最小の GET（一覧・個別）を設ける（Requirement 2.10）。
- ~~Q6: 検証方式~~ → レジストリ入口は拒否型（Requirement 4.6）。店舗 DO 側の受け口は現行のまま。
- ~~Q8: 複数店舗担当者の既定店舗~~ → 登録順の先頭。次回以降は前回使用店の記憶が優先（Requirement 7.4・7.6）。

## 命名候補（要確認 — `naming.md` の公開シンボル確認事項）

以下は新規に必要となりうる公開シンボル。命名規律により**実装前にユーザー確認**を要する。候補の提示にとどめ、確定は保留する。

- **レジストリ DO クラス**: 候補 `StoreRegistryDO`。バインディング名候補 `STORE_REGISTRY_DO`。シングルトンの固定名（`idFromName` の引数）候補 `"registry"`。
- **イデア側の型**: 候補 `Chain` / `Policy` / `StoreOverride` / `EffectiveConfig` / `Roster`。Policy の mode リテラル候補 `"enforced"` / `"default"`。
- **合成の純粋関数**: 候補 `composeEffectiveConfig` / `resolveEffectiveConfig`。Roster の和集合導出は候補 `effectiveRoster`。
- **収束の手続き**: 候補 `converge` / `propagate`。
- **投影の押し込み受け口**（店舗 DO 側・RPC メソッド化を想定）: 候補 `applyProjection`（現行 `applyStoreConfig` の後継。Request 受けから型付き RPC への変更を設計時に判断する）。
- **逆引き**: 候補 `storesForIdentity`。
- **Access_Required_Flag の env 変数名**: 候補 `ACCESS_REQUIRED`。
- **既存語彙の再利用**: `StoreConfig` / `StoreTimerDO` / `ADMIN_TOKEN` / `STORE_TIMER_DO` はそのまま用いる。`ensureConfigLoaded` は seed 分岐が消え「未プロビジョニングの検出」へ意味が変わるため、改名の要否を設計時に判断する（候補 `loadProjection` / `requireProvisioned`）。
