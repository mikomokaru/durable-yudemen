---
inclusion: fileMatch
fileMatchPattern: 'src/**/*.ts'
---

# Timer モデルの規律 — 共有の芯と、側ごとの合成

Timer は本プロジェクトの中核概念であり、パイロットからプロダクトへの脱皮（SlotId の複数化・駆動オーダーの保持・近接茹で上がりの終了調整など）に伴って関心事が増えていく。複雑化を抑制する鍵は「Timer を一つの型にすること」ではなく、**関心事を正しく振り分けること**である。Kiro はこの規律を Timer 関連の型・状態・メッセージのすべてで守る。設計哲学（`design-philosophy.md`「重複の根絶」「構造の主権」）と命名規律（`naming.md`）の直接の帰結である。

## 三層構造（現行・変えない骨格）

基底インターフェイス（Timer の構成ブロック）の**定義の場所は audience（誰が使うか）に従う**。**真に両者で共有される基底は `src/domain/`、片側専用の基底はその側**（engine 専用は `src/engine/`、client 専用は `src/client/`）に置く。これがレゴ式再構成性の核心——各ブロックは「それを使う側」に宿り、共有契約 `domain` は混ぜ物のない最小の中立地帯に保たれる。

- **`TimerFact`（`src/domain/timer.ts`）— 共有の芯。** server と client で**真に共有される事実**だけを、ここに一度だけ宣言する。表現差（ワイヤの生プリミティブ / engine の検証済みブランド型）はフィールド型の型パラメータ `TimerFact<Id, Slot, Noodle, Time>` で吸収する。
- **engine 専用の基底は `src/engine/` に定義する。** 現行は `Sequenced`（登録順 `seq`）＝`engine/timer.ts`。engine の `Timer` はそれを `TimerFact<…ブランド…>` に**多重継承**で合成する。`seq` のように「engine だけが使い、ワイヤには出さない事実」を `domain` の共有契約へ混ぜない（混ぜると中立地帯が片側都合で汚れる）。
- **client 専用の関心事 — 合成で足す。** `ClientTimer = TimerFact & { origin }` のように、client だけの関心事（Provisional の起源タグ等）は交差型で足す。ワイヤ表現は `TimerFact`（既定の生表現）をそのまま用い、別名は設けない。client 専用の基底が要るなら `src/client/` に定義する。

## 新しい関心事を足すときの判定

機能追加で Timer に新しいフィールド／概念が要るときは、必ず次を順に問う。

1. **両者で共有される事実か。** server も client も同じ値を見るべきなら共有事実。→ `TimerFact`（`domain/`）へ。片側だけなら → その側の合成（engine は `extends`、client は `&`）へ。
2. **`TimerFact` を god type にしない。** 片側専用の関心事を共有の芯へ流し込まない。共有が複雑性を抑制するのは「芯が真に共有される事実だけ」である限りであり、片側専用を混ぜた瞬間、共有は server↔client の過剰結合に転じて複雑性を**増幅**する。
3. **概念が別なら名前を分ける。** 既存フィールドに似ていても概念境界が違うなら、被せず別概念として立てる（`naming.md`）。

## 既知の分岐点（脱皮時に判断を要する点）

- **SlotId の複数化（実装済み）** — `TimerFact.slotId` を `slotIds: NonEmptyArray<Slot>`（型で非空強制・`readonly [Slot, ...Slot[]]`）へ変えた。1スロット↔多スロットは表現差ではなく**事実の基数変化**ゆえ、共有の芯 `TimerFact` を変えて両側（engine/client/wire/永続）が同一基数に追従する。未検証入力（`ClientMessage.start`・永続）は `readonly string[]` のままにし、境界で `isNonEmpty`（domain/timer.ts）を通して非空を確立する。永続は v2 へ上げ `migrate` が旧単一 `slotId` を `[slotId]` に写す。担当絞り込みは any-overlap（`slotIds` のいずれかが範囲内）、表示は multi-cell（各スロットセルに現れる）。詳細は yude-men-timer/design.md「スロット複数化（slotIds・スキーマ v2）」。
- **駆動オーダーの保持** — `seq`（登録順・engine 専用 `Sequenced`）とは**別概念**。「オーダーを client が見るか」をまず決める。client 可視なら共有事実として `TimerFact`（または共有の兄弟概念）へ。engine 内部のみなら `Sequenced` と混同せず別の engine 専用概念として立てる。
- **近接茹で上がりの終了調整** — 調整対象は `endTime`（既に `TimerFact` の共有事実）。engine の純粋変換（`decide` 配下）で `endTime` を調整すれば、調整後の値は既存フィールドのまま client へ伝わる。**ワイヤ／共有の形は変えない**。新しい変換を engine へ足すだけにとどめる。

## 不変点

- **基底インターフェイスの定義の場所は audience に従う。** 真に両者で共有される基底のみ `src/domain/`、engine 専用は `src/engine/`、client 専用は `src/client/`。共有契約 `domain` に片側専用を混ぜない。
- 4つの事実フィールド（id / slotId / noodleType / endTime）の宣言は `TimerFact` ただ一箇所。再宣言しない。
- ブランド型と `seq` はワイヤに出さない。engine の `Timer → TimerFact` の射影（`seq` を削ぐ）は表現境界として残る（共有の芯化は名前の単一化であって射影の消去ではない）。
- 詳細な決定の経緯は `.kiro/specs/yude-men-timer/design.md`「Timer 表現の単一芯化（TimerFact）」を参照。
