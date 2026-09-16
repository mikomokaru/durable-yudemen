import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// The trial window and credentials live in the manifest the bundler replaces at
// build time. Here the entrance is exercised directly, so the manifest is
// substituted instead. The token below hashes to requestTokenSha256.
const TOKEN = "a".repeat(64);
vi.mock("../../experiments/cpsat-workers/transport/manifest.json", () => ({
  default: {
    enabled: true,
    // A live window around now; the span must stay inside the two-hour cap.
    notBefore: Date.now() - 1_000,
    expiresAt: Date.now() + 3_600_000,
    origin: "http://127.0.0.1:1",
    requestTokenSha256: "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    identity: "transport@invalid.example",
    code: "0".repeat(64),
    codec: "1".repeat(64),
    profile: "2".repeat(64),
    wasm: "3".repeat(64),
    glue: "4".repeat(64),
    stores: [{ id: "relay-store", ref: "5".repeat(64), series: "direct", problem: "small" }],
    problems: [],
  },
}));

const { CpsatTransportOperations } = await import("../../experiments/cpsat-workers/transport/app");

afterEach(() => vi.restoreAllMocks());

/**
 * A stand-in for the store's socket whose close is under the test's control.
 *
 * A real WebSocketPair cannot separate the two events this test is about: the
 * relay's `close()` reaches the peer and settles the local side at once, so
 * "the relay asked" and "the store confirmed" collapse into one moment.
 */
function upstreamStub() {
  const listeners = new Map<string, ((event: { code: number; reason: string }) => void)[]>();
  const closeRequests: { code: number; reason: string }[] = [];
  const socket = {
    accept(): void {},
    send(): void {},
    close(code: number, reason: string): void {
      closeRequests.push({ code, reason });
    },
    addEventListener(type: string, handler: (event: { code: number; reason: string }) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
  } satisfies Pick<WebSocket, "accept" | "send"> & Record<string, unknown>;
  return {
    socket,
    closeRequests,
    confirmClose(): void {
      for (const handler of listeners.get("close") ?? [])
        handler({ code: 1000, reason: "store confirmed" });
    },
  };
}

async function openRelay() {
  const upstream = upstreamStub();
  // Real namespace, real id, real stub type: only the one value that genuinely
  // differs is stood in for. `webSocket` on a Response cannot be assigned, and
  // a real socket would settle immediately, so the upgrade result is the single
  // point where the shape deviates from the platform's.
  const namespace = env.STORE_TIMER_DO as DurableObjectNamespace<StoreTimerDO>;
  const stub = namespace.get(namespace.idFromName("relay-store"));
  vi.spyOn(stub, "fetch").mockResolvedValue({
    status: 101,
    webSocket: upstream.socket,
  } as unknown as Response);
  vi.spyOn(namespace, "get").mockReturnValue(stub);

  const ctx = createExecutionContext();
  // 求解 Worker への binding はもう env に無い。WS 中継は求解に触れないので、
  // 投入口も要らない——この入口が Queue を持たないことは、経路の分離そのものである。
  const entrance = new CpsatTransportOperations(ctx, {
    ...env,
    CPSAT_PLAN_QUEUE: undefined as never,
  });
  const response = await entrance.fetch(
    new Request("https://probe.invalid/ops/watch?store=relay-store", {
      headers: {
        Upgrade: "websocket",
        Origin: "http://127.0.0.1:1",
        Authorization: `Bearer ${TOKEN}`,
      },
    }),
  );
  expect(response.status).toBe(101);
  const caller = response.webSocket;
  if (!caller) throw new Error("No caller socket");
  caller.accept();
  // Held once. Calling waitOnExecutionContext again would take a fresh, empty
  // list of pending work and resolve immediately, which proves nothing.
  const pending = waitOnExecutionContext(ctx).then(() => true);
  return { upstream, caller, pending };
}

/** Observe the one pending-work promise, without creating another. */
function settledWithin(pending: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

it("asks the store to close as soon as the caller does, without waiting for the deadline", async () => {
  const { upstream, caller, pending } = await openRelay();
  try {
    expect(upstream.closeRequests).toHaveLength(0);
    caller.close(1000, "caller done");
    // The deadline is over an hour away; this must not depend on it.
    await vi.waitFor(() => expect(upstream.closeRequests.length).toBeGreaterThan(0));
    expect(upstream.closeRequests[0]).toMatchObject({ code: 1000 });
  } finally {
    upstream.confirmClose();
    await settledWithin(pending, 2_000);
  }
});

it("does not complete until the store confirms, then completes on that same wait", async () => {
  const { upstream, caller, pending } = await openRelay();
  try {
    caller.close(1000, "caller done");
    await vi.waitFor(() => expect(upstream.closeRequests.length).toBeGreaterThan(0));

    // Only the caller has confirmed. Completing here would report a finished
    // connection while the store's side was still open.
    expect(await settledWithin(pending, 250)).toBe(false);

    upstream.confirmClose();
    // The same promise, not a second wait on an already-drained context.
    expect(await settledWithin(pending, 2_000)).toBe(true);
  } finally {
    upstream.confirmClose();
    await settledWithin(pending, 2_000);
  }
});
