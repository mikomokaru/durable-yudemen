#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
poc_dir="$(cd "${script_dir}/.." && pwd)"
source_dir="${CPSAT_WASM_SOURCE_DIR:-${TMPDIR:-/tmp}/cpsat-workers-or-tools-wasm}"
build_dir="${CPSAT_WASM_BUILD_DIR:-${source_dir}/build-cf-single}"
source_revision="e1453348bc43d3b0afc0c2e5a535f5c9b45326f4"
emscripten_version="4.0.20"

if [[ ! -d "${source_dir}/.git" ]]; then
  git clone https://github.com/Axelwickm/or-tools-wasm.git "${source_dir}"
fi

git -C "${source_dir}" fetch origin "${source_revision}"
if [[ "$(git -C "${source_dir}" rev-parse HEAD)" != "${source_revision}" ]]; then
  if [[ -n "$(git -C "${source_dir}" status --short)" ]]; then
    echo "Refusing to change revision in a modified source tree: ${source_dir}" >&2
    exit 1
  fi
  git -C "${source_dir}" checkout --detach "${source_revision}"
fi
if git -C "${source_dir}" apply --check \
  "${poc_dir}/patches/or-tools-wasm-single-thread.patch" 2>/dev/null; then
  git -C "${source_dir}" apply "${poc_dir}/patches/or-tools-wasm-single-thread.patch"
elif ! git -C "${source_dir}" apply --reverse --check \
  "${poc_dir}/patches/or-tools-wasm-single-thread.patch"; then
  echo "The pinned source is neither clean nor patched as expected: ${source_dir}" >&2
  exit 1
fi
cp "${poc_dir}/cpp/cpsat_workers_poc.cc" "${source_dir}/javascript/cpsat_workers_poc.cc"

git -C "${source_dir}" submodule update --init --depth 1 emsdk
"${source_dir}/emsdk/emsdk" install "${emscripten_version}"
"${source_dir}/emsdk/emsdk" activate "${emscripten_version}"

# shellcheck disable=SC1091
source "${source_dir}/emsdk/emsdk_env.sh"

cmake -S "${source_dir}" -B "${build_dir}" \
  -G "Unix Makefiles" \
  -DCMAKE_TOOLCHAIN_FILE="${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DEMSCRIPTEN_USE_PTHREADS=OFF \
  -DORTOOLS_WASM_USE_CLP=OFF \
  -DORTOOLS_WASM_USE_CBC=OFF \
  -DORTOOLS_WASM_USE_KNAPSACK=OFF \
  -DORTOOLS_WASM_USE_BOP=OFF \
  -DORTOOLS_WASM_USE_GLPK=OFF \
  -DORTOOLS_WASM_USE_SCIP=OFF \
  -DUSE_PDLP=OFF \
  -DBUILD_DEPS=ON \
  -DBUILD_TESTING=OFF \
  -DBUILD_SAMPLES=OFF \
  -DBUILD_EXAMPLES=OFF

cmake --build "${build_dir}" \
  --target cpsat_workers_poc_runtime \
  --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"

mkdir -p "${poc_dir}/vendor"
cp "${build_dir}/javascript/wasm/cpsat_workers_poc_runtime.js" \
  "${poc_dir}/vendor/cpsat_workers_poc_runtime.js"
cp "${build_dir}/javascript/wasm/cpsat_workers_poc_runtime.wasm" \
  "${poc_dir}/vendor/cpsat_workers_poc_runtime.wasm"

(
  cd "${poc_dir}/vendor"
  shasum -a 256 \
    cpsat_workers_poc_runtime.js \
    cpsat_workers_poc_runtime.wasm \
    > SHA256SUMS
)
