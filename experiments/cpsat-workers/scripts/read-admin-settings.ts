// GET のみ。トークン・Roster・原応答全体を出力せず、実効設定とも名乗らない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const origin = "https://yude-men-timer.yamaokaya.workers.dev";
const [envFile, ...storeCodes] = process.argv.slice(2);
assert(
  envFile && storeCodes.length > 0,
  "Usage: read-admin-settings.ts ENV_FILE ADMIN_STORE_CODE...",
);
assert(
  storeCodes.every((code) => /^\d+$/.test(code)),
  "Use admin storeCode, not a URL or slug",
);
assert(new Set(storeCodes).size === storeCodes.length, "Duplicate storeCode");
const token = record(parseEnv(readFileSync(envFile, "utf8"))).ADMIN_TOKEN;
assert(typeof token === "string" && token.length > 0, "ADMIN_TOKEN is missing");

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Expected object");
  return value as Record<string, unknown>;
}

async function get(path: string) {
  // origin は固定。redirect 先に秘密を送らない。
  const response = await fetch(`${origin}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  return {
    status: response.status,
    value: response.ok ? ((await response.json()) as unknown) : null,
  };
}

const listed = await get("/admin/stores");
assert(listed.status === 200 && Array.isArray(listed.value), `Store list HTTP ${listed.status}`);
const summaries = listed.value.map(record);
const stores = [];
const policyIds = new Set<string>();
for (const storeCode of storeCodes) {
  // 一覧は storeCode を含まない。名称の先頭で候補を絞り、必ず個別 GET の storeCode で確定する。
  const candidates = summaries.filter(
    (store) => typeof store.name === "string" && store.name.startsWith(`${storeCode} `),
  );
  assert(
    candidates.length === 1,
    `Store ${storeCode}: expected one name candidate, found ${candidates.length}`,
  );
  const storeId = candidates[0]!.storeId;
  assert(typeof storeId === "string", "Missing storeId");
  const fetched = await get(`/admin/stores/${encodeURIComponent(storeId)}`);
  assert(fetched.status === 200, `Store ${storeCode}: HTTP ${fetched.status}`);
  const store = record(fetched.value);
  assert(
    store.storeCode === storeCode && store.storeId === storeId,
    `Store ${storeCode}: identity mismatch`,
  );
  assert(
    Array.isArray(store.policyIds) &&
      store.policyIds.every((id: unknown) => typeof id === "string"),
    "Invalid policyIds",
  );
  for (const id of store.policyIds) policyIds.add(id);
  stores.push({
    storeId,
    storeCode,
    policyIds: store.policyIds,
    override: record(store.override),
    updatedAt: store.updatedAt,
    active: store.active,
  });
}
const policies = [];
for (const policyId of [...policyIds].sort()) {
  const fetched = await get(`/admin/policies/${encodeURIComponent(policyId)}`);
  // 未取得を空 Policy に読み替えない。
  const policy = fetched.status === 200 ? record(fetched.value) : null;
  policies.push({ policyId, status: fetched.status, fields: policy?.fields ?? null });
}
console.log(
  JSON.stringify(
    {
      source: origin,
      fetchedAt: new Date().toISOString(),
      scope:
        "Current admin store overrides only; not historical or effective settings. POS store mapping is not inferred.",
      stores,
      policies,
    },
    null,
    2,
  ),
);
