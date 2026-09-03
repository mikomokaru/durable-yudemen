// core/rejection.ts — 拒否理由（core）と失敗（shell）を構造で表現する型定義。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// 「全てのパスを構造で表現する」。requirements が挙げた全分岐を型に織り込み、
// 握り潰された失敗を残さない。

/** core が業務ルール上の拒否を表す（例外ではなく戻り値）。拒否時は状態不変・Effect なし。 */
export type Rejection =
  | { readonly code: "InvalidBoilSeconds"; readonly message: string } // 要件1.5
  | { readonly code: "InvalidSlotOrNoodle"; readonly message: string } // 要件1.5
  | { readonly code: "CapacityExceeded"; readonly message: string } // 要件3.8
  | { readonly code: "TimerNotFound"; readonly message: string } // 要件6.6
  // 指した品目が待ち行列に無い（slot-suggested-start）。麺種を導けないため Timer を作れない。
  // AC 8.3「推奨との不一致を理由に拒否しない」の例外ではなく別の事実である——同 AC が守るのは現場の
  // 選択であり、他端末が直前に開始した品目の二重調理ではない。
  | { readonly code: "OrderItemNotFound"; readonly message: string };

/** shell 側で扱う、core の外側の失敗（永続・スキーマに由来する）。 */
export type ShellFailure =
  | { readonly code: "PersistFailed" } // 要件8.5 storage.put 失敗
  | { readonly code: "LoadFailed" } // 要件7.5 storage.get 失敗
  | { readonly code: "UnsupportedSchemaVersion" } // 要件11.5
  | { readonly code: "MigrationFailed" }; // 要件11.6
