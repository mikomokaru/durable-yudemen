import { runtime, solve } from "../src/runtime";

const protocol = "cpsat-search-v1";
const wasmSha256 = "c8b89a734a15ad067e18edd08fc58d179aff63bf9922080e75fbeeecfb0223a1";
// Runtime identity only, never request data. Reuse exactly one frozen-clock
// Wasm instance per isolate; solve() is synchronous and has no interleaving await.
let isolateId: string | undefined;
const maxBytes = 1048576;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function authorized(request: Request, secret: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(secret ?? "")) return false;
  const provided = request.headers.get("authorization") ?? "";
  if (provided.length > 256) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${secret}`)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function readModel(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    parts.push(part.value);
  }
  if (!size) return null;
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export default {
  async fetch(request: Request, env: CpsatSearchEnv): Promise<Response> {
    if (!(await authorized(request, env.SEARCH_AUTH_TOKEN)))
      return json({ error: "unauthorized" }, 401);
    const expires = Date.parse(env.SEARCH_EXPIRES_AT);
    if (!Number.isFinite(expires) || Date.now() >= expires)
      return json({ error: "search endpoint expired" }, 403);
    const url = new URL(request.url);
    if (
      !["yude-men-cpsat-search.yamaokaya.workers.dev", "127.0.0.1", "localhost"].includes(
        url.hostname,
      )
    )
      return json({ error: "unexpected host" }, 404);
    const identity = {
      protocol,
      wasmSha256,
      versionId: env.CF_VERSION_METADATA.id,
      expiresAt: env.SEARCH_EXPIRES_AT,
    };
    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method" }, 405);
      return json({ ...identity, ok: true, clock: "frozen", searchWorkers: 1, cpuLimitMs: 10000 });
    }
    if (url.pathname !== "/solve-model") return json({ error: "not found" }, 404);
    if (request.method !== "POST") return json({ error: "method" }, 405);
    if (request.headers.get("content-type") !== "application/octet-stream")
      return json({ error: "content-type" }, 415);
    const raw = url.searchParams.get("deterministicLimit");
    const limit = Number(raw);
    if (
      [...url.searchParams.keys()].some((key) => key !== "deterministicLimit") ||
      url.searchParams.getAll("deterministicLimit").length !== 1 ||
      !raw ||
      raw.trim() !== raw ||
      !Number.isFinite(limit) ||
      limit <= 0 ||
      limit > 0.2
    )
      return json({ error: "deterministicLimit must be in (0, 0.2]" }, 400);
    const suppliedId = request.headers.get("x-cpsat-request-id");
    if (!suppliedId || !/^[a-f0-9-]{36}$/.test(suppliedId))
      return json({ error: "request ID must be UUID-shaped" }, 400);
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))
      return json({ error: "body size" }, 413);
    const bytes = await readModel(request);
    if (!bytes) return json({ error: "body must be 1..1048576 bytes" }, 413);
    isolateId ??= crypto.randomUUID();
    try {
      const loaded = await runtime("frozen");
      const result = solve(loaded.value, "model", limit, bytes);
      console.log(
        JSON.stringify({
          kind: protocol,
          requestId: suppliedId,
          isolateId,
          versionId: identity.versionId,
          status: result.status,
          modelBytes: bytes.length,
          variables: result.modelVariables,
          constraints: result.modelConstraints,
          wasmMemoryBytes: result.wasmMemoryBytes,
          initializedNow: loaded.initializedNow,
        }),
      );
      return json({
        ...identity,
        requestId: suppliedId,
        isolateId,
        initializedNow: loaded.initializedNow,
        searchWorkers: 1,
        samples: [result],
      });
    } catch {
      // Do not reflect/log arbitrary protobuf contents or auth values.
      console.error(
        JSON.stringify({ kind: protocol, requestId: suppliedId, error: "solver failed" }),
      );
      return json({ error: "solver failed", requestId: suppliedId }, 422);
    }
  },
} satisfies ExportedHandler<CpsatSearchEnv>;
