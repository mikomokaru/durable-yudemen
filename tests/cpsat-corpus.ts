import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **実注文コーパスが手元に在るか。**
 *
 * `docs/data_samples/noodle_plan_histories/` は実店舗の注文の原本で、`.gitignore` により
 * **意図的に追跡していない**（「コードと集計結果だけを追跡する」）。ゆえに CI には存在せず、
 * これを読む試験は CI で必ず落ちる——2026-09-16 に 5 ファイルがこれで落ちた。
 *
 * 落とすのではなく飛ばす。手元では従来どおり走り、CI では「走らなかった」ことが
 * skip として見える。**期待値は緩めない**——検査そのものは一切変えていない。
 */
export const cpsatCorpusAvailable = (() => {
  const directory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../docs/data_samples/noodle_plan_histories",
  );
  if (!existsSync(directory)) return false;
  return readdirSync(directory).some((name) => name.endsWith(".jsonl"));
})();
