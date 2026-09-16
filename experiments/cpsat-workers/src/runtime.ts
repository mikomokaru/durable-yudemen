import createCpsatPocRuntime, {
  type CpsatPocRuntime,
} from "../vendor/cpsat_workers_poc_runtime.js";
import cpsatModule from "../vendor/cpsat_workers_poc_runtime.wasm";

export type CaseName = "small" | "hard" | "hard-search" | "model";
export type ClockMode = "host" | "frozen";

export interface SolverResult {
  readonly case: CaseName;
  readonly status: "UNKNOWN" | "MODEL_INVALID" | "FEASIBLE" | "INFEASIBLE" | "OPTIMAL";
  readonly objective: number | null;
  readonly bestBound: number;
  readonly solution: readonly number[];
  readonly modelVariables: number;
  readonly modelConstraints: number;
  readonly requestedDeterministicLimit: number;
  readonly wallTimeLimitEnabled: false;
  readonly solverWallTimeMs: number;
  readonly deterministicTime: number;
  readonly conflicts: number;
  readonly branches: number;
  readonly booleans: number;
}

export interface MeasuredResult extends SolverResult {
  readonly hostElapsedMs: number;
  readonly wasmMemoryBytes: number;
  readonly sharedWasmMemory: boolean;
  readonly clockMode: ClockMode;
  readonly frozenClockReads: number;
}

interface LoadedRuntime {
  readonly wasm: CpsatPocRuntime;
  readonly clockMode: ClockMode;
  readonly clockReads: () => number;
}

// These cache module instances, not user models. The benchmark starts a fresh
// workerd for each mode so its memory samples cover one Wasm instance only.
const loadedRuntimes = new Map<ClockMode, Promise<LoadedRuntime>>();

async function createRuntime(clockMode: ClockMode): Promise<LoadedRuntime> {
  let clockReads = 0;
  const wasm = await createCpsatPocRuntime({
    instantiateWasm(imports, receiveInstance) {
      let memory: WebAssembly.Memory | undefined;
      if (clockMode === "frozen") {
        const clockImports = WebAssembly.Module.imports(cpsatModule)
          .filter((entry) => /clock|time|date|now/i.test(entry.name))
          .map((entry) => `${entry.module}.${entry.name}`)
          .sort();
        const expected = ["env.emscripten_get_now", "wasi_snapshot_preview1.clock_time_get"];
        if (JSON.stringify(clockImports) !== JSON.stringify(expected)) {
          throw new Error(`Clock import surface changed: ${JSON.stringify(clockImports)}`);
        }
        const env = imports.env;
        const wasi = imports.wasi_snapshot_preview1;
        if (env === undefined || wasi === undefined) throw new Error("Missing clock imports");
        env.emscripten_get_now = () => {
          clockReads += 1;
          return 1_000;
        };
        wasi.clock_time_get = (clockId: number, _precision: bigint, pointer: number) => {
          if (clockId < 0 || clockId > 3) return 28; // WASI EINVAL.
          if (memory === undefined) throw new Error("Clock read before memory was exported");
          clockReads += 1;
          // Freeze both realtime and monotonic clocks, including during ctors.
          const nanoseconds = clockId === 0 ? 1_700_000_000_000_000_000n : 1_000_000_000n;
          new DataView(memory.buffer).setBigUint64(pointer, nanoseconds, true);
          return 0;
        };
      }
      const instance = new WebAssembly.Instance(cpsatModule, imports);
      if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
        throw new Error("Missing Wasm memory export");
      }
      memory = instance.exports.memory;
      receiveInstance(instance, cpsatModule);
      return instance.exports;
    },
  });
  return { wasm, clockMode, clockReads: () => clockReads };
}

export async function runtime(clockMode: ClockMode): Promise<{
  readonly value: LoadedRuntime;
  readonly initializedNow: boolean;
  readonly initializationMs: number;
}> {
  const initializedNow = !loadedRuntimes.has(clockMode);
  const startedAt = performance.now();
  let loadedRuntime = loadedRuntimes.get(clockMode);
  if (loadedRuntime === undefined) {
    loadedRuntime = createRuntime(clockMode).catch((error: unknown) => {
      loadedRuntimes.delete(clockMode);
      throw error;
    });
    loadedRuntimes.set(clockMode, loadedRuntime);
  }
  const value = await loadedRuntime;
  return {
    value,
    initializedNow,
    initializationMs: performance.now() - startedAt,
  };
}

export function solve(
  loaded: LoadedRuntime,
  caseName: CaseName,
  deterministicLimit: number,
  modelBytes?: Uint8Array,
): MeasuredResult {
  const { wasm } = loaded;
  const startedAt = performance.now();
  const clockReadsBefore = loaded.clockReads();
  const caseId = { small: 0, hard: 1, "hard-search": 2, model: 3 }[caseName];
  // Emscripten's C exports intentionally use their generated leading underscore.
  // eslint-disable-next-line no-underscore-dangle
  let modelPointer = 0;
  let resultPointer: number;
  try {
    if (modelBytes !== undefined) {
      modelPointer = wasm._malloc(modelBytes.byteLength);
      if (modelPointer === 0) throw new Error("Model allocation failed");
      wasm.HEAPU8.set(modelBytes, modelPointer);
    }
    resultPointer = wasm._cpsat_solve(
      caseId,
      deterministicLimit,
      modelPointer,
      modelBytes?.byteLength ?? 0,
    );
  } finally {
    if (modelPointer !== 0) wasm._free(modelPointer);
  }
  if (resultPointer === 0) throw new Error("CP-SAT returned a null result pointer");

  let result: SolverResult;
  try {
    result = JSON.parse(wasm.UTF8ToString(resultPointer)) as SolverResult;
    if (!("status" in result)) throw new Error(`CP-SAT error: ${JSON.stringify(result)}`);
  } finally {
    // eslint-disable-next-line no-underscore-dangle
    wasm._free(resultPointer);
  }

  const buffer = wasm.HEAPU8.buffer;
  return {
    ...result,
    hostElapsedMs: performance.now() - startedAt,
    wasmMemoryBytes: buffer.byteLength,
    sharedWasmMemory:
      typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer,
    clockMode: loaded.clockMode,
    frozenClockReads: loaded.clockReads() - clockReadsBefore,
  };
}
