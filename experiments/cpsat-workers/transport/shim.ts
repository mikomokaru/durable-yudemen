// Wrangler emits a global declaration script, not an importable type module.
// Keep this trial's generated type out of the root deployment configuration.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./worker-configuration.d.ts" />
import { isRecord } from "../../../src/domain/predicate";
import manifest from "./manifest.json";
import { toCpsatTransportRequest, sendCpsatTransportRequest } from "./request";
import type { CpsatQueueMessage } from "./queue";

/**
 * shim の binding。求解 Worker への直接 binding は持たない——持てば呼び出せてしまい、
 * この方式が避けようとした連鎖が復活する。到達手段は Queue だけである。
 * 型生成の設定（`wrangler.types.jsonc`）からも外したので、生成型にも現れない。
 */
type CpsatTransportShimEnv = Omit<CpsatTransportProbeEnv, "CPSAT_PLAN_QUEUE"> &
  Pick<Env, "SOLVER"> & { readonly CPSAT_PLAN_QUEUE: Queue<CpsatQueueMessage> };

function withinWindow(): boolean {
  const now = Date.now();
  return (
    manifest.enabled &&
    Number.isSafeInteger(manifest.notBefore) &&
    Number.isSafeInteger(manifest.expiresAt) &&
    manifest.expiresAt > manifest.notBefore &&
    manifest.expiresAt - manifest.notBefore <= 7_200_000 &&
    now >= manifest.notBefore &&
    now < manifest.expiresAt
  );
}

async function readText(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      // No Content-Length trust; the routing inspection itself must be bounded.
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1_048_576) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

// Private SOLVER binding only. This is not an app route or a DO subclass.
// Env names come from the existing generated binding types; no deployment
// configuration is introduced by this local transport module.
export default {
  async fetch(request: Request, env: CpsatTransportShimEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/plan" || url.search !== "")
      return new Response(null, { status: 404 });
    const text = await readText(request);
    if (text === null) return new Response(null, { status: 400 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!isRecord(body) || typeof body.storeId !== "string")
      return new Response(null, { status: 400 });
    const store = manifest.stores.find(
      (item) => item.id === body.storeId && item.series === "shim",
    );
    // Other stores keep the TS destination, even when the trial is disabled.
    // This adds bounded routing inspection and a hop: it is NOT an unchanged
    // production path. Deployment must approve its limits/failure/latency impact.
    if (!store) return env.SOLVER.fetch(new Request(request, { method: "POST", body: text }));
    if (!withinWindow()) return new Response(null, { status: 503 });
    // Inspect only the PlanRequest envelope; never compile its business model.
    // No input field chooses the fixed model, budget or callback destination.
    const keys = [
      "storeId",
      "pending",
      "running",
      "params",
      "noodlePresets",
      "digest",
      "shownPlan",
    ];
    if (
      Object.keys(body).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(body, key)) ||
      !Array.isArray(body.pending) ||
      !Array.isArray(body.running) ||
      !Array.isArray(body.noodlePresets) ||
      !Array.isArray(body.shownPlan) ||
      !isRecord(body.params) ||
      !Number.isSafeInteger(body.digest)
    )
      return new Response(null, { status: 400 });
    const problem = manifest.problems.find((item) => item.name === store.problem);
    if (!problem) return new Response(null, { status: 503 });
    const requestId = crypto.randomUUID();
    const input = toCpsatTransportRequest(
      JSON.stringify({
        schemaVersion: 1,
        eventId: crypto.randomUUID(),
        at: Date.now(),
        storeRef: store.ref,
        backend: "cpsat",
        mode: "probe",
        instanceId: crypto.randomUUID(),
        invocationId: crypto.randomUUID(),
        parentEventId: null,
        versions: {
          code: manifest.code,
          model: problem.sha256,
          codec: manifest.codec,
          wasm: manifest.wasm,
          glue: manifest.glue,
          profile: manifest.profile,
          budget: String(problem.budget),
          missingReason: null,
        },
        fact: {
          type: "cpsat.request-dispatched",
          requestId,
          origin: { kind: "probe" },
          sameInputRetry: false,
        },
      }),
      { allowed: true, origin: { kind: "probe" } },
    );
    if (!input) return new Response(null, { status: 400 });
    // Trial receipt, NOT a CpsatObservation/H1. Never log order IDs, digest,
    // params, raw bodies or invented decision/effect/Persist identities.
    console.log(
      JSON.stringify({
        transport: "shim",
        requestId,
        storeRef: store.ref,
        receivedAt: input.at,
        pendingCount: body.pending.length,
        runningCount: body.running.length,
      }),
    );
    // Queue へ投入して返す。await するのは投入の完了だけで、求解も配送も待たない
    // （design 第9節・R6.7）。呼出元——実際には店舗 DO——を求解に握らせないことが、
    // この輸送方式を選んだ理由そのものである。
    return sendCpsatTransportRequest(input, env.CPSAT_PLAN_QUEUE, withinWindow);
  },
} satisfies ExportedHandler<CpsatTransportShimEnv>;
