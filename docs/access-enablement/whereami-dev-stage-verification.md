# whereami 固有部分の事前検証手順（Whereami_Dev_Stage）

本書は Cloudflare Access に据え付けた **whereami generic OIDC 接続設定**の whereami 固有部分を、実店舗へ赴かずに **Whereami_Dev_Stage**（whereami の開発ステージ）で事前検証するための手順である。検証対象は次の 3 点に限る。

- **合成 email 形式**（`staff-{店舗コード}@yamaokaya.com` の厳密一致・要件 4.2）
- **Store_Id_Claim の引き継ぎ**（`store_id` カスタムクレームのアプリ JWT への引き継ぎ・要件 4.3）
- **split-horizon**（Authorization=内部名ホスト／Token・Certs=外部名ホストの非対称・要件 4.1）

本検証の要諦は一文に尽きる——**本番とまったく同一のコード・同一の検証ロジックで認証が通ることを確認する**（要件 4.5）。迂回はコードで作らず、開発環境のデータで作る（環境分離の原則）。

- **spec**: cloudflare-access-enablement
- **対応タスク**: 7.5 whereami 固有部分を Whereami_Dev_Stage で事前検証する ［手続き］
- **充足要件**: 4.5（Whereami_Dev_Stage を用いた事前検証）・4.2（合成 email 形式の厳密一致）
- **正本**: `.kiro/specs/cloudflare-access-enablement/design.md`（A-3・D-2 ステップ 1・Cloudflare Access 前提 7）／`requirements.md`（Requirement 4.5・4.2・Glossary「Whereami_Dev_Stage」・注記 10.8）
- **姉妹文書**: `docs/access-enablement/whereami-generic-oidc-procedure.md`（タスク 7.3・generic OIDC 接続設定の据え付け手順）

---

## 0. この検証が「本 spec 外の依存」をどう扱うか（前提の明確化）

本検証は **2 つの責務の境界**の上に立つ。取り違えると本番を汚染する。

| 責務 | 主体 | 本 spec との関係 |
| --- | --- | --- |
| **Whereami_Dev_Stage の対応表へのデータ登録**（「テスト店舗＝開発拠点のネットワーク」を IP→店舗の対応表＝正本データに登録すること） | whereami 側 spec | **本 spec のスコープ外・外部依存**。本 spec は当該登録の**成立を前提**とする（依頼事項） |
| **Access 側 generic OIDC 接続設定の検証**（Whereami_Dev_Stage を用いて whereami 固有部分が本番同一コードで通ることを確認すること） | 本 spec（本タスク 7.5） | **本タスクの担当範囲**。当該登録の成立を前提として Access 側設定の検証に関与する |

**本タスクが行うのは後者のみ**である。前者（対応表へのテスト店舗データ登録）は whereami 側 spec への依頼事項であり、本手順の前提条件（§1）として成立を確認するに留める。**本番 whereami の対応表・コードにテストデータ・分岐を一切入れない**（要件 10.8）。テストデータが恒久に住むのは開発環境（Whereami_Dev_Stage）だけであり、それこそが開発環境の存在理由である。

> **二層の JWT を混同しない**（姉妹文書 §0 の再掲）: 本検証で観測するのは、最終的に **Worker が受け取る Access 発行のアプリ JWT**（第 2 層）と、その手前で **Cloudflare Access が whereami の id_token を `/jwks` で検証する**経路（第 1 層）の双方である。Whereami_Dev_Stage を用いても、Worker が検証するのは Access チームドメイン certs（`TEAM_DOMAIN` + `/cdn-cgi/access/certs`）で発行されたアプリ JWT であり、この検証コードは本番と同一・不変である。

---

## 1. 前提条件（検証開始前に成立を確認する）

以下がすべて成立していることを確認してから検証に入る。いずれも本手順では変更を加えない（外部依存の確認に留める）。

- [ ] **Whereami_Dev_Stage が稼働している**（whereami 開発ステージが起動し、OIDC エンドポイント `/authorize`・`/token`・`/jwks` が到達可能）
- [ ] **対応表にテスト店舗が登録済み**（whereami 側 spec の責務・要件 4.5）: Whereami_Dev_Stage の IP→店舗の対応表に「テスト店舗＝開発拠点のネットワーク」がデータとして登録され、開発拠点のネットワークから在圏認証が成立する状態
- [ ] **テスト店舗の店舗コードが確定**: 検証に用いるテスト店舗コード（例: `9920`）を控える。この値が合成 email のローカル部・`store_id` クレーム・Registry の `storeCode` に一貫して現れる
- [ ] **Access 側 generic OIDC 接続設定が Whereami_Dev_Stage に向いている**（姉妹文書タスク 7.3 の手順で据え付け済み。Authorization=内部名ホストの `/authorize`、Token・Certs=外部名ホストの `/token`・`/jwks` が個別指定され、split-horizon 制約を満たす）
- [ ] **テスト店舗 Roster に合成 email が登録済み**: `staff-{テスト店舗コード}@yamaokaya.com` を当該テスト店舗の店舗 Roster へ Provisioning_API 経由で登録済み（`normalize` 後の正準形で・要件 6.2／6.3）。未登録なら既存 Roster ゲートが拒否するため、認証成立の観測ができない
- [ ] **本番同一コードであること**: 検証に用いる Worker デプロイのコード（`verifyAccessIdentity`／`canonicalIdentity`／`isRostered`／Entry 逆引き）が本番と同一で、IdP 経路別の分岐やテスト用フラグを含まない（要件 10.1／10.8）

> 前提の 1 つでも欠ければ検証を開始しない。とりわけ「対応表へのテスト店舗登録」（外部依存）が未了なら、それは whereami 側 spec への依頼事項として起票し、成立を待つ。

---

## 2. 検証観点 A — split-horizon が本番同一設定で機能する（要件 4.1／4.5）

Whereami_Dev_Stage に向けた generic OIDC 接続設定が、split-horizon の非対称（Authorization=内部名ホスト／Token・Certs=外部名ホスト）を保ったまま認証を通すことを確認する。設定の据え付け自体は姉妹文書（タスク 7.3）の担当であり、本節はその設定が **Whereami_Dev_Stage を相手に実際に通し検証で機能する**ことを観測する。

### 手順

1. 開発拠点のネットワーク（テスト店舗として対応表に登録済み）から、ブラウザで Access 保護下の Entry `/` または Store_Path へアクセスする。
2. Access が whereami の **Authorization（内部名ホストの `/authorize`）** へリダイレクトすることを確認する。
3. 在圏認証（ゼロタッチ）が成立し、Access のバックエンドが **Token（外部名ホストの `/token`）** で id_token を取得し、**Certs（外部名ホストの `/jwks`）** で署名検証することを確認する（第 1 層）。
4. Access がアプリ JWT を発行し、認証が完了することを確認する。

### チェックリスト

- [ ] Authorization リダイレクト先が**内部名ホスト**の `/authorize` である
- [ ] Token・Certs 取得が**外部名ホスト**の `/token`・`/jwks` で行われる
- [ ] Authorization ホスト ≠ Token/Certs ホスト（split-horizon 制約）を満たしたまま認証が通る
- [ ] 認証完了まで到達し、Access がアプリ JWT を発行する
- [ ] 本設定・本コードに IdP 経路別の分岐やテスト専用フラグが**ない**（本番同一・要件 10.1）

---

## 3. 検証観点 B — 合成 email 形式が厳密一致する（要件 4.2／4.5）

whereami 経由で認証が成立したとき、Access が発行するアプリ JWT の `email` クレームが合成 email **`staff-{店舗コード}@yamaokaya.com`** に厳密一致することを確認する。ここで「厳密一致」とは、**ローカル部が `staff-` + 店舗コード、ドメイン部が `yamaokaya.com`** に一致することを指す。

### 本番同一ロジックで検証するとは（重要）

- Worker 側に **IdP 経路別の形式判定を足さない**（要件 4.2／10.1）。合成 email 形式の保証は Access 側の出口要件と whereami 側 spec の責務に置く。
- Worker が行うのは既存の `canonicalIdentity`（email 優先で正準 identity を抽出）→ `isRostered`（`normalize` 後の正準形を実効 Roster に照合）のみ。**形式が壊れた email はどの Roster にも一致せず既存 Roster ゲートが 403 で拒否する**という構造的帰結を確認する（新規検証を足さない・引き算）。
- したがって本観点は「合成 email が厳密形式で発行され、`normalize` 後にテスト店舗 Roster の登録値と正準形が完全一致し、認証→接続まで到達する」ことを観測することで満たす。

### 手順

1. 観点 A で認証を通した状態で、発行されたアプリ JWT の `email` クレームを観測する（Access のログ、または開発時の JWT デバッグ手段を用いる。本番コードには手を入れない）。
2. `email` が `staff-{テスト店舗コード}@yamaokaya.com` に厳密一致することを確認する（例: テスト店舗コード `9920` なら `staff-9920@yamaokaya.com`）。
3. 当該 identity で `/s/{テスト店舗 storeId}/ws` への接続が **確立する**ことを確認する（`normalize` 後の正準形がテスト店舗 Roster に一致し、`isRostered` が true）。

### 反例観測（形式が壊れた場合の既存ゲートの帰結）

本番に分岐を足さないことの裏付けとして、形式が合成 email 形式に一致しない identity では **既存 Roster ゲートが 403 で拒否し店舗 DO の状態を変えない**ことを確認する（新規の形式バリデーションではなく、Roster 不一致の帰結であることを確認する・要件 6.5）。

### チェックリスト

- [ ] `email` クレームのローカル部が `staff-` + テスト店舗コードに一致する
- [ ] `email` クレームのドメイン部が `yamaokaya.com` に厳密一致する
- [ ] `normalize` 後の正準形がテスト店舗 Roster の登録値と完全一致する（要件 6.3）
- [ ] 合成 email で `/s/{storeId}/ws` 接続が確立する（`isRostered` true）
- [ ] 形式が壊れた email は既存 Roster ゲートが 403 で拒否し店舗状態を変えない（新規検証を足していない・要件 4.2／6.5）

---

## 4. 検証観点 C — Store_Id_Claim が引き継がれる（要件 4.3／4.5）

whereami が id_token に載せる `store_id` カスタムクレームが、Access の OIDC claims 引き継ぎ設定を経て、**改変されずアプリ JWT の `oidc_fields.store_id`（`oidc_fields` 配下にネスト）**として現れることを確認する。値は数値または文字列のいずれの形でも到着しうる（実測=つくば中央店・店舗コード 1263 では `oidc_fields.store_id: 1263`（数値））。アプリは受領時に文字列へ正規化して扱う。

### 位置づけ（前提条件ではない）

- `store_id` は **認可判定に用いない**。本アプリの認可単位は email（`canonicalIdentity` が email を正準抽出）であり、`store_id` は**監査・診断のためにのみ**文字列に正規化して保全する。
- **Store_Id_Claim の引き継ぎ不成立は、認証・認可・接続の成立を妨げない**（診断性が低下するのみ）。ゆえに本番切替の前提条件（要件 1.1／1.2）には**含めない**。本観点は「引き継ぎ設定が機能すること」を事前に確かめる診断的検証であり、未成立でも後追い設定でよい。

### 手順

1. 観点 A で認証を通した状態で、発行されたアプリ JWT の `oidc_fields.store_id` クレームを観測する。
2. `oidc_fields.store_id` が whereami 発行値（= テスト店舗コード）と**同一の値**であることを確認する（例: テスト店舗コード `1263` なら `oidc_fields.store_id: 1263`。値が数値でも文字列でも可・アプリは文字列に正規化して扱う）。
3. `store_id` の値が合成 email のローカル部の店舗コード・Registry の `storeCode` と一貫していることを確認する（同一の外部マスタが正本・要件 6.2。逆引き・照合は email 由来の文字列で行い、数値の store_id には依存しない）。

### チェックリスト

- [ ] アプリ JWT に `oidc_fields.store_id` クレームが現れる（OIDC claims 引き継ぎ設定が機能）
- [ ] `oidc_fields.store_id` が whereami 発行値と同一の値（数値/文字列いずれでも可・改変なし。アプリは文字列に正規化）
- [ ] `store_id` の値が合成 email ローカル部の店舗コード・Registry `storeCode` と一貫する
- [ ] `store_id` を認可に使う配線が Access 側にも Worker 側にも**ない**（認可は email／Roster が担う）
- [ ] （引き継ぎ未設定でも）認証・認可・接続が成立することを確認した（前提条件でないことの裏付け）

---

## 5. 完了条件（本タスクの成果物としての観測点）

以下がすべて確認できたとき、whereami 固有部分の事前検証が完了したとみなす。実構成・実データ登録は運用者および whereami 側 spec が担い、本手順は検証手順の整備と観測点の定義までを担う。

- [ ] **split-horizon**（観点 A）: 本番同一設定で Authorization=内部名／Token・Certs=外部名の非対称を保ったまま認証が通る（要件 4.1／4.5）
- [ ] **合成 email 厳密一致**（観点 B）: `staff-{店舗コード}@yamaokaya.com` の厳密形式で発行され、`normalize` 後にテスト店舗 Roster と正準形が完全一致し接続が確立する（要件 4.2／4.5）
- [ ] **Store_Id_Claim 引き継ぎ**（観点 C）: `oidc_fields.store_id` が改変なくアプリ JWT に引き継がれる（数値/文字列いずれでも可・アプリは文字列に正規化・要件 4.3／4.5。未成立でも切替可）
- [ ] **本番同一コード・同一ロジック**: 上記すべてが IdP 経路別分岐・テスト用フラグ・裏口を含まない本番同一のコードで通った（要件 4.5／10.1）
- [ ] **本番非汚染**: 本番 whereami の対応表・コードにテストデータ・分岐を入れていない（要件 10.8）

> 本検証（オフィス／開発拠点完結）が済めば、実店舗ネットワーク上の最終疎通はパイロット 1 号店の立ち上げと兼ねる **1 回のみ**で足りる（要件 1.9・タスク 8.3）。本手順の結果は本番切替の前提条件チェックリスト（タスク 8.1）へ集約される。

---

## スコープ境界（触らないもの）

- **Whereami_Dev_Stage の対応表へのデータ登録**（「テスト店舗＝開発拠点のネットワーク」）は whereami 側 spec への依頼事項であり、**本 spec のスコープ外・外部依存**。本手順は当該登録の成立を前提とするに留める（要件 4.5）。
- **whereami 内部実装**（OIDC 発行ロジック・ECS Fargate 運用・split-horizon の内部配線）には触れない（要件 10.2）。
- **アプリコードを変更しない。** 本タスクの成果物は本手順書（markdown）のみであり、Worker・DO・registry のコードに差分を出さない（要件 10.1 の差分制限）。
- **本番 whereami の対応表・コードにテストデータ・分岐を入れない**（要件 10.8）。テストデータは Whereami_Dev_Stage にのみ住む。
- **Worker の第 2 層検証**（`verifyAccessIdentity` が `TEAM_DOMAIN` certs でアプリ JWT を検証する経路）は実装済み・不変。
