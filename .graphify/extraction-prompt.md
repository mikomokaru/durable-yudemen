# graphify 抽出プロンプト（ラベル規律版 v2）

このファイルはセマンティック抽出キャッシュのキーを兼ねる。内容を変更すると全ファイルが再抽出される。

v1（graphify 同梱の extraction-spec.md）との差分は **ラベル規律** の一点のみ。
ノード ID 形式・confidence 規則・edge relation の語彙・source_file 規則は v1 と同一。

## ラベル規律（v2 で追加）

ラベルは概念名である。説明文ではない。

- **20 文字以内。** 超えるなら概念が複数混ざっている。分割するか、より短い名を選ぶ。
- **文にしない。** 句点「。」読点「、」を含めない。「〜は〜する」「〜のこと」の形にしない。
- **括弧による補足を付けない。** `decide（唯一の状態遷移関数）` ではなく `decide`。
- **ドメイン語彙を優先する。** `Roster` / `Sync_Set` / `endTime` / `decide` / `Boiled_Group` /
  `Provisional_Timer` / `Store_Path` など、リポジトリが既に持つ名をそのまま使う。
  ドメイン語がない概念にだけ新しい短い名を与える。
- **説明は `rationale` 属性に置く。** 「なぜそう決めたか」はラベルではなく rationale へ。
  ラベルは何であるかだけを名指す。
- **禁止する汎用語**（`.kiro/steering/naming.md` に準ずる）: `Manager` / `Handler` /
  `Service` / `Util` / `Helper` / `Data` / `Info`、および `process` / `handle` / `manage`。

### 変換例

| 悪いラベル（v1 の実例） | 良いラベル |
| --- | --- |
| `PUT の全置換／配列置換の意味論（現状 + 追加の全量を送る規律）` | `Roster PUT 全置換` |
| `ACCESS_REQUIRED 既定反転（移行期から終着点へ）` | `ACCESS_REQUIRED 既定反転` |
| `戻し後 1 分以内の合鍵 URL 接続確認（JWT 検証を経ない成立）` | `合鍵 URL 接続確認` |
| `decide（唯一の状態遷移関数）` | `decide` |
| `待つなら寝かせる、抱えると漏れる` | `hibernation 規律` |
| `導出値は状態ではない` | `導出値` |
| `Whereami_IdP (in-store presence OIDC, split-horizon)` | `Whereami_IdP` |
| `snapshot 単一表現（唯一の権威表現）` | `snapshot 単一表現` |

長いラベルが「あらゆるクエリに部分一致してシードを汚染する」ことが v1 の実測不具合だった。
ラベルは検索の入口である。名指しに徹する。
