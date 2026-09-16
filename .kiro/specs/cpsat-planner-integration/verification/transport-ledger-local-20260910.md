# タスク2.2途中：永続送出台帳とブラウザ到達性の判断

測定：2026-09-10。[生レポート](./transport-ledger-local-20260910.json)（SHA-256 `7a5d3b96fcf3db11d10a1a82a01470cc23181beaa34114a68c569e4ff8c9167e`）。**ローカルのみ。2.2は未完了、2.5・F-1（3.1）は未通過。cloud変更・実店舗アクセスなし。**

## 1. 永続送出台帳

[ledger.mjs](../../../../experiments/cpsat-workers/transport/ledger.mjs) を追加し、ドライバへ接続した。solver の計数は isolate 単位でしか続かない（退避・cold start・再配備で戻る）ため、試行全体の停止条件は追記専用ジャーナルに置く。上限は **送出128／操作512／同時4**。

規律は 2 つで、どちらも「足りなく数えるより多く数える」側へ倒す。

1. **予約は、それが許可する作業より前に書いて flush する。** 送出と書き込みの間で落ちたら、その予約は未清算のまま永久に消費済みとして残る。後から予約する形にすると、クラッシュのたびに枠が黙って戻る。
2. **ドライバが呼ばない送出も枠を消費する。** 操作は Effect を生み、Effect が送出を生むが、その送出をドライバは呼ばない。よって操作は最悪値の送出枠を先に払う。

規律 2 の「1 操作につき送出は最大 1」は仮説である。`recordObservedDispatch` は、予約に対応しない送出を観測したら**試行を停止**する。丸め誤差として吸収せず、仮説が偽なら止まる。これは**枯渇ではなく予約と観測の不整合**（契約違反）であり、上限から遠くても起こる。

### 接続時に検出した計上漏れ

初回接続で `unreserved-dispatch` が発火した（observed 5 / reserved 4）。原因は予約条件を**応答状態**（202）で書いていたこと。注入失敗の 3 件（下流 503／429／binding 例外）は binding へ到達して送出済みなのに、応答が 202 でないため予約されていなかった。

予約は状態ではなく送出に従う、という形へ直した。呼び出し側が `reachesBinding` で宣言し、宣言漏れは `unreserved-dispatch` が捕まえる。**この台帳が最初に見つけた誤りは、台帳自身の配線だった。**

### 再起動をまたぐ規則の検証

[単体試験9件](../../../../tests/cpsat-transport-ledger.example.test.ts)で検証した。

| 性質 | 検証 |
| --- | --- |
| 予約は作業より前に耐久化され、再起動後も消費済み | 再オープンで `unsettledFromEarlierRuns` に残り、旧 id の清算は拒否 |
| 清算は同時実行枠だけを返し、予約は返さない | 二重清算を拒否 |
| 同時4を超えたら停止し、枠が空いても停止のまま | `concurrent-limit` |
| 送出・操作の上限で停止 | `dispatch-limit` / `operation-limit` |
| 操作は Effect 由来の送出枠を先払いする | 操作1で dispatch も1 |
| **操作が払った枠は replay でも戻らない** | 実装当初は replay が `allowance` を読まず、再起動で枠が戻る欠陥があった。回帰試験を先に落として確認済み |
| 予約なしの観測送出は停止条件 | `unreserved-dispatch`。同一 requestId の再観測は 1 件 |
| 別の試行のジャーナルは再利用しない | 指紋不一致で拒否 |
| 末尾の破断行は許容、途中の破損は拒否 | クラッシュが残す形だけを許す |

### この実行での実測

送出予約 7・観測送出 7（一致）、操作 2、未清算 0、停止なし。ジャーナルは実行ごとの試行窓を持つため**この実行では再起動をまたいでいない**（`restartCrossingExercisedHere: false`）。またぐ規則の証拠は上の単体試験であって、この実行ではない。

台帳が数えるのは送出であって、DO→shim 間の欠落ではない。完全性境界は従来どおり shim の検査後の receipt から先である。

## 2. ブラウザ到達性：測定せず、論証として閉じる

レビューの選択肢 (b) を採る。実ブラウザ計測は行わず、**論証**として記録し `measured: false` をレポートとゲートに固定する。

根拠（すべて既存 loopback 17 ケースで assert 済み）：

- OPTIONS の preflight は 404 で、`Access-Control-Allow-*` を返さない
- Content-Type は `application/json` の単一許可。preflight 不要の 3 型（form／plain／multipart）は 415
- どの応答も `Access-Control-Allow-Origin` / `-Credentials` を持たない
- 別 Origin・`null` Origin・Origin 欠落は 403。別 Host・localhost 別名も 403

依拠するブラウザ側の規則（**これが崩れる環境は範囲外**）：

- `Authorization` は script から設定**できる**。ただし `Content-Type: application/json` と同様、設定した要求は CORS-safelisted ではなくなるため、ブラウザはまず [CORS-preflight fetch](https://fetch.spec.whatwg.org/#cors-preflight-fetch) を行う。本入口は preflight を 404・`Access-Control-Allow-*` なしで拒否するので、**本送信へ進まない**
- `Host` は forbidden header name で script から設定できない。これは CORS とは別の機構であり、別 Host・localhost 別名の拒否はページからは**そもそも到達できない**

したがって、preflight を要しない形（form／plain／multipart、Authorization なし）はサーバへ届いて 415、`Authorization` か `application/json` を伴う形は preflight で止まる。拡張機能や緩和されたローカルポリシーは対象外とする。**「ブラウザで試して届かなかった」とは記録しない。**

> 2026-09-10 訂正：当初「クロスオリジンで `Authorization` を設定できない」と書いたが誤り。設定は可能で、効くのは preflight の要求と拒否である。`Host` の制約は forbidden header name という別の規則。ユーザー指摘により修正。

## 3. 検査

| 実行 | 結果 |
| --- | --- |
| `pnpm test` ×2 | 272ファイル・**2,058件成功**（台帳11件・ゲート増分） |
| `pnpm typecheck` | 成功 |
| `pnpm lint` | exit 0、追加分の警告0 |
| `oxfmt --check`（変更5ファイル）、`git diff --check` | 成功 |
| 意図的な退行確認 | replay の `allowance` を外すと該当試験が落ちることを確認（空振りでない） |

## 3. private 合成操作／WS 入口（`CpsatTransportOperations`）

ユーザー承認を得て追加した。従来ドライバは `runtime.getDurableObjectNamespace("STORE_TIMER_DO", "app")` で DO へ直結していたが、これは Miniflare 内部の経路で cloud に存在しない。private binding 越しの named entrypoint へ置き換えた。

固定問題の送出（`CpsatTransportProbe`）とは別の関心事として分けている。モデル・予算・callback 先を一切運ばず、計画もしない。

**迂回できない 3 つの検査**：期限（窓）・認可（Bearer＋Origin）・許可店舗。期限は認可の await をまたぐため、**effect 境界で読み直す**。認可と窓の実装は 2 つの入口で共有し、片方だけが弱い扉になる余地を消した。

**identity は呼び出し側から受け取らない。** 送られてきた `X-Yudemen-Identity` を無条件に削除し、manifest の rostered な試行 identity を設定する。`src/worker.ts` がクライアント由来の identity ヘッダを決して透過しない規律と同じ形にした。

**台帳も迂回しない。** WS 接続はドライバが `connection` を予約してから開く。ただし WS は Effect を生まないので、**送出枠は消費しない**（allowance 0）。予約ごとに allowance を宣言する形へ台帳を一般化し、`connection` の追加はその上に乗る。

| 検証 | 結果 |
| --- | --- |
| 拒否 6 件 | 認可欠落・Origin 欠落・未登録店舗・誤 method・未知 path・16 KiB 超過。いずれも DO へ到達しない |
| 実操作 1 件 | direct 系列の店舗へ注文到着を投入し、実 Persist → 実 Effect → 従来 TS binding への送出を確認。固定輸送の件数は不変 |
| WS 購読 | 2 接続とも private 入口経由。snapshot 受信と再接続の既存検査はそのまま通過 |

**用語の訂正：`concurrent: 4` は「同時に開いたままの WS の上限」ではない。** 台帳は 101 の直後に `settle` するため、開いている WS は同時実行枠を保持しない。この値が縛るのは予約処理そのものの同時実行である。同時接続本数には**独立した上限が無かった**（累積32が効く範囲では最大32本で有界ではあった）。ユーザー判断により**独立した同時 WS 接続上限4本**を追加実装した：接続開始前に確保、接続中・接続済みの両方を計上、失敗または切断確認で解放、累積32の予約は戻さない、`concurrent` とは別に検査する。この拒否は「想定内の満杯」なので恒久停止にしない。停止理由は 3 分類で、枯渇（予算上限）・契約違反（`concurrent-limit`＝予約から settle までの外部作業4件の契約違反、`unreserved-dispatch`＝予約と観測の不整合）・満杯（`open-connection-limit`）を分ける（[配備差分 §4.1](./deployment-diff-20260910.md)）。

**上限 `connection: 32`** は「**試行全体の累積 WS 接続試行数**」として 2.1 §3 の承認対象に追加する（ユーザー判断）。再接続・失敗も消費し、切断しても戻さない。同時接続数（`concurrent: 4`）とは別の量である。

**接続は送出枠も 1 消費する。** 当初 allowance 0 としたが誤り。DO の起動時は constructor が `blockConcurrencyWhile` 内で Reconcile → `runEffects` を実行するため、**復帰を起こす接続は Effect を生み得る**。よって既定で 1 を課す。この実行の 2 接続はいずれも起動済みの DO に対するもので送出を起こさなかったが、それは**この実行の性質であって接続一般の性質ではない**。レポートに `connectionsWereWarmHere` として分けて記録した。

### レビュー指摘による 3 件の修正

1. **操作入口の期限再検査が早すぎた。** `/ops/orders` は検査後に本文読み取りの await を挟んでから DO へ送っていた。**本文読了後・送出直前**にもう一度読むよう直した（間に非同期処理を置かない）。あわせて、読了後の 16 KiB 検査は受信中のメモリ上限にならないため、probe と同じ**受信しながら打ち切る**読み取りへ置き換えた。
2. **台帳の予約に競合の余地があった。** `reserve()` は上限検査 → `await #append()` → カウンタ更新の順で、並行呼出が同じ残枠を通過できた。ジャーナルを変える操作をすべて直列化し、**残り 1 枠への同時予約で片方だけが通る**負例を追加した（直列化を外すと落ちることを確認）。ついでに `dispatch` 種別への allowance 指定を category error として拒否するようにした（送出そのものなので二重計上になる）。
3. **`Host` の論証を修正。** script は `Host` を直接指定できないが、`http://localhost:<port>` への要求ならブラウザ自身が `Host: localhost:<port>` を生成する。よって localhost 別名の拒否例は**ページから作れる**（作れて、拒否される）。script が作れないのは「要求 URL と無関係な Host」だけである。

### 接続時に見つけた 2 件目の計上漏れ

`reserve("operation", 0)` を追加したが、`reserve` の本体が旧い二分岐のままで **allowance の宣言を無視して常に 1 を計上**していた（予約 8／観測 7）。台帳の突き合わせがこれも検出した。allowance を宣言どおり計上する形へ直し、回帰試験を追加した。

同時に、注入失敗の直後にあった `assert.equal(tsDispatches, 1, "Transport failure must not fall back to TS")` を、絶対値ではなく**そのブロック開始時点との比較**へ直した。主張は「この失敗が TS へ落ちなかった」であって、それ以前に何が走ったかではない。

## 4. レビュー指摘（2026-09-10 第2回）による台帳・WS の修正

コード照合で見つかった 5 件を閉じた。いずれも通常テストの外にあった境界である。

| # | 欠陥 | 修正 |
| --- | --- | --- |
| 1 | 破断末尾の後に追記すると、新しい予約がその行に連結され、次の再起動で消えていた | **破断末尾での継続を拒否する**。自動切り詰めはしない（部分書き込みの扱いを黙って決めない）。人が見て復旧する |
| 2 | 契約違反による停止と観測済み requestId が再起動で消えていた | `stop` 行をジャーナルへ書き、`observed` 行を replay する。停止した試行は再開できない |
| 3 | 同じ台帳を二重に開くと上限を超えられた（`#tail` は同一インスタンス内のみ） | `.lock` の排他作成で**単一 writer を保証**。残置ロックは自動削除しない（前の writer が死んだという事実そのものなので、人が見る） |
| 4 | 未使用 allowance が予約外送出を隠し、「1操作最大1が偽なら停止」を保証できていなかった | **総量の上界検査と、予約単位の仮説検証を分けた**。呼び出し側が送出を予約へ帰属させ、宣言した本数を超えたら停止する。帰属できなかった件数は `unattributedDispatches` として報告する |
| 5 | `/ops/watch` が実 DO の双方向 WS をそのまま返し、接続後は期限検査も予約も通らなかった | 入口で終端して**購読専用**にした。呼び出し側からのフレームは転送せず 4003 で閉じる。切断は close 要求ではなく **close イベントで確認**してから枠を解放する（2秒で確認できなければ `close-unconfirmed` として記録） |

この実行では帰属できなかった送出は 0 件で、7 件すべてが予約単位の検査を通っている。

## 5. レビュー指摘（第3回）による修正

| # | 欠陥 | 修正 |
| --- | --- | --- |
| 1 | `stop` 行の書き込みに失敗すると、再起動で停止が解除されていた（replay は `observed` から違反を再判定していなかった） | **replay で総量と予約単位の不整合を再導出する**。`stop` 行の有無に依存しない。永続化失敗は握り潰さず `stopped.persisted: false` として報告に出す |
| 2 | 切断未確認でも同時接続枠を返していた（理由ラベルが変わるだけだった） | **確認できた終了（`closed`／`failed`）だけが枠を返す**。それ以外は枠を保持し `unconfirmedConnections` として記録する。レポートは teardown より前に書かれるため、後始末の結果を `<report>.teardown.json` へ別途保存し、ゲートで検査する |
| 3 | `waitUntil` に試行期限を守る機構がなく、`closed` は close 要求の直後に resolve していた | **3 つを分離**：close 要求（両側へ依頼）、close 確認（両側が close/error を報告）、試行期限（期限時刻に close を要求するタイマー）。`waitUntil` は応答後の作業に対するプラットフォーム側の寿命上限であって期限の強制機構ではない、と明記した。どちらの上限も cloud では未計測（2.3） |

## 6. レビュー指摘（第4回）による修正

| # | 欠陥 | 修正 |
| --- | --- | --- |
| 1 | relay の片側切断が反対側へ伝わらず、呼び出し側だけ閉じると DO 側接続が残っていた（期限タイマーが発火するまで close 要求が 0 件） | **片側の終了で反対側にも終了を要求する**。両側の確認で完了する形は維持。store 起点は合成店舗の非活性化で実経路を検証した（`storeInitiatedCloseReachesCaller`）。caller 起点は [relay の境界試験](../../../../tests/shell/cpsat-transport-relay.integration.test.ts)で検証した（§7） |
| 2 | `concurrent-limit` は再導出できる観測が無いため、停止行の保存に失敗すると再開できていた | **再導出できる停止と、できない停止を分けた**。できない停止（`concurrent-limit`）と、保存に失敗した停止は、`close()` で**ロックを残す**。次回の open は「別の writer がロックしている」で止まり、人の確認を要求する。`persisted: false` を報告するだけでは次の open が通ってしまう、という指摘のとおり |

再導出可能な停止の一覧はコード上の集合として持ち、`totals.stopIsRederivable` で報告に出す。

1 の再導出（第3回分）は、`stop` 行を削ってから再オープンする負例で確認した（`rederived: true` が立ち、新しい予約が拒否される）。2 は上限1の台帳で未確認解放の後に次の予約が拒否されることを確認した。いずれも修正を外すと落ちる。

## 残り

配備差分と復帰手順の準備。`CpsatTransportOperations` の cloud での到達性（remote binding 越し）は未検証。

## 7. caller 起点の relay 境界試験（レビュー指摘・第5回）

**訂正：** 前回「teardown 検査は両側確認に依存する」と書いたが誤り。teardown が見ているのは caller の close イベントと台帳だけで、relay 内部の `bothConfirmed` は検査していない。caller 起点の代替証拠にはならない。ご指摘のとおりである。

公開名を増やさず、`CpsatTransportOperations.fetch` をそのまま対象にした境界試験を追加した。Workers テスト基盤の `createExecutionContext` / `waitOnExecutionContext` を使い、upstream の WebSocket と実行コンテキストをテスト側で制御する。

upstream は**close 要求を記録するだけで自動的には閉じないスタブ**にした。実 WebSocket を使うと relay が閉じた瞬間に閉じてしまい、「close を要求した」と「store が閉じたと確認した」の隙間が観測できない。

| 検証 | 結果 |
| --- | --- |
| caller を閉じると、期限を待たず upstream にも終了要求が届く（期限は1時間先） | 通過 |
| upstream の終了確認前は両側完了にならない | 通過（250 ms 待って未完了） |
| upstream も終了すると `waitUntil` に渡した処理が完了する | 通過 |

**訂正（第5回指摘）：** 当初は `waitOnExecutionContext(ctx)` を確認前と確認後に 2 回呼んでいた。この API は最初の呼び出しで待機対象を取り出すため、2 回目は空の待機がすぐ解決するだけで、**両側完了の証拠になっていなかった**。待機 Promise を一度だけ作り、同じ Promise を確認前後で観測する形へ直した。

**`as never` も撤去した。** 文字列の DO ID・Response でない返却値・不足した Env を一括で通していたのを、実 namespace・実 ID・実 Env（`{ ...env, CPSAT_SOLVER: env.SOLVER }`）に置き換え、`vi.spyOn` で必要なメソッドだけ制御する形にした。残る cast は**アップグレード応答 1 箇所だけ**で、`Response.webSocket` が代入不可であること・実ソケットでは要求と確認が同時に settle してしまうことを理由としてコメントに書いた。

意図的な退行 3 種で空振りでないことを確認した。

| 変異 | 結果 |
| --- | --- |
| close 伝播を外す | 2 件とも失敗 |
| 片側で完了する（`pending.size === 0` を外す） | 2 件目が失敗 |
| **確認後も resolve しない** | 2 件目が失敗 |

3 つ目は、待機 Promise を使い回す設計でなければ検出できない。両テストとも `finally` で終了確認・待機・タイマーの後始末を行う。

manifest は bundler が差し替える設計なので、この試験では `vi.mock` で試行窓と資格情報を差し替えている。チェックイン済みの manifest は `enabled: false` のままで、既定では入口が開かない。
