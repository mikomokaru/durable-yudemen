# identity ↔ Roster 整合登録 手順・チェックリスト

> 対象要件: cloudflare-access-enablement 要件 6.1 / 6.2 / 6.3
> 参照: design.md「D-1. identity ↔ Roster 整合登録（要件6）」
>
> 本書は**運用手続き**であり、アプリコードの変更を伴わない（要件10.1 の差分制限）。
> 登録はすべて**既存の Provisioning_API（`/admin/*`・`ADMIN_TOKEN`）**を用いる。新規実装・再実装はしない。
> `normalize` / `effectiveRoster` / `isRostered` は per-store-provisioning で実装・検証済みであり、本書は参照のみ（再検証しない）。

---

## 0. 前提と原則

認可（店舗ごとの接続可否）を担うのは Cloudflare Access ではなく、**店舗 DO が保持する投影 Roster** である（per-store-provisioning の設計継承）。したがって本手続きの目的は次の一点に尽きる。

> **Access が JWT の `email` クレームに載せる identity の正準形**と、**Roster に登録した identity の正準形**を完全一致させること。

一致は文字列の生値ではなく、**同一の `normalize`（前後空白の除去・小文字化）を通した正準形**で判定される（要件6.3）。ゆえに登録値は「Access が発行する email を `normalize` した形」に合わせて定める。

### 正準形の規律（要件6.3・`normalize` は参照のみ）

- `normalize` の定義は `src/registry/authz.ts`（`identity.trim().toLowerCase()`）。**冪等・決定的**。本書はこのロジックを再実装・再検証しない。
- 接続時、店舗 DO は `isRostered`（`src/shell/store-timer-do.ts`）で、接続要求の identity と Roster の各要素の**双方を `normalize` してから**比較する。
- 実効 Roster は `effectiveRoster`（`src/registry/roster.ts`）で **店舗 Roster ∪ 所属チェーンのチェーン Roster** の和集合として導出される（要件6.4）。
- **登録前に、登録しようとする identity を必ず `normalize` 相当（trim + 小文字化）した形にしてから投入する。** これにより登録値の正準形が Access の email クレームの正準形と完全一致する。

### 登録経路（別系統認可・要件10.3）

Provisioning_API（`/admin/*`）の認可は `ADMIN_TOKEN` の定数時間 Bearer 照合であり、**Access とは独立した別系統**である。Access の有効化（`ACCESS_REQUIRED`）の切替に影響されない。本手続きは `ACCESS_REQUIRED` が `"0"` / `"1"` のいずれの段階でも実施できる。

---

## 1. 登録先の決定表（要件6.1 / 6.2）

| identity 種別 | 発行元 | 登録先 Roster | 登録経路 | 正準形 |
| --- | --- | --- | --- | --- |
| **EntraID 実 email**（本部・SV 等） | EntraID_IdP | 権限範囲に応じて **チェーン Roster**（所属チェーン全店へ有効）または **店舗 Roster**（当該店舗のみ） | `PUT /admin/chains/{chainId}` または `PUT /admin/stores/{storeId}` | `normalize`（trim・小文字化）後の正準形 |
| **whereami 合成 email** `staff-{店舗コード}@yamaokaya.com` | Whereami_IdP | 当該店舗の **店舗 Roster** | `PUT /admin/stores/{storeId}` | 同上 |

### 権限範囲の判定（EntraID 実 email）

- **チェーン全店へ有効にする identity**（本部・SV など複数店舗を担当する人間ユーザー）→ **チェーン Roster**（`Chain.chainRoster`）へ登録する。
- **単一店舗のみへ有効にする identity**（当該店舗専任の人間ユーザー）→ **店舗 Roster**（`Store.storeRoster`）へ登録する。
- 迷ったときの原則: 「所属チェーンの全店で使う人」はチェーン Roster、「その店だけの人」は店舗 Roster。実効 Roster は両者の和集合ゆえ、チェーン Roster に載せた identity は個々の店舗 Roster に重ねて載せる必要はない。

---

## 2. EntraID 実 email の登録手順（要件6.1）

### 2-A. チェーン Roster へ登録（チェーン全店へ有効）

`PUT /admin/chains/{chainId}` は**ボディ全置換**（PUT の全置換意味論）である。既存の `chainRoster` を失わないため、**必ず現状を読み出してから、正準化した email を加えた全量を送る**。

1. **現状を取得**（省略すると全置換で既存名簿を失う）:
   - `GET /admin/chains` でチェーン一覧・`chainId` を確認する。
   - 対象チェーンの現在の `name` / `chainRoster` を控える（一覧が最小ビューの場合は運用側で保持している登録値を正本とする）。
2. **登録値を正準化**: 追加する実 email に trim + 小文字化を適用する（例: ` Sato.Taro@Example.com ` → `sato.taro@example.com`）。
3. **全置換ボディで PUT**:
   ```
   PUT /admin/chains/{chainId}
   Authorization: Bearer {ADMIN_TOKEN}
   Content-Type: application/json

   {
     "name": "{既存の name}",
     "chainRoster": ["{既存の正準化済み identity...}", "sato.taro@example.com"]
   }
   ```
   - `chainRoster` を省略すると空名簿で全置換される。**必ず既存 + 追加分の全量を送る。**
4. **受理を確認**: レスポンスが受理（`accepted: true` 相当）であること。値検証（roster 検証・要件4.6）に違反すると 400 で拒否され、イデアは不変。

### 2-B. 店舗 Roster へ登録（当該店舗のみ有効）

`PUT /admin/stores/{storeId}` は**部分更新**（省略フィールドは既存値を保持）だが、`storeRoster` 自体は**渡した配列で置換**されるため、チェーン Roster と同じく現状 + 追加の全量を送る。

1. **現状を取得**: `GET /admin/stores/{storeId}` で当該店舗のイデア全体（`storeRoster` を含む）を取得する。
2. **登録値を正準化**: 追加する実 email に trim + 小文字化を適用する。
3. **全量で PUT**:
   ```
   PUT /admin/stores/{storeId}
   Authorization: Bearer {ADMIN_TOKEN}
   Content-Type: application/json

   {
     "storeRoster": ["{既存の正準化済み identity...}", "sato.taro@example.com"]
   }
   ```
4. **受理を確認**: 受理であること。`storeRoster` の変更は実効 Roster を動かすため、収束（`recomposeProjection` → 当該店舗の StoreTimerDO への投影）が自動で走る。

---

## 3. whereami 合成 email の登録手順（要件6.2）

whereami が発行する合成 email は `staff-{店舗コード}@yamaokaya.com` の形式で、当該店舗の**店舗 Roster** へ登録する。合成 email のローカル部の店舗コードと Registry の `Store.storeCode` は**同一の外部マスタを正本**とするため、登録先店舗の特定は次の**文字列完全一致による逆引き**で自動化できる。

### 3-A. `storeCode` → `storeId` の逆引き（自動化）

1. **店舗一覧を取得**: `GET /admin/stores`（必要なら `?chainId=` で所属チェーンに絞る）。
2. **各店舗のイデアを取得**: `GET /admin/stores/{storeId}` で `storeCode` を得る（一覧が `storeCode` を含まない場合）。
3. **完全一致で逆引き**: 合成 email のローカル部 `staff-` を除いた店舗コード文字列を、`Store.storeCode` と**文字列の完全一致**で突き合わせ、対応する `storeId`（ランダムスラッグ）を得る。
   - 例: 合成 email `staff-9920@yamaokaya.com` → 店舗コード `9920` → `storeCode === "9920"` の店舗の `storeId` を逆引き。
   - `storeCode` はイデアのメタデータであり URL には現れない。逆引きは Provisioning_API の読み出しのみで完結する。
4. **一致が 0 件のとき**: 当該店舗コードが Registry に未登録。登録を中止し、店舗イデアの登録（`POST /admin/stores` / `PUT /admin/stores/{storeId}` での `storeCode` 設定）を先に行う。**推測で別店舗へ登録しない。**

### 3-B. 店舗 Roster へ登録

1. **登録値を正準化**: 合成 email に trim + 小文字化を適用する（`staff-9920@yamaokaya.com` は既に小文字だが、正準化を必ず通す）。
2. **現状取得 + 全量 PUT**（2-B と同じ手順）:
   ```
   PUT /admin/stores/{storeId}
   Authorization: Bearer {ADMIN_TOKEN}
   Content-Type: application/json

   {
     "storeRoster": ["{既存の正準化済み identity...}", "staff-9920@yamaokaya.com"]
   }
   ```
3. **受理を確認**: 受理であること。

---

## 4. 正準形完全一致の担保（要件6.3）

登録値と Access が JWT に載せる email クレームの**双方に同一の `normalize`（trim・小文字化）**が適用され、正準形が完全一致することを、以下で担保する。

- **登録側**: 本書の各手順で、投入前に必ず trim + 小文字化した値を登録する（第2章・第3章）。
- **照合側**: 接続時、店舗 DO の `isRostered` が接続要求の identity と Roster 要素の双方を `normalize` してから比較する（実装済み・参照のみ）。
- **一致条件**: 正準形が一致した場合にのみ同一 identity とみなされ、実効 Roster（`effectiveRoster`）に含まれれば WS 接続が確立する（要件6.4）。含まれなければ 403 で店舗状態は一切変更されない（要件6.5）。

> `normalize` ロジック自体は既存 PBT で検証済み。本手続きでは再検証しない（登録値を正準形に揃えることのみが運用側の責務）。

---

## 5. 登録チェックリスト

登録作業ごとに以下を確認する。

### 共通

- [ ] `ADMIN_TOKEN` を Bearer で付与している（別系統認可・Access とは独立）。
- [ ] 登録する identity を **trim + 小文字化**した正準形で投入した。
- [ ] PUT が**全置換 / 配列置換**であることを踏まえ、**既存名簿 + 追加分の全量**を送った（既存名簿を消していない）。
- [ ] レスポンスが受理（`accepted: true` 相当）であることを確認した。400（値検証違反）でないこと。

### EntraID 実 email（要件6.1）

- [ ] 権限範囲を判定した（チェーン全店 → チェーン Roster / 単一店舗 → 店舗 Roster）。
- [ ] チェーン Roster の場合: `GET /admin/chains` で `chainId` を特定し、`name` を保持したまま `PUT /admin/chains/{chainId}` で `chainRoster` を全量更新した。
- [ ] 店舗 Roster の場合: `GET /admin/stores/{storeId}` で現状を取得し、`PUT /admin/stores/{storeId}` で `storeRoster` を全量更新した。

### whereami 合成 email（要件6.2）

- [ ] 合成 email の形式が `staff-{店舗コード}@yamaokaya.com` に一致することを確認した。
- [ ] 店舗コードを `Store.storeCode` と**文字列完全一致**で逆引きし、`storeId` を特定した（一致 0 件なら中止し、店舗イデア登録を先行）。
- [ ] 当該店舗の **店舗 Roster** へ、正準化した合成 email を全量 PUT で登録した。

### 事後確認（任意・要件6.4 / 6.5 の作動確認）

- [ ] （`ACCESS_REQUIRED="1"` の段階で）当該 identity で `/s/{storeId}/ws` へ接続し、WS が確立することを確認した。
- [ ] 実効 Roster に含まれない identity が 403 で拒否されることを確認した（バイパス防御・要件7 は別手順）。

---

## 6. 参照（実装・変更しない）

| 対象 | 定義場所 | 役割 |
| --- | --- | --- |
| Provisioning_API ルート（`/admin/chains/{id}`・`/admin/stores`・`/admin/stores/{id}`・`GET /admin/*`） | `src/worker.ts`・`src/shell/store-registry-do.ts` | チェーン・店舗イデアの投入と読み出し |
| `ADMIN_TOKEN` 認可（定数時間 Bearer 照合） | `src/worker-auth.ts` | Access と独立した別系統認可（本 spec で変更しない・要件10.3） |
| `normalize`（trim・小文字化） | `src/registry/authz.ts` | 正準形への写像（参照のみ・再検証しない） |
| `effectiveRoster`（店舗 ∪ チェーンの和集合） | `src/registry/roster.ts` | 実効 Roster の導出 |
| `isRostered`（双方 `normalize` 後の照合） | `src/shell/store-timer-do.ts` | 接続時の Roster 認可判定 |
| `Chain.chainRoster` / `Store.storeRoster` / `Store.storeCode` | `src/registry/ideal.ts` | 登録先フィールド・逆引きキー |
