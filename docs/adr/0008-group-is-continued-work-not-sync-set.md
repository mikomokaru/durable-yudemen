---
status: accepted
date: 2026-09-05
specs: lift-group-planning, lift-group-display
supersedes: 0004
---

# 計画の群は「同じ投入作業として続ける品目のまとまり」で、Sync_Set とは分ける。合流の窓は品質の許容幅 h_i。群の所属と合流の状態は engine がワイヤで運ぶ

実機で、同じ卓の同じ茹で時間の品目を数秒ずつ順に投入すると、2 本目を始めた時点で残り全員が走行中の釜が空くまで押し出され、提案が消えた。原因は合流の条件 `earliest ≤ 錨` の厳密比較である。仲間が t に始まれば、同じ茹で時間の品目の earliest は t + δ + 茹で時間で、δ > 0 なら錨に届かない。Boil_Sync が 2 本を揃えれば錨はさらに手前に動く。「一緒に now」と並んだ品目を数秒ずつ押すのが現場の形なので、等号の合流は同じ茹で時間の品目では実運用でほぼ成立しない。これまでの検証は同時刻の開始と単発の遷移に寄りすぎていた。

**合流の窓を h_i（茹で時間 × toleranceRatio / 100）にする。** `earliest ≤ 錨 + h_i` なら合流し、`serveAt = max(錨, earliest)` に置く。h_i は Boil_Sync の許容調整割合と同じ既存の品質許容幅で、新しい設定ではない。**ただしこれは「始めれば Boil_Sync が同時に揃える保証」ではない。** Boil_Sync は個々の基底 endTime から窓を作り、共通部分と arms によるセット分割を見る（実測：10・13・16 秒に 60 秒の品目を始めると実効終了は 67 / 67 / 82 秒で、3 本目は別の Sync_Set になる）。計画の群は「同じ投入作業として続ける品目のまとまり」であり、厳密に同時に上げる Sync_Set とは分ける。群が開始後に arms に応じて複数の Sync_Set になることは許す（Boil_Sync は変えない・ADR-0002）。

**群の所属と合流の状態は engine が決め、ワイヤで運ぶ（ADR-0004 を改める）。** 合流した品目の `serveAt` は錨と h_i 以内でずれるので、client が `serveAt` の等号で群を組み `endTime === serveAt` で開始済みを判定する形は保てない。client に許容幅を持ち込めば「揃っていないものを揃っていると言う経路を持たない」に反する。engine は自前解でも採用済み外部解でも現在の確定計画から群と合流を決めているので、`CookRecommendation` に `group`（snapshot 内の識別子）と `anchor`（合流した錨の実効 endTime・合流していなければ null）を載せる。client は読むだけで逆算しない。開始済みの失効（錨の Timer が茹で上がると開始済みでなくなる）は client が `anchor > Corrected_Now` で読む——boolean ではなく錨の時刻を運ぶのはこのためである。

## Considered Options

- **等号のまま（ADR-0004 の形）**: 同じ茹で時間の品目の連続投入で必ず崩れる。採らない。
- **h_i を「同時に揃う保証」として扱う**: Boil_Sync の条件と違う（片側比較 vs 窓の共通部分と arms 分割）。群と Sync_Set を混同する。採らない。
- **client 側に許容幅を置く**: 群の識別が engine と client の二箇所に住み、かつ「近い」判定を client が持つ。採らない。
- **`joined: boolean` だけを運ぶ**: 茹で上がりの失効を表せない（次の snapshot が届く前に終了時刻を跨いだとき）。錨の時刻を運ぶ。

## Consequences

- `TimerFact.orderItem`（`lift-group-display` が Group_Started のために足した）は読み手が無くなる。撤去は同 spec が判断する。
- 群の識別子は snapshot 内に限る。永続的な群の履歴は持たない。
- 検証の中心は「n 本を数秒間隔で順に投入し続ける一連の操作」に置く（`lift-group-planning` Requirement 7.6）。2 本目だけ直っても、3 本目や arms の変更で提案が消えるなら現場の問題は解決していない。
- ゲートの (e) と合成の `keepsAnchor` は窓を h_i に改める（合流分 = 錨 ≤ `serveAt` ≤ 錨 + h_i。錨より手前は不可。押し出しの期限は 錨 + h_i − 茹で時間）。
