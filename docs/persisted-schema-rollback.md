# 永続スキーマの版を上げたときの巻き戻し

> 対象: `StoreTimerDO`（binding `STORE_TIMER_DO`・SQLite backed）のキー `activeTimers` に永続される `StoreSnapshot`（`src/engine/snapshot.ts`）。版の台帳は `src/engine/types.ts` の `CURRENT_SCHEMA_VERSION` の doc コメント。
> 種別: ［手続き］。spec ごとに手順書を増やさない——版を上げる spec は本書の §3 の表に 1 行を足すだけにする（`slot-suggested-start` task 10.2・`lift-group-planning` task 15.2）。
> 本書は `docs/access-enablement/rollback-runbook.md`（`ACCESS_REQUIRED` の切戻し・別の関心事）とは独立している。

---

## 0. 結論を先に

**版を上げた Worker を巻き戻すなら、永続も戻さなければならない。** 旧コードは新しい版のデータを読めない。読めない店舗 DO は起動に失敗し続け、その店舗のタイマーは全端末で動かなくなる。したがって

1. **第一選択は前進修正（roll-forward）**である。版を上げた直後に見つかった不具合は、旧版へ戻すのではなく現行版の上で直す。
2. Worker の巻き戻しがどうしても要るときは、**下り移行（§2）を同梱した巻き戻しビルド**を出す。素の旧版（例: `wrangler rollback` で前の version を指す）を出してはならない。
3. 営業中に選べる最後の手段は、店舗単位でキーを消して空状態から始めること（§2.3）。走行中タイマーと待ち行列を失うので、店舗と合意した上でだけ行う。

## 1. 版に依らない事実（なぜ旧コードは新データを読めないか）

| 事実 | 出所 |
| --- | --- |
| 永続は `Persist` 効果のたびに `version: CURRENT_SCHEMA_VERSION` で**丸ごと書き直す**。deploy 後に一度でも状態を動かした店舗は新しい版になる。触られていない店舗は旧版のまま残る | `src/engine/snapshot.ts:52`、`src/shell/store-timer-do.ts:1143` |
| 読み出し時の `migrate` は `version > CURRENT_SCHEMA_VERSION` を `UnsupportedSchemaVersion` として拒む。**上限だけを見る**ので、旧コードは新しい版を一切読まない | `src/engine/migrate.ts:65-66` |
| 拒まれた DO は `ensureLoaded` で `InitError` を throw し、Working_Copy を確定しない。以後の接続も同じ経路で失敗する（再初期化に委ねる規律） | `src/shell/store-timer-do.ts:567-577` |
| 各版の reviver は**知っているフィールドだけを拾う**。余分なフィールドは読まれず、次の `Persist` で消える。逆に**必須のフィールドが無ければ `MigrationFailed`** | `src/engine/migrate.ts` の `revive*` |
| 永続を外から書き換える経路（管理 API・CLI）は無い。書き換えは Worker のコードとして出すしかない | `src/shell/store-timer-do.ts`（`storage.put` は `Persist` 効果の 1 箇所のみ） |

つまり巻き戻しの本体は「`version` を下げ、旧版が必須とするフィールドを埋め、旧版が知らないフィールドは放置する」下り移行であり、それは**旧版が読める形に書き直してから旧版のコードで読む**順でしか成立しない。

## 2. 手順

### 2.1 影響範囲を確かめる

- deploy 以降に `Persist` が走った店舗だけが新しい版を持つ。Workers Logs で `rehydrate` 継ぎ目（`restoredCount`）や `Persist` の発生した店舗を数え、**全店か一部か**を先に知る。
- 一部なら、残りの店舗は旧版のまま読めるので、§2.3 の店舗単位の対処だけで足りることがある。

### 2.2 下り移行を同梱した巻き戻しビルドを出す

1. 巻き戻し先のコミット（旧版 = N−1 の `CURRENT_SCHEMA_VERSION`）から作業ブランチを切る。
2. `migrate.ts` の版検査の**前**に、`version === N` の raw を N−1 の形へ写す下り移行を 1 関数足す。写す内容は §3 の表の「下り移行」列に従う。
3. 下り移行の結果を旧版の `migrate` に通す（旧版の reviver が最終判定）。テストは「N のスナップショットが N−1 として読める」の 1 例と、「N−1 以前は触らない」の 1 性質で足りる。
4. deploy する。DO は次の `ensureLoaded` で下り移行を通り、次の `Persist` で N−1 として書き直される。
5. 全店が N−1 に戻ったことを確認したら、下り移行を含まない素の N−1 へ deploy し直してよい（残しても害は無い）。

### 2.3 店舗単位に空状態へ戻す（最後の手段）

- キー `activeTimers` を消せば、`migrate` は不在を空スナップショットへ写す（`store-timer-do.ts:571-573` の注記）。走行中タイマー・待ち行列（`pendingOrders`）・採用済み計画・取り込みの重複排除表（`lastSequenceByTerminal`）を**すべて失う**。POS の再送は重複排除表が空なので再び受理される。
- 消す経路も無いため、これも「該当店舗だけ `activeTimers` を消す」一時コードを出す形になる。店舗と合意した上で、営業時間外に行う。

## 3. 版ごとの差（版を上げる spec はここに 1 行足す）

| 版 | 上げた spec | 足したもの | 落としたもの | 下り移行（N → N−1 として読ませるために要ること） |
| --- | --- | --- | --- | --- |
| v9 | `slot-suggested-start`（#26） | `PendingOrder.itemName` / `sizeName`（欠如は null） | — | `version` を 8 にするだけ。v8 の reviver は `itemName` / `sizeName` を読まないので放置してよい（次の `Persist` で消える。POS の再送で戻る） |
| v10 | `lift-group-planning` | `Timer.orderItem.tableId`（欠如は null） | `AcceptedSlice.score` | `version` を 9 にし、**`acceptedSlices` を空・`requestedDigest` を欠如**にする。v9 の reviver は `score` を整数として必須とし（`migrate.ts@1b84169:219`）、v10 の一片は `score` を持たないため、残したままでは `MigrationFailed` になる。採用済み計画は導出値で、空にすれば v9 が自前解から立て直す。`tableId` は v9 の `reviveOrderItem` が読まないので放置してよい（次の `Persist` で消える。**走行中の卓の記憶は失われ**、v9 の計画はその走行中を群の錨に使わない——v9 には錨の概念が無いので、それが v9 の正常動作である） |

`score` を埋めて残す案は採らない。v9 のゲートは永続された `score` を Committed_Plan の基準にするため、でたらめな値（0 など）を入れると外部解が永遠に棄却されるか、逆に何でも通る。空にして立て直させる方が v9 の規律に沿う。

## 4. 確認

- 巻き戻しビルドの deploy 後、全店の `rehydrate` 継ぎ目が `InitError` 無しに出ること（Workers Logs）。
- 任意の店舗で接続し、`snapshot` メッセージが届くこと。走行中タイマーがあれば残っていること（§2.3 を使った店舗を除く）。
- POS の取り込みが再開すること（`pos-order-ingress` の受理応答）。
