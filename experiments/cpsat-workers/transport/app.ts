import { WorkerEntrypoint } from "cloudflare:workers";
import { timingSafeEqual } from "../../../src/worker-auth";
import { IDENTITY_HEADER } from "../../../src/shell/store-timer-do";
import manifest from "./manifest.json";
import { toCpsatTransportRequest, sendCpsatTransportRequest } from "./request";
import type { CpsatQueueMessage } from "./queue";

// A separate trial bundle: the ordinary public handler and DO implementations
// are unchanged. No route in src/worker.ts exposes this named entrypoint.
export { default, StoreRegistryDO, StoreTimerDO } from "../../../src/worker";

/** The trial's time window. Read afresh at every effect boundary. */
/** 試験入口の binding。`CPSAT_PLAN_QUEUE` の要素型だけを絞る。 */
type CpsatTransportAppEnv = Omit<CpsatTransportProbeEnv, "CPSAT_PLAN_QUEUE"> & {
  readonly CPSAT_PLAN_QUEUE: Queue<CpsatQueueMessage>;
};

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

/**
 * Both entrances share one authorization, so neither can drift into being the
 * weaker door. The private binding is the outer authority; the per-run random
 * token and exact loopback Origin additionally restrict the trial driver.
 */
async function authorizedTrialRequest(request: Request): Promise<boolean> {
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(manifest.origin) ||
    Number(manifest.origin.slice(manifest.origin.lastIndexOf(":") + 1)) > 65_535 ||
    request.headers.get("Origin") !== manifest.origin ||
    !/^[0-9a-f]{64}$/.test(manifest.requestTokenSha256)
  )
    return false;
  const authorization = request.headers.get("Authorization") ?? "";
  if (!/^Bearer [0-9a-f]{64}$/.test(authorization)) return false;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(authorization.slice(7)),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return timingSafeEqual(hex, manifest.requestTokenSha256);
}

/**
 * Read a bounded body. The limit is enforced while consuming, not after: a
 * check on the finished string is not a bound on what was received.
 */
async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      // Consume sequentially and bound bytes, not the untrusted Content-Length.
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
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

/** Fixed-input transport only; not an online planner or a provisioning API. */
export class CpsatTransportProbe extends WorkerEntrypoint<CpsatTransportAppEnv> {
  override async fetch(request: Request): Promise<Response> {
    if (!withinWindow()) return new Response(null, { status: 503 });
    const allowed = await authorizedTrialRequest(request);
    if (!allowed) return new Response(null, { status: 401 });
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/plan" || url.search !== "")
      return new Response(null, { status: 404 });

    const input = toCpsatTransportRequest(await readBoundedText(request, 16_384), {
      allowed,
      origin: { kind: "probe" },
    });
    if (
      input === null ||
      !manifest.stores.some((store) => store.ref === input.storeRef && store.series === "direct")
    )
      return new Response(null, { status: 400 });
    // Authorization/body reads can cross the deadline. Pass the predicate,
    // not its earlier result, so dispatch rechecks immediately before sending.
    // Queue へ投入して返す。**アプリは求解 Worker への binding を持たない**——
    // 持てば同期の求解に握られる連鎖が復活し、手順で「同時に流さない」と約束して
    // 守り続けることになる。binding が無いほうが確かである（2026-09-12 の判断）。
    return sendCpsatTransportRequest(input, this.env.CPSAT_PLAN_QUEUE, () => withinWindow());
  }
}

/**
 * Synthetic operations and the WebSocket view, for the trial driver only.
 *
 * The local harness reached the Durable Object through Miniflare's namespace
 * handle, which does not exist in cloud. This entrance is the replacement, and
 * it is a different concept from the fixed-problem send: it carries no model,
 * budget or callback destination, and it never plans.
 *
 * Every path passes the same three gates as the probe — window, authorization,
 * allow-listed store — and the window is read again at the effect boundary,
 * after the asynchronous authorization. The driver's durable ledger reserves
 * before calling, so a connection cannot enter without being counted either.
 */
export class CpsatTransportOperations extends WorkerEntrypoint<
  CpsatTransportAppEnv & Pick<Env, "STORE_TIMER_DO">
> {
  override async fetch(request: Request): Promise<Response> {
    if (!withinWindow()) return new Response(null, { status: 503 });
    if (!(await authorizedTrialRequest(request))) return new Response(null, { status: 401 });
    const url = new URL(request.url);
    // Only the manifest's synthetic stores. No input names another destination.
    const store = manifest.stores.find((item) => item.id === url.searchParams.get("store"));
    if (!store) return new Response(null, { status: 404 });
    // Authorization crossed an await, so the window is read again here.
    if (!withinWindow()) return new Response(null, { status: 503 });

    // The caller never supplies identity. Strip anything it sent and set the
    // manifest's rostered trial identity, mirroring how src/worker.ts refuses
    // to pass a client-supplied identity header through to the store.
    const headers = new Headers(request.headers);
    headers.delete(IDENTITY_HEADER);
    headers.set(IDENTITY_HEADER, manifest.identity);
    const stub = this.env.STORE_TIMER_DO.get(this.env.STORE_TIMER_DO.idFromName(store.id));

    if (url.pathname === "/ops/watch") {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response(null, { status: 426 });
      // Subscription only. Returning the store's socket unchanged would hand
      // the caller a bidirectional channel: it could send Start and the rest,
      // and everything after the upgrade would skip this entrance's window
      // check and the driver's ledger. So terminate here and relay one way.
      const upstream = await stub.fetch(new Request("https://do.invalid/ws", { headers }));
      const store_socket = upstream.webSocket;
      if (upstream.status !== 101 || !store_socket) return new Response(null, { status: 502 });
      const pair = new WebSocketPair();
      const caller = pair[0];
      const relay = pair[1];
      store_socket.accept();
      relay.accept();

      // Three separate things, which the previous version ran together.
      //
      //   1. Close *request*: ask both sides to go away.
      //   2. Close *confirmation*: both sides have reported that they did.
      //   3. Trial deadline: the window ending must itself request a close.
      //
      // `waitUntil` is none of these. It is a platform lifetime bound on work
      // after the response, so it can end the relay earlier than the deadline
      // and cannot enforce it. The deadline below is the only mechanism that
      // does. Neither bound has been measured in cloud yet (task 2.3).
      const pending = new Set(["store", "caller"]);
      let confirmBoth: () => void;
      const bothConfirmed = new Promise<void>((resolve) => {
        confirmBoth = resolve;
      });
      const sideEnded = (side: string): void => {
        pending.delete(side);
        if (pending.size === 0) confirmBoth();
      };
      const requestClose = (code: number, reason: string): void => {
        for (const socket of [store_socket, relay]) {
          try {
            socket.close(code, reason);
          } catch {
            // Already closing from the other side; the close event still comes.
          }
        }
      };

      // One side ending must ask the other to end too. Marking only the side
      // that reported would leave the store's socket open when the caller
      // hangs up: nothing else would close it until the deadline fires, and
      // `bothConfirmed` would sit unresolved until then. The teardown check is
      // the caller's own close, so it cannot see that leftover either.
      const endSide = (side: string, code: number, reason: string): void => {
        sideEnded(side);
        requestClose(code, reason);
      };
      store_socket.addEventListener("message", (event) => relay.send(event.data));
      store_socket.addEventListener("close", (event) =>
        endSide("store", event.code === 1005 ? 1000 : event.code, event.reason || "store closed"),
      );
      store_socket.addEventListener("error", () => endSide("store", 1011, "store error"));
      // Any caller-to-store frame is a contract violation for this entrance.
      relay.addEventListener("message", () => requestClose(4003, "subscription only"));
      relay.addEventListener("close", (event) =>
        endSide("caller", event.code === 1005 ? 1000 : event.code, event.reason || "caller closed"),
      );
      relay.addEventListener("error", () => endSide("caller", 1011, "caller error"));

      const remaining = manifest.expiresAt - Date.now();
      const deadline = setTimeout(
        () => requestClose(4001, "trial window closed"),
        Math.max(0, remaining),
      );
      void bothConfirmed.then(() => clearTimeout(deadline));
      // Held until both sides confirm. If one never does, the platform ends the
      // invocation — that is the platform's bound, not a close confirmation.
      this.ctx.waitUntil(bothConfirmed);
      return new Response(null, { status: 101, webSocket: caller });
    }
    if (url.pathname === "/ops/orders" && request.method === "POST") {
      const body = await readBoundedText(request, 16_384);
      if (body === null) return new Response(null, { status: 413 });
      // Reading the body crossed another await. The window is read once more
      // here, immediately before the store is touched, with nothing async in
      // between. The check above cannot stand in for this one.
      if (!withinWindow()) return new Response(null, { status: 503 });
      return stub.fetch(
        new Request("https://do.invalid/orders", { method: "POST", headers, body }),
      );
    }
    return new Response(null, { status: 404 });
  }
}
