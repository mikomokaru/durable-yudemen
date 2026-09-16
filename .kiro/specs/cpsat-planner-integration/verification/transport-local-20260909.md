# Task 2.2 の途中結果 — 固定 solver のローカル検証

2026-09-09。**2.2・2.5とも未完了。cloud は未配備・未求解。** 実装継続指示に基づき、固定 solver 部分のローカル実装・検証を進めた。J-1対応で2.1のcloud変更承認の解釈を取り消し、4項目の明示承認待ちに戻した。このローカル成果を配備・費用の承認へ代用しない。

コード・再現コマンド・入力ハッシュは [transport/README.md](../../../../experiments/cpsat-workers/transport/README.md)、生の参照値・runtime・観測行・因果集計は [JSONレポート](./transport-local-20260909.json) に保存した。実行はローカル workerd、callback は RPC test double。旧受信側の無効果は別途実 StoreTimerDO の Workers pool テストで確認した。両者を1本の実アプリ経路が完走した証拠にはしない。

## 結果

- 既存 WASM・生成JSの SHA256SUMS と ABI inspect を再照合。d.ts も流用ガイドのハッシュに一致。C++・WASM・生成JSの変更／再ビルドなし。
- 固定モデルの native 再生成チェック成功。小問題は92 bytes、3変数・1制約。負荷問題は604,697 bytes、500変数・22,495制約で、両者とも入力1 MiB上限内。
- 実WASM 11求解の小問題は最適値5・`[2,1,0]` に一致。負荷問題は UNKNOWN で予算0.14を消費して停止。native境界値118／WASM115の差を記録した。**途中の境界値の完全一致は主張しない。** 初回のローカルチェックではこの値まで一致を要求して失敗したため、既知最適解と途中の探索経路の比較を分離した。差を削除したり、WASM結果をnative期待値へ置き換えてはいない。
- 線形メモリは11回とも33,554,432 bytes（32 MiB）。初期化1回、同一instanceを再利用。isolate全体の数値は未測定。
- 無効／期限切れmanifest2件・不正入力6件は求解0。callback待ち中の追加要求は429。注入したcallback失敗後も次の要求を処理し、二重の求解終了行や再初期化はない。
- 正常／busy系列の送出12・受理11・求解開始11を分離して記録し、生成は0（engine未接続）。callbackは10 delivered／1 failed。200行の観測の因果リンクを既存集計器が受理。これをcloudのexport完全性の根拠にはしない。
- `cpsat-transport-rejection.integration.test.ts`：実際の `deliverPlan` にトップレベル`slices`無しのenvelopeを2回渡して、保存・Alarm・配信が増えず状態不変。通常注文到着で同じspyが保存・配信を捕捉する正例も先に実行した。

実行済み：専用型検査、repo型検査、対象lint／format、observe 71テスト、上記DO棄却と既存Effect列／decide propertyの3ファイル6テスト。既存WIP由来の静的検査3件については前回の未解決状態を引き継ぎ、全suite合格とは報告しない。

J-3追記：上記はこのローカル試験時点の状態。後に旧採用経路を切り離し、3失敗を解消した。[修正前後の基準記録](./implementation-baseline.md)を参照。固定solverとこの生レポートは変更しておらず、後のgreenをこの試験時点へ遡って記入しない。

## 次の実装（2.2の残り）

1. 承認済み `CpsatTransportProbe` を app の named entrypoint に接続し、合成店舗限定の認可・固定操作を検証する。
2. StoreTimerDO の既存状態変更→Persist→RequestPlanを固定solverへ接続する。engine生成・永続結果・実送出の計数を接続し、通常TS・F-1未承認部分は変更しない。constructor内からの送出なども検証する。
3. ローカルドライバの認証・Origin検査・再起動をまたぐ全送出台帳・費用／操作枠・全waitUntil終端のログ照合を作る。solver内のisolate限定カウンタを全体上限へ読み替えない。
4. [cloud変更4項目](./cloud-transport-plan.md)の明示承認を得る。実配備版との限定差分を特定し、現行Access値・binding・namespace・復帰版・対象IDの空きを再確認する。承認と再確認の両方を満たしてから配備し、2.3〜2.5へ進む。

本実装は既存アプリのimport graphや通常経路へまだ接続していない。チェックインmanifestは無効のまま。アプリ／DO／UI／永続形式／既存配備設定の新たな変更はない。3.1のF-1承認待ちもそのまま維持する。
