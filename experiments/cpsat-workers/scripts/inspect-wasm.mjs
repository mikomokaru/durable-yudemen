import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pocDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bytes = await readFile(resolve(pocDirectory, "vendor/cpsat_workers_poc_runtime.wasm"));
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
const exports = WebAssembly.Module.exports(module);
const sharedMemoryImports = imports.filter((entry) => entry.kind === "memory");
const exportNames = new Set(exports.map((entry) => entry.name));

const report = {
  byteLength: bytes.byteLength,
  imports,
  exports,
  importedMemoryCount: sharedMemoryImports.length,
  importsPthreadRuntime: imports.some((entry) => /pthread|wasi_thread_spawn/i.test(entry.name)),
  exportsSolver: exportNames.has("cpsat_solve"),
  exportsMemory: exportNames.has("memory"),
};

console.log(JSON.stringify(report, null, 2));
if (
  report.importsPthreadRuntime ||
  report.importedMemoryCount !== 0 ||
  !report.exportsSolver ||
  !report.exportsMemory
) {
  process.exitCode = 1;
}
