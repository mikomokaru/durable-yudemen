# 実店舗ネットワーク最終疎通チェックリスト（本番構成・1 回・パイロット 1 号店立ち上げ兼用）

> 対象 spec: `cloudflare-access-enablement` / タスク 8.3「実店舗ネットワーク上の本番構成 最終疎通を 1 回実施する」
> 種別: ［手続き］（コードで自動検証できない Integration/手続きタスク。実際の疎通は運用者が実店舗で実施する。アプリコードは変更しない・要件 10.1）
> 正本: `requirements.md` 要件 1.9 / 4.1 / 4.2 / 4.3 / 6.2、`design.md` 節「D-2 段階的切替・可逆手順」step 4（実店舗最終疎通・1 回・兼用）・節「A-3 whereami generic OIDC（split-horizon）」・節「Cloudflare Access 前提 6」

---

## 0. この手順の位置づけ（必読）

本手順は、本番切替（タスク 8.2 で `ACCESS_REQUIRED="1"` に投入済み）ののち、**実店舗ネットワーク上での本番構成の最終疎通確認**を **1 回に限り**実施するためのチェックリストである。この確認は**パイロット 1 号店の立ち上げと兼ねる**——本検証のための専用の店舗訪問を要さない（要件 1.9）。

### なぜ 1 回で足りるのか（残る検証範囲）

段階的ロールアウトのオフィス完結検証（環境分離）が既に済んでいるため、実店舗で残る確認は**実ネットワークを前提とする whereami 在圏認証の疎通のみ**である。

| 既に検証済み（オフィス／開発拠点完結・再実施しない） | 兄弟文書 |
| --- | --- |
| アプリ側経路（JWT 検証 → Roster 照合 → Entry 逆引き → WS 確立）を Pilot + OTP_Login で検証 | `pilot-otp-office-verification.md`（タスク 7.4） |
| whereami 固有部分（合成 email 形式・Store_Id_Claim 引き継ぎ・split-horizon）を Whereami_Dev_Stage で本番同一コードのまま検証 | `whereami-dev-stage-verification.md`（タスク 7.5） |
| 本番切替の前提条件 (a)〜(d) の充足 | `production-cutover-preconditions.md`（タスク 8.1） |
| 本番 ON（デプロイ時オーバーライドで `ACCESS_REQUIRED="1"`） | `production-cutover-procedure.md`（タスク 8.2） |

**本手順で確認するのは、上記オフィス検証では原理的に確かめられない「実店舗ネットワーク内に居る物理的事実」を認証根拠とする経路の end-to-end 成立**である。すなわち——split-horizon が**実ネットワーク上で**成立し、whereami が合成 email を発行し、その正準形が当該店舗の店舗 Roster に一致して WS が確立するまでの一連。whereami の在圏認証は店舗ネットワーク内でのみ成立するため、外部・オフィスからは原理的に通せない（`requirements.md` Glossary「Whereami_IdP」・要件 8.2）。ゆえにこの最終疎通は実店舗でのみ確認でき、かつ 1 回で足りる。

### スコープ外（本手順では扱わない）

- **アプリ側経路の再検証**（JWT 検証・Roster 照合・Entry 逆引き・WS 確立のロジック）→ タスク 7.4 で検証済み。本手順は実ネットワーク前提の疎通成立を見るのみで、休眠機構を再実装・再検証しない（要件 10.1）。
- **バイパス防御・偽装ヘッダ除去・回帰の完了条件検証** → タスク 8.4（`production-final-connectivity-check` とは別の完了条件チェックリスト）。
- **whereami 内部実装・対応表への店舗登録**（在圏判定の内部配線・IP→店舗の対応表）→ whereami 側 spec の責務（本 spec 外・要件 10.2 / 10.8）。本手順はパイロット 1 号店が対応表に本番登録済みであることを**前提**とするに留める。

---

## 1. 前提条件（実店舗訪問前に成立を確認する）

以下がすべて成立していることを、実店舗へ向かう前に確認する。欠ければ最終疎通を開始しない。

| 前提 | 内容 | 参照 |
| --- | --- | --- |
| 本番 ON 済み | 本番の `ACCESS_REQUIRED` がデプロイ時オーバーライドで `"1"` に投入済み。リポジトリ既定は `"0"` を保つ | タスク 8.2・要件 5.6 |
| 前提条件 (a)〜(d) 充足 | `production-cutover-preconditions.md` の 4 前提条件がすべて成立（実値投入・型同期・2 経路成功・構成次元一致） | タスク 8.1・要件 1.1 / 1.2 / 1.5 |
| whereami 本番 generic OIDC 据え付け済み | Authorization=内部名ホストの `/authorize`、Token・Certs=外部名ホストの `/token`・`/jwks` を個別指定し split-horizon 制約を満たす本番設定が完了 | タスク 7.3・要件 4.1 |
| パイロット 1 号店の対応表登録 | whereami 本番の IP→店舗の対応表に、パイロット 1 号店の店舗ネットワークが登録済み（whereami 側 spec の責務・本 spec 外） | 要件 10.8 |
| パイロット 1 号店 Roster 登録済み | 合成 email `staff-{パイロット店舗コード}@yamaokaya.com` が当該店舗の店舗 Roster へ Provisioning_API 経由で登録済み（`normalize` 後の正準形で・要件 6.2 / 6.3） | タスク 7.6・要件 6.2 |
| パイロット店舗コードの確定 | 最終疎通に用いるパイロット 1 号店の店舗コードを控える。この値が合成 email ローカル部・`store_id` クレーム・Registry の `storeCode` に一貫して現れる | 要件 6.2 |
| 本番同一コード | デプロイ済み Worker のコード（`verifyAccessIdentity` / `canonicalIdentity` / `isRostered` / Entry 逆引き）が本番と同一で、IdP 経路別分岐・テスト用フラグ・裏口を含まない | 要件 10.1 |

> **正準形の一致（要件 6.2 / 6.3）**: 合成 email のローカル部 `staff-{店舗コード}` の店舗コード（文字列）と Registry の `storeCode`（文字列）は同一の外部マスタを正本とする。当該店舗 Roster への登録は `storeCode`→`storeId` の文字列完全一致逆引きで行い、Access が JWT に載せる `email` クレームと Roster 登録値の双方に同一の `normalize`（trim・小文字化）を適用した正準形が完全一致すること（`normalize` ロジックは既存 PBT 済み・再検証しない）。

---

## 2. 検証 A — 実ネットワーク上で split-horizon が成立する（要件 4.1 / 1.9）

**目的**: パイロット 1 号店の**実店舗ネットワーク内**から、本番の whereami generic OIDC 接続設定が split-horizon の非対称（Authorization=内部名ホスト／Token・Certs=外部名ホスト）を保ったまま在圏認証を通すことを確認する。Whereami_Dev_Stage ではなく**実ネットワーク・本番構成**で通すのが本節の眼目。

### 手順

1. パイロット 1 号店の店舗ネットワークに接続した共用 iPad のブラウザで、Access 保護下の Entry `/`（または Store_Path）へアクセスする（**キッティングなし・ゼロタッチ**を確認する）。
2. Access が whereami の **Authorization（内部名ホストの `/authorize`）** へリダイレクトすることを確認する。
3. 在圏認証（店舗ネットワーク内に居る物理的事実）が成立し、Access のバックエンドが **Token（外部名ホストの `/token`）** で id_token を取得し、**Certs（外部名ホストの `/jwks`）** で署名検証すること（第 1 層）を確認する。
4. Access がアプリ JWT（`iss`=`TEAM_DOMAIN`・`aud`=`POLICY_AUD`）を発行し、認証が完了することを確認する。

### チェックリスト

- [ ] 共用 iPad のブラウザを開くだけで（キッティングなし・ゼロタッチ）認証フローが始まる
- [ ] Authorization リダイレクト先が**内部名ホスト**の `/authorize` である
- [ ] Token・Certs 取得が**外部名ホスト**の `/token`・`/jwks` で行われる
- [ ] Authorization ホスト ≠ Token/Certs ホスト（split-horizon 制約）を保ったまま**実ネットワーク上で**認証が通る（要件 4.1）
- [ ] Access がアプリ JWT を発行し（`iss`=`TEAM_DOMAIN`・`aud`=`POLICY_AUD`）、認証が完了する
- [ ] 本設定・本コードに IdP 経路別分岐・テスト専用フラグ・裏口が**ない**（本番同一・要件 10.1）

---

## 3. 検証 B — 合成 email が発行され店舗 Roster に一致し WS が確立する（要件 4.2 / 6.2 / 1.9）

**目的**: whereami 経由の在圏認証で発行されるアプリ JWT の `email` クレームが合成 email **`staff-{パイロット店舗コード}@yamaokaya.com`** に厳密一致し、`normalize` 後の正準形が当該店舗の店舗 Roster に一致して、パイロット 1 号店の `/s/{storeId}/ws` への WS 接続が**実店舗ネットワーク上で確立**することを確認する。

> **本番同一ロジック（重要・要件 4.2 / 10.1）**: Worker 側に IdP 経路別の形式判定を足さない。合成 email 形式の保証は Access 側の出口要件と whereami 側 spec の責務に置く。Worker が行うのは既存の `canonicalIdentity`（email 優先で正準 identity を抽出）→ `isRostered`（`normalize` 後の正準形を実効 Roster に照合）のみ。形式が壊れた email はどの Roster にも一致せず既存 Roster ゲートが 403 で拒否する、という構造的帰結に依る（新規検証を足さない・引き算）。

### 手順

1. 検証 A で認証を通した状態で、発行されたアプリ JWT の `email` クレームを観測する（Access のログ、または開発時の JWT デバッグ手段を用いる。本番コードには手を入れない）。
2. `email` が `staff-{パイロット店舗コード}@yamaokaya.com` に厳密一致すること（ローカル部が `staff-` + 店舗コード、ドメイン部が `yamaokaya.com`）を確認する。
3. 当該 identity で、Entry `/` の逆引き（`resolveEntryDestination`）を経てパイロット 1 号店へ解決し、`/s/{storeId}/ws` への **WS 接続が確立**すること（`normalize` 後の正準形が店舗 Roster に一致し `isRostered` true・要件 6.2 / 6.4）を確認する。
4. 接続後、店舗のタイマー画面が表示され、実運用に足る操作（開始・キャンセル・完了・調整・再接続 hydration）が観測できることを目視確認する（厳密な回帰判定はタスク 8.4）。

### チェックリスト

- [ ] `email` クレームのローカル部が `staff-` + パイロット店舗コードに一致する（要件 4.2）
- [ ] `email` クレームのドメイン部が `yamaokaya.com` に厳密一致する（要件 4.2）
- [ ] `normalize` 後の正準形が当該店舗 Roster の登録値と完全一致する（`storeCode`→`storeId` 逆引きの整合・要件 6.2 / 6.3）
- [ ] 合成 email で `/s/{storeId}/ws` 接続が**実店舗ネットワーク上で確立**する（`isRostered` true・要件 6.4 / 1.9）
- [ ] 接続後、店舗のタイマー画面が表示され基本操作が観測できる（目視・厳密判定はタスク 8.4）

---

## 4. 検証 C — Store_Id_Claim の観測（診断のみ・非ブロッカー・要件 4.3）

**目的**: whereami が id_token に載せる `store_id` カスタムクレームが、Access の OIDC claims 引き継ぎ設定を経て、**改変されずアプリ JWT の `oidc_fields.store_id`（`oidc_fields` 配下にネスト）** として現れることを診断的に観測する。

### 位置づけ（前提条件でない・切替をブロックしない）

- `store_id` は **認可判定に用いない**。本アプリの認可単位は email（`canonicalIdentity` が email を正準抽出）であり、`store_id` は**監査・診断のためにのみ**文字列に正規化して保全する（要件 4.3）。
- **Store_Id_Claim の引き継ぎ不成立は、認証・認可・接続の成立を妨げない**（診断性が低下するのみ）。ゆえに本番切替の前提条件（要件 1.1 / 1.2）にも、本最終疎通の合否にも**含めない**。本節は「引き継ぎ設定が実ネットワーク上でも機能すること」を確かめる診断的観測であり、未成立でも後追い設定でよい。

### 実測の申し送り（既知の到着形・つくば中央店＝店舗コード 1263）

Cloudflare Access の据え付け・検証済みトークン（つくば中央店・店舗コード 1263）で観測した実物のアプリ JWT の形は次のとおり。本手順の観測はこの既知形と整合するかを見る。

```jsonc
{
  "email": "staff-1263@yamaokaya.com",   // トップレベル・認可単位（Roster 照合）
  "oidc_fields": {
    "store_id": 1263,                     // oidc_fields 配下にネスト・数値で到着（実測）
    "auth_method": "store"                //   〃 ・診断のみ
  }
  // iss=TEAM_DOMAIN / aud=POLICY_AUD / iat / exp …
}
```

- `store_id` は **`oidc_fields` の下にネスト**して届く（トップレベルではない）。
- 値は **数値または文字列のいずれの形でも到着しうる**（実測は数値 `1263`）。**アプリは受領時に文字列へ正規化して扱う**。
- `store_id` の値は合成 email ローカル部の店舗コード・Registry の `storeCode` と**同一の外部マスタを正本**とするが、逆引き・照合は **email 由来の文字列**（`canonicalIdentity`）で行い、`store_id` の数値表現には依存しない（要件 6.2）。

> **申し送り事項（whereami 側 spec へ）**: whereami からの当初の申し送り契約は `store_id` を「文字列・（暗黙に）top-level」としていたが、実トークン（つくば中央店・1263）は**数値かつ `oidc_fields` 配下ネスト**であった。認可には email を用い `store_id` は使わないため実害はないが、契約と実装の齟齬として whereami 側 spec へ申し送る（`requirements.md`「whereami IdP からの申し送り」節と整合）。

### 手順

1. 検証 A で認証を通した状態で、発行されたアプリ JWT の `oidc_fields.store_id` クレームを観測する。
2. `oidc_fields.store_id` が whereami 発行値（= パイロット店舗コード）と**同一の値**であることを確認する（値が数値でも文字列でも可・アプリは文字列に正規化して扱う）。
3. `store_id` の値が合成 email ローカル部の店舗コード・Registry の `storeCode` と一貫していることを確認する（同一の外部マスタが正本・要件 6.2）。

### チェックリスト（すべて診断のみ・不成立でも最終疎通は合格としうる）

- [ ] アプリ JWT に `oidc_fields.store_id` クレームが現れる（OIDC claims 引き継ぎ設定が実ネットワーク上でも機能）（要件 4.3）
- [ ] `oidc_fields.store_id` が whereami 発行値と同一の値（数値/文字列いずれでも可・改変なし・アプリは文字列に正規化）（要件 4.3）
- [ ] `store_id` の値が合成 email ローカル部の店舗コード・Registry `storeCode` と一貫する（要件 6.2）
- [ ] `store_id` を認可に使う配線が Access 側にも Worker 側にも**ない**（認可は email／Roster が担う）
- [ ] （引き継ぎ未成立でも）検証 A・B の認証・認可・接続が成立している（前提条件でないことの裏付け・要件 4.3）

---

## 5. 完了条件（本タスクのゴール・要件 1.9）

以下を満たしたとき、実店舗ネットワーク最終疎通（1 回・パイロット 1 号店立ち上げ兼用）は完了とする。

- [ ] **検証 A**: パイロット 1 号店の実店舗ネットワーク内から、split-horizon を保ったまま whereami 在圏認証（ゼロタッチ）が通り、Access がアプリ JWT を発行した（要件 4.1 / 1.9）
- [ ] **検証 B**: 合成 email `staff-{店舗コード}@yamaokaya.com` が厳密形式で発行され、`normalize` 後に当該店舗 Roster と正準形が完全一致し、`/s/{storeId}/ws` の WS 接続が**実店舗ネットワーク上で確立**した（要件 4.2 / 6.2 / 1.9）
- [ ] **検証 C**: `oidc_fields.store_id` の引き継ぎを診断的に観測した（数値/文字列いずれでも可・**未成立でも合否をブロックしない**・要件 4.3）
- [ ] 本疎通確認を **1 回に限り**実施し、**パイロット 1 号店の立ち上げと兼ねた**（本検証のための専用の店舗訪問を要していない・要件 1.9）
- [ ] **アプリコードに変更を加えていない**（要件 10.1 の差分制限）。本手順の成果物は本チェックリスト（markdown）のみ

> **本手順の後**: 本番切替の完了条件（バイパス防御・偽装ヘッダ除去・タイマー機能の回帰なし）はタスク 8.4 で検証する。系統性障害を検出したら検出から 5 分以内に `ACCESS_REQUIRED="0"` へ戻す（タスク 9.2・要件 1.3）。本最終疎通の結果は、パイロット 1 号店が本番運用へ入る立ち上げ記録を兼ねる。

---

## 6. スコープ境界（触らないもの・要件 10）

- 休眠機構（`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` 除去・付与 / `resolveEntryDestination` / 店舗 DO の `isRostered`・`effectiveRoster`）を**再実装しない**。本手順は本番構成での実ネットワーク疎通確認に限る（要件 10.1）。
- **whereami 内部実装**（OIDC 発行ロジック・ECS Fargate 運用・split-horizon の内部配線・IP→店舗の対応表へのパイロット店舗登録）には触れない。対応表登録は whereami 側 spec の責務（本 spec 外・要件 10.2 / 10.8）。
- `ADMIN_TOKEN`（Provisioning_API・`/admin/*`）は Access と独立した別系統。Roster 登録に用いるが認可ロジックは変更しない（要件 10.3 / 10.6）。
- セッションの継続・失効は Cloudflare Access に委ねる。アプリ側にセッションストア・失効ロジックを新設しない（要件 10.4・失効運用はタスク 9.3）。
- 本番の Access_Application へ OTP_Login を追加しない（要件 10.7）。
- `store_id` を認可の配線に組み込まない（認可は email／Roster が担う・要件 4.3 / 6.4）。

---

## 参照

- 要件: `requirements.md` Requirement 1.9（実店舗最終疎通・1 回・パイロット立ち上げ兼用）、4.1（split-horizon）、4.2（合成 email 厳密一致）、4.3（Store_Id_Claim 引き継ぎ・診断のみ・非ブロッカー）、6.2（合成 email と `storeCode` の同一外部マスタ・Roster 登録）、「whereami IdP からの申し送り」節（`store_id` の実測＝数値・`oidc_fields` ネスト）
- 設計: `design.md` 節「D-2 段階的切替・可逆手順」step 4（実店舗最終疎通・1 回・兼用）、節「A-3 whereami generic OIDC（split-horizon）」、節「Cloudflare Access 前提 4・6」（カスタムクレーム引き継ぎ・split-horizon）、節「Data Models / Access が発行するアプリ JWT のクレーム」
- 兄弟文書: `pilot-otp-office-verification.md`（タスク 7.4・アプリ側経路オフィス検証）、`whereami-dev-stage-verification.md`（タスク 7.5・whereami 固有部分の開発ステージ検証）、`whereami-generic-oidc-procedure.md`（タスク 7.3・generic OIDC 据え付け）、`identity-roster-registration.md`（タスク 7.6・Roster 登録）、`production-cutover-preconditions.md`（タスク 8.1・前提条件）、`production-cutover-procedure.md`（タスク 8.2・本番 ON）
- 後続タスク: 8.4（本番切替の完了条件）、9.1（外形監視）、9.2（切戻しランブック）、9.3（失効運用）、9.4（既定反転＝恒久対処）
