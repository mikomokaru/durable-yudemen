"""Local-only SMAC driver. TS owns facts, business model, replay and scoring."""
import argparse
import hashlib
import importlib.metadata
import json
import os
import pathlib
import select
import signal
import subprocess
import time

from ConfigSpace import ConfigurationSpace, Integer
from smac import HyperparameterOptimizationFacade, Scenario

from native_bridge import solve as native_solve
from wasm_transport import WasmTransport


class BudgetExpired(BaseException):
    """Escape SMAC's trial-error handler while preserving completed results."""


class FatalReplay(BaseException):
    """An invalid replay is an experiment failure, not a poor parameter candidate."""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--trials", type=int, default=12)
    parser.add_argument("--seed", type=int, default=20260909)
    parser.add_argument("--stores", help="Comma-separated history IDs; default: manifest exploration split")
    parser.add_argument("--holdout", help="Comma-separated history IDs; default: manifest validation split; empty disables")
    parser.add_argument("--corpus", default="docs/data_samples/noodle_plan_histories")
    parser.add_argument("--runtime", choices=("wasm", "native"), default="wasm")
    parser.add_argument("--port", type=int, default=8792)
    parser.add_argument("--max-seconds", type=int, default=3600, help="Whole experiment budget; checked between solver calls (up to 45s grace)")
    parser.add_argument("--capture", type=int, default=3)
    parser.add_argument("--baseline-only", action="store_true")
    args = parser.parse_args()
    assert 1 <= args.trials <= 1000
    assert 0 <= args.capture <= 1000
    assert 1 <= args.max_seconds <= 86400
    output = pathlib.Path(args.output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    os.umask(0o077)
    process = subprocess.Popen(
        ["pnpm", "exec", "vite-node", "--config", "tools/preflight.vite.config.ts", "experiments/cpsat-workers/tuning/cli.ts", args.corpus],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1, start_new_session=True,
    )
    captures = []
    evaluations = []
    started = time.monotonic()
    wasm = None
    cache = {}
    baseline = None
    best = None
    selected_score = None
    baseline_holdout = None
    selected_holdout = None

    def check_budget():
        if time.monotonic() - started >= args.max_seconds:
            raise BudgetExpired("Experiment time budget reached")

    def read():
        if not select.select([process.stdout], [], [], 60)[0]:
            raise TimeoutError("TS replay produced no protocol message for 60 seconds")
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(f"TS replay exited: {process.poll()}")
        return json.loads(line)

    def send(value):
        process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
        process.stdin.flush()

    def save(name, value):
        temporary = output / f".{name}.tmp"
        temporary.write_text(json.dumps(value, indent=2) + "\n")
        temporary.replace(output / name)

    def summary(status):
        save("summary.json", {
            "status": status, "searchRuntime": args.runtime,
            "baselineTrainScore": baseline, "selectedTrainScore": selected_score,
            "baselineHoldoutScore": baseline_holdout, "selectedHoldoutScore": selected_holdout,
            "selectedPreferences": best, "baselinePreferences": defaults,
            "evaluatedConfigurations": len(evaluations), "replays": len(cache),
            "totalSolves": sum(r["solveCount"] for r in cache.values()),
            "totalFallbacks": sum(r["fallbackCount"] for r in cache.values()),
            "elapsedSeconds": time.monotonic() - started,
        })

    def stop_group(signum):
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass

    try:
        ready = read()
        assert ready["kind"] == "ready"
        train = args.stores.split(",") if args.stores else [s["id"] for s in ready["stores"] if s["split"] == "exploration"]
        holdout = args.holdout.split(",") if args.holdout else []
        if args.holdout is None:
            holdout = [s["id"] for s in ready["stores"] if s["split"] == "validation"]
        assert train and len(set(train)) == len(train) and len(set(holdout)) == len(holdout) and not set(train) & set(holdout)
        assert set(train + holdout) <= {s["id"] for s in ready["stores"]}
        # Explicit subsets must not silently turn a held-out store into training data.
        if ready["manifestSha256"]:
            assert all(s["split"] == "exploration" for s in ready["stores"] if s["id"] in train)
            assert all(s["split"] == "validation" for s in ready["stores"] if s["id"] in holdout)
        defaults = ready["defaults"]
        wasm = WasmTransport(args.port) if args.runtime == "wasm" else None
        solve = wasm.solve if wasm else native_solve
        manifest = {
            "seed": args.seed, "trials": args.trials, "trainStores": train, "holdoutStores": holdout,
            "corpus": ready, "nativeOnlySearch": wasm is None, "cloudDeployment": False,
            "searchRuntime": args.runtime, "transport": wasm.ready if wasm else None,
            "maxSeconds": args.max_seconds, "defaultIncludedInSmac": True,
            "versions": {name: importlib.metadata.version(name) for name in ("smac", "ConfigSpace", "ortools", "numpy", "scikit-learn")},
            "sourceSha256": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in pathlib.Path("experiments/cpsat-workers/tuning").glob("*") if path.suffix in (".ts", ".py", ".json", ".lock", ".mjs")},
        }
        save("manifest.json", manifest)

        def replay(preferences, store):
            key = json.dumps([preferences, store], sort_keys=True)
            if key in cache:
                return cache[key]
            check_budget()
            requests = []
            send({"kind": "replay", "store": store, "preferences": preferences})
            while True:
                message = read()
                if message["kind"] == "solve":
                    check_budget()
                    capture = len(captures) < args.capture
                    replacement = None
                    if not capture and args.capture >= 2:
                        # Retain the first (small) model and the largest later models.
                        replacement = min(range(1, len(captures)), key=lambda i: len(captures[i]["model"]["variables"]))
                        capture = len(message["model"]["variables"]) > len(captures[replacement]["model"]["variables"])
                    result = solve(message["model"], capture)
                    if wasm:
                        requests.append({k: result[k] for k in ("clientElapsedMs", "wasmMemoryBytes", "isolateId", "validated")})
                    if len(requests) and len(requests) % 50 == 0:
                        print(json.dumps({"history": store, "wasmSolves": len(requests), "elapsedSeconds": round(time.monotonic() - started, 2)}), flush=True)
                    if capture:
                        entry = {"model": message["model"], "wasm" if wasm else "native": result, "store": store}
                        if replacement is None:
                            captures.append(entry)
                        else:
                            captures[replacement] = entry
                        save("captures.json", captures)
                    send(result)
                elif message["kind"] == "result":
                    result = message["result"]
                    if wasm:
                        assert len(requests) == result["solveCount"]
                        latencies = sorted(r["clientElapsedMs"] for r in requests)
                        result["wasm"] = {"solves": len(requests), "validatedSolutions": sum(r["validated"] for r in requests),
                            "minMemoryBytes": min(r["wasmMemoryBytes"] for r in requests), "maxMemoryBytes": max(r["wasmMemoryBytes"] for r in requests),
                            "isolateCount": len({r["isolateId"] for r in requests}), "firstRequestMs": requests[0]["clientElapsedMs"],
                            "minRequestMs": latencies[0], "maxRequestMs": latencies[-1], "meanRequestMs": sum(latencies) / len(latencies),
                            "p95RequestMs": latencies[max(0, (95 * len(latencies) + 99) // 100 - 1)]}
                    cache[key] = result
                    save(f"replay-{len(cache):04d}.json", {"preferences": preferences, "result": result})
                    print(json.dumps({"store": store, "score": result["fixedScore"], "wait": result["features"]["waitSeconds"], "solves": result["solveCount"], "fallbacks": result["fallbackCount"], "elapsedSeconds": round(time.monotonic() - started, 2)}), flush=True)
                    return result
                else:
                    raise RuntimeError(message)

        def evaluate(preferences, stores):
            results = [replay(preferences, store) for store in stores]
            # Infrastructure/solver failures cannot win by falling back to a different planner.
            if any(r["fallbackCount"] for r in results):
                return 1e12 + sum(r["fallbackCount"] for r in results) * 1e6
            return sum(r["fixedScore"] for r in results)

        baseline = evaluate(defaults, train)
        print(json.dumps({"baselineTrainScore": baseline}), flush=True)
        best = dict(defaults)
        selected_score = baseline
        summary("baseline-complete")
        if not args.baseline_only:
            bounds = {
                "liftOverflowCost": (20, 200), "severeLiftOverflowCost": (600, 2400),
                "clusterCost": (5, 120), "gapShortfallWeight": (0, 8),
                "simultaneousDistanceWeight": (0, 8), "multiSlotDistanceWeight": (20, 200),
                "peripheralWeight": (0, 4), "centralWeight": (0, 4),
                "purchaseInversionCost": (0, 120), "orderFragmentCost": (0, 120),
                "orderDistanceWeight": (0, 8), "slotChangeCost": (0, 120),
            }
            space = ConfigurationSpace(seed=args.seed)
            space.add([Integer(name, bounds=limits, default=defaults[name]) for name, limits in bounds.items()])

            def target(config, seed=0):
                preferences = {name: int(value) for name, value in dict(config).items()}
                try:
                    score = evaluate(preferences, train)
                except Exception as error:
                    raise FatalReplay(str(error)) from error
                evaluations.append({"preferences": preferences, "score": score})
                save("evaluations.json", evaluations)
                print(json.dumps({"trial": len(evaluations), "score": score}), flush=True)
                return score

            scenario = Scenario(space, deterministic=True, n_trials=args.trials, seed=args.seed, output_directory=output / "smac")
            initial = HyperparameterOptimizationFacade.get_initial_design(scenario, n_configs=min(4, args.trials - 1), max_ratio=1.0,
                additional_configs=[space.get_default_configuration()])
            optimizer = HyperparameterOptimizationFacade(scenario, target, initial_design=initial, overwrite=False)
            incumbent = optimizer.optimize()
            proposed = {name: int(value) for name, value in dict(incumbent).items()}
            if evaluate(proposed, train) < baseline:
                best = proposed
        selected_score = evaluate(best, train)
        baseline_holdout = evaluate(defaults, holdout) if holdout else None
        selected_holdout = evaluate(best, holdout) if holdout else None
        summary("complete")
    except BudgetExpired:
        # Only complete train-set evaluations may become the provisional incumbent.
        if baseline is not None:
            completed = [e for e in evaluations if e["score"] < baseline]
            if completed:
                winner = min(completed, key=lambda e: e["score"])
                best, selected_score = winner["preferences"], winner["score"]
        summary("time-budget-reached; validation-may-be-incomplete")
        print(json.dumps({"stopped": "time budget", "completeReplays": len(cache)}), flush=True)
    except BaseException as error:
        save("failure.json", {"type": type(error).__name__, "error": str(error), "elapsedSeconds": time.monotonic() - started})
        raise
    finally:
        if wasm:
            wasm.close()
        if process.poll() is None:
            try:
                send({"kind": "stop"})
                process.wait(timeout=5)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                stop_group(signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    stop_group(signal.SIGKILL)
                    process.wait(timeout=5)
        # A wrapper exiting does not prove that its child exited. This is the
        # process group created exclusively for this run, never a shared group.
        stop_group(signal.SIGKILL)


if __name__ == "__main__":
    main()
