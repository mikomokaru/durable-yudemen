export interface CpsatPocRuntime {
  readonly HEAPU8: Uint8Array;
  readonly _cpsat_solve: (
    caseId: number,
    deterministicLimit: number,
    modelPointer: number,
    modelSize: number,
  ) => number;
  readonly _malloc: (size: number) => number;
  readonly _free: (pointer: number) => void;
  readonly UTF8ToString: (pointer: number) => string;
}

export interface CpsatPocModuleOptions {
  readonly instantiateWasm: (
    imports: WebAssembly.Imports,
    receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => WebAssembly.Exports;
}

export default function createCpsatPocRuntime(
  options: CpsatPocModuleOptions,
): Promise<CpsatPocRuntime>;
