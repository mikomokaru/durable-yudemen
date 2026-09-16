// Read-only inventory for task 2.1. Never invoke a solver or change cloud resources.
// Optional argument: the existing application .dev.vars path (ADMIN_TOKEN only).
/* eslint-disable no-await-in-loop -- Bound control-plane and shared Registry reads to one in flight; retain acquisition order. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

const accountId = "305d89a643ac689b4204454c5493cbde";
const services = [
  "yude-men-timer",
  "yude-men-solver",
  "yude-men-cpsat-planner-dev",
  "yude-men-cpsat-transport-shim-dev",
];
const storeIds = [1, 2, 3, 4].map((n) => `cpsat-transport-20260909-0${n}`);
const chainId = "cpsat-transport-20260909";
const selected = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  );

async function inventory() {
  if (process.argv.length > 3) throw new Error("arguments");
  const token =
    process.env.CLOUDFLARE_API_TOKEN ??
    /^oauth_token\s*=\s*"([^"]+)"/m.exec(
      await readFile(
        process.env.CPSAT_CF_AUTH_FILE ??
          join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
        "utf8",
      ),
    )?.[1];
  if (!token) throw new Error("credential");
  const observations = [];
  async function api(path, project) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    observations.push({
      path,
      status: response.status,
      success: body.success,
      errorCodes: body.errors?.map((error) => error.code) ?? [],
      pagination: body.result_info ?? null,
      result: body.success === true ? project(body.result) : null,
    });
    return body.success === true ? body.result : null;
  }
  const prefix = `accounts/${accountId}`;
  await api(`${prefix}/workers/domains`, (rows) =>
    rows
      .filter((row) => services.includes(row.service))
      .map((row) => selected(row, ["id", "hostname", "service", "environment", "zone_id"])),
  );
  await api(`${prefix}/workers/subdomain`, (value) => selected(value, ["subdomain"]));
  const zones = await api(`zones?account.id=${accountId}&per_page=50`, (rows) =>
    rows.map((row) => selected(row, ["id", "name"])),
  );
  // A partial account inventory must not be interpreted as proof of route isolation.
  const pagination = observations.at(-1)?.pagination;
  if (pagination?.total_pages !== 1) throw new Error("zone-pagination");
  for (const zone of zones ?? []) {
    await api(`zones/${zone.id}/workers/routes`, (rows) =>
      rows
        .filter((row) => services.includes(row.script))
        .map((row) => selected(row, ["id", "pattern", "script"])),
    );
  }
  await api(`${prefix}/workers/durable_objects/namespaces?per_page=100`, (rows) =>
    rows
      .filter((row) => services.includes(row.script))
      .map((row) => selected(row, ["id", "class", "name", "script", "use_sqlite"])),
  );
  for (const service of services) {
    const script = `${prefix}/workers/scripts/${service}`;
    await api(`${script}/settings`, (value) => ({
      ...selected(value, [
        "usage_model",
        "limits",
        "compatibility_date",
        "compatibility_flags",
        "observability",
        "logpush",
        "tail_consumers",
      ]),
      bindings: value.bindings?.map((binding) => ({
        ...selected(binding, [
          "name",
          "type",
          "class_name",
          "namespace_id",
          "script_name",
          "service",
          "environment",
        ]),
        ...([
          "PLANNER_BACKEND",
          "ACCESS_REQUIRED",
          "OBSERVE_DEBUG",
          "OPERATION_HISTORY_ENABLED",
        ].includes(binding.name)
          ? { text: binding.text }
          : {}),
      })),
    }));
    await api(`${script}/subdomain`, (value) => selected(value, ["enabled", "previews_enabled"]));
    await api(`${script}/deployments`, (value) => ({
      latest: [...value.deployments]
        .sort((a, b) => b.created_on.localeCompare(a.created_on))
        .slice(0, 1)
        .map((row) => selected(row, ["id", "created_on", "source", "strategy", "versions"])),
    }));
  }

  const admin = [];
  if (process.argv[2]) {
    const adminToken = parseEnv(await readFile(process.argv[2], "utf8")).ADMIN_TOKEN;
    if (!adminToken) throw new Error("admin-credential");
    for (const path of ["/admin/chains", ...storeIds.map((id) => `/admin/stores/${id}`)]) {
      const response = await fetch(`https://yude-men-timer.yamaokaya.workers.dev${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const entry = { path, status: response.status };
      if (path === "/admin/chains" && response.ok) {
        const rows = await response.json();
        entry.validList = Array.isArray(rows);
        entry.candidate = chainId;
        entry.matches = Array.isArray(rows)
          ? rows.filter((row) => row.chainId === chainId).length
          : null;
      } else {
        await response.body?.cancel();
      }
      admin.push(entry);
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    scope: "read-only task 2.1 inventory; not a gate verdict",
    accountId,
    observations,
    admin: admin.length ? admin : null,
  };
}

try {
  console.log(JSON.stringify(await inventory(), null, 2));
} catch {
  // Fetch exceptions and API responses can contain URLs or credentials. Never dump them.
  console.error(
    "Inventory incomplete. Check existing authentication and connectivity; raw error withheld.",
  );
  process.exitCode = 1;
}
