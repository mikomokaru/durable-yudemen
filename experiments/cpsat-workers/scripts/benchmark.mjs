import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pocDirectory = resolve(scriptDirectory, "..");
const repository = resolve(pocDirectory, "../..");
const config = resolve(pocDirectory, "wrangler.jsonc");
const port = Number(process.env.CPSAT_POC_PORT ?? "8791");
const remoteArgument = process.argv.indexOf("--url");
const remoteUrl = remoteArgument >= 0 ? process.argv[remoteArgument + 1] : undefined;
if (remoteArgument >= 0 && remoteUrl !== "https://yude-men-cpsat-wasm-poc.yamaokaya.workers.dev") {
  throw new Error("Remote URL must match the approved Yamaokaya PoC Worker");
}
const baseUrl = remoteUrl ?? `http://127.0.0.1:${port}`;
const secretFile = await readFile(resolve(pocDirectory, ".dev.vars"), "utf8");
const authToken = /^POC_AUTH_TOKEN=([a-f0-9]{64})$/m.exec(secretFile)?.[1];
if (!authToken) throw new Error("Run scripts/init-secret.mjs before benchmarking");
const outputArgument = process.argv.indexOf("--output");
const outputPath =
  outputArgument >= 0 && process.argv[outputArgument + 1]
    ? resolve(process.argv[outputArgument + 1])
    : resolve(
        pocDirectory,
        remoteUrl ? "results/deterministic-remote.json" : "results/deterministic-auth-local.json",
      );

// Fixture-specific regression tolerances, NOT solver guarantees. Native
// calibration found coarse presolve batches (~0.0414 for a budget of 0.01).
// Search fixtures allow 0.005 deterministic units of cooperative overshoot.
const fixtures = {
  small: { case: "small", budget: 0.05, maximumConsumed: 0.055 },
  presolve: { case: "hard", budget: 0.01, maximumConsumed: 0.06 },
  searchLow: { case: "hard-search", budget: 0.01, maximumConsumed: 0.015 },
  search: { case: "hard-search", budget: 0.05, maximumConsumed: 0.055 },
  searchHigh: { case: "hard-search", budget: 0.1, maximumConsumed: 0.105 },
};
const requestWatchdogMs = 15_000;
const report = {
  measuredAt: new Date().toISOString(),
  host: { platform: process.platform, architecture: process.arch, node: process.version },
  toolchain: {
    orToolsNative: "9.15.6755",
    orToolsWasmRevision: "e1453348bc43d3b0afc0c2e5a535f5c9b45326f4",
    emscripten: "4.0.20",
  },
  configuration: { fixtures, requestWatchdogMs, freshWorkerdPerClockMode: !remoteUrl, baseUrl },
  native: {},
  worker: {},
  checks: {},
};

async function command(file, arguments_, options = {}) {
  const result = await execute(file, arguments_, {
    cwd: repository,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
    ...options,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function workerRequest(pathname, expectedStatus = 200, token = authToken) {
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  const response = await fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(requestWatchdogMs),
    redirect: "error",
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "x-cpsat-request-id": requestId,
    },
  });
  const body = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`Worker returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return {
    requestId,
    clientElapsedMs: performance.now() - startedAt,
    httpStatus: response.status,
    cfRay: response.headers.get("cf-ray"),
    body,
  };
}

async function assertPortAvailable() {
  const probe = createServer();
  await new Promise((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolvePromise));
  });
}

async function waitForServer(server, log) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null || log.spawnError) {
      throw new Error(`wrangler dev exited early\n${log.value}`);
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1_000),
        headers: { authorization: `Bearer ${authToken}` },
      });
      // eslint-disable-next-line no-await-in-loop
      const body = await response.json();
      if (response.ok && body.poc === "cpsat-deterministic-v1") return;
    } catch {
      // The local listener is not ready yet.
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(100);
  }
  throw new Error(`timed out waiting for wrangler dev\n${log.value}`);
}

function signalProcessGroup(server, signal) {
  if (server.pid === undefined) return;
  try {
    // Only the process group created by this benchmark, including workerd.
    process.kill(-server.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function stopServer(server) {
  signalProcessGroup(server, "SIGTERM");
  await delay(500);
  // A hung synchronous solve can outlive pnpm; terminate the owned group too.
  signalProcessGroup(server, "SIGKILL");
}

async function native(fixture, repeat) {
  const result = await command("uv", [
    "run",
    "--with",
    "ortools==9.15.6755",
    "python",
    resolve(pocDirectory, "native/reference.py"),
    "--case",
    fixture.case,
    "--repeat",
    String(repeat),
    "--deterministic-limit",
    String(fixture.budget),
  ]);
  return JSON.parse(result.stdout);
}

async function measureWorker(clockMode) {
  if (!remoteUrl) await assertPortAvailable();
  const log = { value: "", spawnError: false };
  const server = remoteUrl
    ? undefined
    : spawn(
        "pnpm",
        [
          "exec",
          "wrangler",
          "dev",
          "--config",
          config,
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--log-level",
          "warn",
          "--show-interactive-dev-session=false",
        ],
        { cwd: pocDirectory, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
  for (const stream of server ? [server.stdout, server.stderr] : []) {
    stream.on("data", (chunk) => {
      log.value = `${log.value}${chunk}`.slice(-20_000);
    });
  }
  server?.on("error", (error) => {
    log.spawnError = true;
    log.value += String(error);
  });
  const measured = { requests: [], rejectedInputs: [], authChecks: [] };
  report.worker[clockMode] = measured;
  async function run(fixtureName, repeat = 1) {
    const fixture = fixtures[fixtureName];
    const response = await workerRequest(
      `/run?case=${fixture.case}&repeat=${repeat}&deterministicLimit=${fixture.budget}&clock=${clockMode}`,
    );
    measured.requests.push({ fixture: fixtureName, ...response });
  }
  try {
    const startedAt = performance.now();
    if (server) await waitForServer(server, log);
    else await workerRequest("/health");
    measured.readyMs = performance.now() - startedAt;
    measured.authChecks.push(await workerRequest("/run?case=hard-search", 401, null));
    measured.authChecks.push(await workerRequest("/run?case=hard-search", 401, "0".repeat(64)));
    await run("small");
    await run("small", 25);
    await run("presolve");
    await run("searchLow");
    for (let index = 0; index < 20; ++index) {
      // Reuse across separate HTTP requests in the same isolate is intentional.
      // eslint-disable-next-line no-await-in-loop
      await run("search");
    }
    await run("searchHigh");
    await run("small", 25);
    for (const query of [
      "deterministicLimit=0",
      "deterministicLimit=-1",
      "deterministicLimit=NaN",
      "deterministicLimit=Infinity",
      "deterministicLimit=1.01",
      "deterministicLimit=",
      "repeat=51",
      "repeat=0",
      "repeat=1.5",
      "case=missing",
      "clock=missing",
      "timeLimitMs=50",
      "case=hard-search&repeat=5&deterministicLimit=0.05",
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await workerRequest(`/run?${query}`, 400);
      measured.rejectedInputs.push({ query, ...response });
    }
  } finally {
    if (server) await stopServer(server);
    measured.serverLog = log.value;
  }
}

function validSolution(sample) {
  if (sample.case === "small") {
    return (
      sample.status === "OPTIMAL" &&
      sample.objective === 5 &&
      sample.bestBound === 5 &&
      JSON.stringify(sample.solution) === "[2,1,0]"
    );
  }
  if (sample.status === "UNKNOWN") return sample.objective === null && sample.solution.length === 0;
  if (!["FEASIBLE", "OPTIMAL"].includes(sample.status) || sample.solution.length !== 500)
    return false;
  if (!sample.solution.every((value) => value === 0 || value === 1)) return false;
  if (sample.solution.reduce((sum, value) => sum + value, 0) !== sample.objective) return false;
  let random = 0x12345678;
  let constraints = 0;
  for (let left = 0; left < 500; ++left) {
    for (let right = left + 1; right < 500; ++right) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      if (random % 1000 >= 180) continue;
      constraints += 1;
      if (sample.solution[left] + sample.solution[right] > 1) return false;
    }
  }
  return constraints === sample.modelConstraints && sample.bestBound >= sample.objective;
}

function fixturePasses(sample, fixture) {
  const base =
    sample.case === fixture.case &&
    sample.wallTimeLimitEnabled === false &&
    sample.requestedDeterministicLimit === fixture.budget &&
    Number.isFinite(sample.deterministicTime) &&
    sample.deterministicTime >= 0 &&
    sample.deterministicTime <= fixture.maximumConsumed &&
    validSolution(sample);
  if (fixture.case === "small") return base;
  const cutOff =
    sample.deterministicTime >= fixture.budget &&
    sample.modelVariables === 500 &&
    sample.modelConstraints === 22495;
  if (fixture.case === "hard") return base && cutOff && sample.status === "UNKNOWN";
  return (
    base &&
    cutOff &&
    sample.status === "FEASIBLE" &&
    sample.branches > 0 &&
    sample.bestBound > sample.objective
  );
}

function solverSignature(sample) {
  return JSON.stringify([
    sample.case,
    sample.status,
    sample.objective,
    sample.bestBound,
    sample.solution,
    sample.deterministicTime,
    sample.branches,
    sample.conflicts,
  ]);
}

function buildChecks() {
  const checks = {};
  for (const [name, samples] of Object.entries(report.native)) {
    checks[`native_${name}`] = samples.every((sample) => fixturePasses(sample, fixtures[name]));
  }
  for (const [clockMode, measured] of Object.entries(report.worker)) {
    const samples = measured.requests.flatMap((request) => request.body.samples);
    checks[`${clockMode}_fixtures`] = measured.requests.every((request) =>
      request.body.samples.every((sample) => fixturePasses(sample, fixtures[request.fixture])),
    );
    checks[`${clockMode}_continuousRuns`] =
      samples.length === 74 && measured.requests.length === 26;
    measured.runtimeReused = measured.requests.every(
      (request, index) => request.body.runtime.initializedNow === (index === 0),
    );
    measured.isolateIds = [...new Set(measured.requests.map((r) => r.body.runtime.isolateId))];
    if (!remoteUrl) checks[`${clockMode}_runtimeReused`] = measured.runtimeReused;
    checks[`${clockMode}_rejectsUnauthorized`] = measured.authChecks.length === 2;
    checks[`${clockMode}_requestCorrelation`] = measured.requests.every(
      (r) => r.requestId === r.body.requestId,
    );
    checks[`${clockMode}_singleThread`] =
      samples.every((sample) => !sample.sharedWasmMemory) &&
      measured.requests.every((request) => request.body.runtime.searchWorkers === 1);
    checks[`${clockMode}_stableMemoryCapacity`] =
      new Set(samples.map((s) => s.wasmMemoryBytes)).size === 1;
    checks[`${clockMode}_memoryCapacityWithinLimit`] = samples.every(
      (s) => s.wasmMemoryBytes <= 96 * 1024 * 1024,
    );
    checks[`${clockMode}_rejectsInvalidInput`] = measured.rejectedInputs.length === 13;
    checks[`${clockMode}_clockInstrumentation`] = samples.every(
      (sample) =>
        sample.clockMode === clockMode &&
        (clockMode === "frozen"
          ? sample.frozenClockReads > 0 && sample.solverWallTimeMs === 0
          : sample.frozenClockReads === 0),
    );
    checks[`${clockMode}_searchRepeatability`] =
      new Set(
        measured.requests
          .filter((request) => request.fixture === "search")
          .flatMap((request) => request.body.samples.map(solverSignature)),
      ).size === 1;
    const low = measured.requests.find((request) => request.fixture === "searchLow").body
      .samples[0];
    const high = measured.requests.find((request) => request.fixture === "searchHigh").body
      .samples[0];
    checks[`${clockMode}_largerBudgetDoesMoreWork`] =
      high.branches > low.branches &&
      high.conflicts > low.conflicts &&
      high.deterministicTime > low.deterministicTime;
  }
  // Cross-build exact search equality is recorded, not assumed as a requirement.
  report.comparisons = Object.fromEntries(
    Object.keys(fixtures).map((name) => {
      const hostSamples = report.worker.host.requests
        .filter((r) => r.fixture === name)
        .flatMap((r) => r.body.samples);
      const frozenSamples = report.worker.frozen.requests
        .filter((r) => r.fixture === name)
        .flatMap((r) => r.body.samples);
      const expectedSignature = solverSignature(hostSamples[0]);
      return [
        name,
        {
          hostAndFrozenExact: [...hostSamples, ...frozenSamples].every(
            (sample) => solverSignature(sample) === expectedSignature,
          ),
          nativeAndWasmExact: report.native[name].every(
            (sample) => solverSignature(sample) === expectedSignature,
          ),
        },
      ];
    }),
  );
  checks.hostAndFrozenExact = Object.values(report.comparisons).every(
    (value) => value.hostAndFrozenExact,
  );
  return checks;
}

try {
  if (process.platform === "win32")
    throw new Error("Benchmark process-group cleanup requires Unix");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid CPSAT_POC_PORT");
  const [wasmStat, glueStat, sums, inspection, wranglerVersion] = await Promise.all([
    stat(resolve(pocDirectory, "vendor/cpsat_workers_poc_runtime.wasm")),
    stat(resolve(pocDirectory, "vendor/cpsat_workers_poc_runtime.js")),
    readFile(resolve(pocDirectory, "vendor/SHA256SUMS"), "utf8"),
    command("node", [resolve(scriptDirectory, "inspect-wasm.mjs")]),
    command("pnpm", ["exec", "wrangler", "--version"]),
  ]);
  report.toolchain.wrangler = wranglerVersion.stdout;
  const verification = await command("shasum", ["-a", "256", "-c", "SHA256SUMS"], {
    cwd: resolve(pocDirectory, "vendor"),
  });
  report.artifacts = {
    wasmBytes: wasmStat.size,
    glueBytes: glueStat.size,
    sha256: sums.trim().split("\n"),
    inspection: JSON.parse(inspection.stdout),
    checksumVerification: verification.stdout,
  };
  const baselines = await Promise.all(
    Object.entries(fixtures).map(async ([name, fixture]) => [
      name,
      await native(fixture, name === "small" ? 5 : 3),
    ]),
  );
  report.native = Object.fromEntries(baselines);
  await measureWorker("host");
  await measureWorker("frozen");
  report.checks = buildChecks();
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.passed = false;
  report.failure = { name: error.name, message: error.message, stack: error.stack };
} finally {
  report.completedAt = new Date().toISOString();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { outputPath, passed: report.passed, checks: report.checks, failure: report.failure },
      null,
      2,
    ),
  );
}
if (!report.passed) process.exitCode = 1;
