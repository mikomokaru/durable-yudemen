// display/worker.ts — 札の Worker の入口。設定正本は wrangler.short-names.jsonc。
//
// 担うのは 1 つの経路だけである。
//   POST /display/observed   初出の検出の起動（root の POS 取り込みが呼ぶ）
//
// **辞書を配る経路は持たない。** 札は品目に載って WS で届くので（判断 20・24）、client が HTTP で
// 取りに来ることがない。配信経路は root の中継ごと撤去した。
//
// **ネットワークへ露出しない。** 到達経路は root の `SHORT_NAMES_WORKER`（service binding）ただ一つで、
// routes も workers.dev も持たない。ゆえに独自のトークンを置かない——binding を引けることが認可である
// （solver と同じ判断）。
//
// **生成は応答を待たせない。** `POST /display/observed` は 202 を即返し、検出と生成は自分の
// `ctx.waitUntil` の中で走る。呼び出し元（root）もこの fetch を待たないので、AI の遅さが POS の
// 取り込み応答に波及する経路が二重に断たれている。
//
// Env は root と**別の型**である（`ShortNamesEnv`・`pnpm short-names:types` で生成）。root の `Env` に
// `AI` / `SHORT_NAMES` が現れないことが、`StoreTimerDO` がそれらの直接 binding を持たないことの担保である。

import { isRecord } from "../domain/predicate";
import { detectFirstAppearance, type ShortNameCache } from "./detect";
import type { ShortNameDeps } from "./generate";
import type { StoreTimerDO } from "../shell/store-timer-do";

/**
 * 生成 Env の DO binding だけを型で絞る。cross-script の binding は `wrangler types` が
 * `DurableObjectNamespace`（クラス未指定）として出すため、そのままでは RPC が引けない。
 *
 * `src/solver/index.ts` が `deliverPlan` のために同じことをしている。`import type` は実行時に消えるので、
 * DO の実装がこの Worker の束に入ることはない。
 */
export type ShortNamesWorkerEnv = Omit<ShortNamesEnv, "STORE_TIMER_DO"> & {
  readonly STORE_TIMER_DO: DurableObjectNamespace<StoreTimerDO>;
};

/**
 * isolate が持ち越す既知の鍵。モジュール・スコープに 1 つだけ置く。
 *
 * 可変だが、失われても余計な `list()` が 1 回増えるだけで正しさには効かない（`detect.ts` の
 * `ShortNameCache` の注記）。isolate をまたいで共有されることも、要求のあいだで漏れることもない。
 */
const cache: ShortNameCache = { entries: null };

export default {
  async fetch(
    request: Request,
    env: ShortNamesWorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/display/observed" && request.method === "POST") {
      return observed(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<ShortNamesWorkerEnv>;

/**
 * 届いた商品名を受け、初出の検出を `ctx.waitUntil` で起動する。**202 を即返す。**
 *
 * ボディは `{ names: string[] }`（生の申告名・正規化前）。正規化と重複除去は `detectFirstAppearance` が行う
 * ——鍵で畳みつつ生の表記を 1 つ保つ必要があり、その規則は 1 箇所にしか置かない。
 *
 * 読めないボディは 400 で返すが、**呼び出し元はこの応答を読まない**（root は `waitUntil` の中で投げっぱなし）。
 * 400 は観測のためであって、取り込みの成否には一切効かない。
 */
async function observed(
  request: Request,
  env: ShortNamesWorkerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  let names: readonly string[];
  let storeId: string;
  try {
    const body: unknown = await request.json();
    if (!isRecord(body) || !Array.isArray(body.names) || typeof body.storeId !== "string") {
      return new Response("Expected { storeId: string, names: string[] }", { status: 400 });
    }
    // **宛先は解決済みの StoreId である**（POS の Store_Code ではない）。押し込み先の DO を
    // `getByName` で引くのはこの値で、root 側が宛先解決の結果として渡す。
    storeId = body.storeId;
    if (storeId.length === 0) return new Response("Empty storeId", { status: 400 });
    names = body.names.filter((name): name is string => typeof name === "string");
  } catch {
    return new Response("Malformed body", { status: 400 });
  }

  const deps: ShortNameDeps = {
    ai: env.AI,
    store: env.SHORT_NAMES,
    model: env.SHORT_NAME_MODEL,
    now: () => Date.now(),
  };
  // 押し込みは「その名前を観測した店舗」へ限る（全店 fan-out はしない）。DO の実体は cross-script
  // binding で引く——クラスの所有者は root の Worker である。
  const push = async (target: string, labels: Readonly<Record<string, string>>): Promise<void> => {
    await env.STORE_TIMER_DO.getByName(target).applyShortNames(labels);
  };
  // 失敗を握り潰す。生成の失敗は取り込みの失敗ではなく、辞書にエントリが残らないだけである
  // （当該商品の次の到着で再検出される）。
  ctx.waitUntil(detectFirstAppearance(deps, cache, storeId, names, push).catch(() => undefined));
  return new Response(null, { status: 202 });
}
