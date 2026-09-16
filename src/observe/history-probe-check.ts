// 合成プローブの到達確認（operation-history-log 要件 7.3 / 7.4）。
//
// 見るのは**経路が生きているか**だけである。業務ログの全件到達率へ読み替えないために、結果の名前を
// 分けてある：`visible`（読めた）、`unconfirmed`（期限内に読めなかった）、`reader-failed`（読み取り
// そのものが失敗した）。最後の 2 つを同じ「未達」に畳まない——前者は経路か遅れ、後者は観測側の問題で、
// 打つ手が違う。
//
// 確認は有界回数で終わる。未確認のプローブを永続的に追いかけない（要件 7.4）。

import { probeVisibilityQuery, type HistoryScope } from "./history-query";
import type { PageRunner } from "./history-fetch";
import { INGEST_COLUMN } from "./history-query";

export interface ProbeCheckLimits {
  /** 確認を試みる回数の上限。 */
  readonly attempts: number;
  /** 送出予定からこの時間を過ぎたら期限超過とする（ミリ秒）。 */
  readonly deadlineMs: number;
}

export type ProbeCheck =
  | {
      readonly status: "visible";
      readonly probeId: string;
      readonly attempts: number;
      /** 送出予定から読めるまでに掛かった時間（ミリ秒）。可視までの実測値である。 */
      readonly elapsedMs: number;
      readonly ingestedAt: string;
      /** 同じ ID が複数行あった。経路の複製であって、業務の重複ではない。 */
      readonly duplicated: boolean;
    }
  | {
      readonly status: "unconfirmed";
      readonly probeId: string;
      readonly attempts: number;
      readonly elapsedMs: number;
      readonly reason: "deadline-exceeded" | "attempts-exhausted";
    }
  | {
      readonly status: "reader-failed";
      readonly probeId: string;
      readonly attempts: number;
      readonly errors: readonly { readonly code: number; readonly message: string }[];
    };

/** 確認の間隔を空ける手段。テストでは即座に返す関数を渡す。 */
export type Sleep = (ms: number) => Promise<void>;

/**
 * 1 つのプローブ ID が Iceberg で読めるまでを、有界回数だけ確かめる。
 *
 * `now` を引数で受けるのは、経過時間の判定を呼び出し側の時計に委ねるためである。ここが `Date.now` を
 * 直接呼べば、期限の検査が実時間に縛られる。
 */
export async function checkProbeVisibility(
  run: PageRunner,
  scope: HistoryScope,
  probeId: string,
  emittedAt: number,
  limits: ProbeCheckLimits,
  clock: { readonly now: () => number; readonly sleep: Sleep },
): Promise<ProbeCheck> {
  let attempts = 0;

  while (attempts < limits.attempts) {
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await run(probeVisibilityQuery(scope, probeId));
    attempts += 1;

    if (!outcome.ok) {
      return { status: "reader-failed", probeId, attempts, errors: outcome.errors };
    }

    const [first] = outcome.rows;
    if (first !== undefined) {
      const ingestedAt = first[INGEST_COLUMN];
      return {
        status: "visible",
        probeId,
        attempts,
        elapsedMs: clock.now() - emittedAt,
        ingestedAt: typeof ingestedAt === "string" ? ingestedAt : "",
        duplicated: outcome.rows.length > 1,
      };
    }

    const elapsedMs = clock.now() - emittedAt;
    if (elapsedMs >= limits.deadlineMs) {
      return { status: "unconfirmed", probeId, attempts, elapsedMs, reason: "deadline-exceeded" };
    }
    if (attempts >= limits.attempts) break;

    // 次の確認まで待つ。残り時間を回数で割り、期限を越えない範囲に収める。
    // oxlint-disable-next-line no-await-in-loop
    await clock.sleep(
      Math.max(0, Math.floor((limits.deadlineMs - elapsedMs) / (limits.attempts - attempts + 1))),
    );
  }

  return {
    status: "unconfirmed",
    probeId,
    attempts,
    elapsedMs: clock.now() - emittedAt,
    reason: "attempts-exhausted",
  };
}
