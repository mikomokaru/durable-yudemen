# Cloud投入承認と配備前再照合（2026-09-10）

## 最新状態：件数差の許容を承認済み

前回の停止報告に対し「この対象外の件数差を許容し、最新の取得結果を基準に続行してよいですか？」と確認し、ユーザーから「いいですよ」と回答を受領した。DO namespace一覧件数11を新しい比較基準として続行する。対象2件、稼働版、binding、認証、公開範囲等の変更を許可したものではない。実投入直前に再取得し、新たな差異があれば停止する。以下の停止記録はその時点の履歴として保持する。

## 承認

ローカル準備2.2の完了後、対象・変更・費用を列挙した8項目の投入承認依頼に対し、ユーザーから「しますよ」と回答を受領した。継続指示や以前の命名承認の転用ではない。

承認範囲は[配備差分](./deployment-diff-20260910.md)の次の8項目に限定する。

1. 非公開Worker `yude-men-cpsat-planner-dev` と `yude-men-cpsat-transport-shim-dev` の新規作成。
2. `yude-men-timer` の再配備（SOLVER張り替え、CPSAT_SOLVER追加、private named entrypoint 2件）。通常計画器はTSのまま。
3. 合成チェーン `cpsat-transport-20260909` と店舗 `-01`〜`-04` の作成。衝突時は上書きしない。
4. 追加費用US$20の予算。課金のハードキャップではない。
5. 全通常店舗のTS経路へのshim追加（1ホップ、最大1 MiBのrouting読み取り、新たな失敗点）。
6. 累積WS接続試行32。
7. 同時WS接続4。
8. shimのWorker名 `yude-men-cpsat-transport-shim-dev`。

送出128・操作512・予約からsettleまでの外部作業4など既定の上限、試験期限・停止条件・復帰順序は維持する。アカウントはYamaokaya / `305d89a643ac689b4204454c5493cbde`。投入直前の再照合で差異があれば停止する。本承認はF-1（3.1）、2.5合格、オンラインCP-SAT有効化の承認を含まない。

## 再照合結果：差異検出により未配備で停止

2026-09-10 09:58:23 UTCの[秘匿値を除いたGET結果](./cloud-targets-20260910.json)を[前回結果](./cloud-targets-20260909.json)と比較した。

| 比較対象 | 結果 |
| --- | --- |
| アプリ版・deployment | `be146588-b3f0-4f54-9134-f5baf744d8fd` / `6cdfed3e-5b87-49c5-b549-b091eb4f0991`、100%。一致 |
| TS solver版 | `e134e93b-1208-452f-847f-cbf344777119`、100%。一致 |
| 対象DO namespace 2件 | ID・クラス・SQLite backendとも一致 |
| 既存取得範囲の設定・binding・公開範囲・観測設定 | 一致。ACCESS_REQUIRED=1。Access policy自体の監査ではない |
| 合成チェーン・店舗候補 | 一致。チェーン候補0件、店舗GETは4件とも404 |
| CP-SAT planner候補 | settings／subdomain／deploymentsは404、code=10007。一致 |
| shim候補（今回取得対象へ追加） | 同3経路が404、code=10007。前回JSONにこのWorkerの取得記録は無く、初回確認 |
| アカウント全体のDO namespace一覧件数 | **12 → 11**（pagination.count / total_count）。差異 |

既存の取得項目を構造比較した差異は上記件数だけである。保存結果は対象Workerでフィルタ済みのため、どの対象外namespaceが減ったかは前回の記録から特定できない。対象2件が維持されていることを、アカウント全体が不変だったことへ読み替えない。無関係なリソースの調査・復元は行わない。

承認条件に従い、**Worker配備・binding変更・合成レコード作成・cloud求解は一切行わず停止**。8項目への承認は受領済みだが、2.1の再照合判定は未完了のままとする。この件数差を許容して今回の取得結果を基準に続行するか、ユーザーへ確認する。続行時も実投入直前に再取得する。

## 実行・認証の記録

- inventoryにshim名を追加しただけで、GET限定・秘匿値を出力しない規律は維持。
- 初回GETは保存OAuthの期限切れにより401 / code=10000。Wrangler 4.105.0の `whoami --json` で既存認証を更新でき、対象アカウントを確認した。メール・トークン・権限一覧は記録へ出していない。
- `node tools/observe/cpsat-targets.mjs /path/to/existing/application/.dev.vars` を再実行。17件のCloudflare API GETと管理API GET5件。管理認証は同一repoのmain worktreeにある既存ファイルを読み取り使用し、コピー・変更なし。
- JSONの取得時刻・shim新規3経路と既存共通項目の差異を区別して比較した。ローカル全テストやcloud輸送成立の再検証を行ったという記録ではない。
