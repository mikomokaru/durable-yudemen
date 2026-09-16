"""Bounded SMAC search: candidates sequential, independent histories parallel.

Only numeric protobuf models cross the network; TS replay, SMAC, scoring and
protobuf encoding stay local. Every HTTP solve pins the deployed WASM/version.
An interrupted candidate is never compared with a fully evaluated candidate.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import importlib.metadata
import json
import math
import os
import pathlib
import threading
import time
from datetime import datetime, timezone

from ConfigSpace import ConfigurationSpace, Integer
from smac import HyperparameterOptimizationFacade, Scenario
from cloud_transport import replay_process, solver_process, cloud_solve


class BudgetExpired(BaseException):
    """Do not let SMAC convert an incomplete evaluation into a scored trial."""


class FatalReplay(BaseException):
    """Infrastructure/model faults abort the run, never trigger native fallback."""


class Budget:
    def __init__(self, seconds, requests, reserve_seconds, reserve_requests):
        self.started = time.monotonic()
        self.hard_deadline = self.started + seconds
        self.deadline = self.hard_deadline - reserve_seconds
        self.maximum = requests
        self.limit = requests - reserve_requests
        self.attempts = 0
        self.cancel = threading.Event()
        self.lock = threading.Lock()

    def check(self):
        if self.cancel.is_set() or time.monotonic() >= self.deadline or self.attempts >= self.limit:
            raise BudgetExpired("Time/request budget reached or sibling evaluation stopped")

    def reserve(self):
        with self.lock:
            self.check()
            self.attempts += 1
            return self.attempts

    def validation(self):
        self.cancel.clear()
        self.deadline = self.hard_deadline
        self.limit = self.maximum


BOUNDS = {
    "liftOverflowCost": (20, 200), "severeLiftOverflowCost": (600, 2400),
    "clusterCost": (5, 120), "gapShortfallWeight": (0, 8),
    "simultaneousDistanceWeight": (0, 8), "multiSlotDistanceWeight": (20, 200),
    "peripheralWeight": (0, 4), "centralWeight": (0, 4),
    "purchaseInversionCost": (0, 120), "orderFragmentCost": (0, 120),
    "orderDistanceWeight": (0, 8), "slotChangeCost": (0, 120),
}


def utc():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--corpus", default="docs/data_samples/noodle_plan_histories")
    parser.add_argument("--parallel", type=int, default=4)
    parser.add_argument("--trials", type=int, default=12)
    parser.add_argument("--seed", type=int, default=20260909)
    parser.add_argument("--max-seconds", type=int, default=3600)
    parser.add_argument("--max-requests", type=int, default=50000)
    parser.add_argument("--validation-seconds", type=int, default=600)
    parser.add_argument("--validation-requests", type=int, default=12000)
    args = parser.parse_args()
    assert 1 <= args.parallel <= 4 and 1 <= args.trials <= 12
    assert 1 <= args.max_seconds <= 3600 and 1 <= args.max_requests <= 50000
    assert 0 <= args.validation_seconds < args.max_seconds
    assert 0 <= args.validation_requests < args.max_requests
    os.umask(0o077)
    output = pathlib.Path(args.output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    lock = threading.Lock()
    cache = {}
    evaluations = []
    baseline = None
    selected = None
    selected_score = None
    baseline_holdout = None
    selected_holdout = None
    defaults = None
    training_stop = None
    started_at = utc()
    budget = Budget(args.max_seconds, args.max_requests, args.validation_seconds, args.validation_requests)

    def save(name, value):
        temporary = output / f".{name}.tmp"
        temporary.write_text(json.dumps(value, indent=2) + "\n")
        temporary.replace(output / name)

    def journal(value):
        with lock:
            with (output / "requests.jsonl").open("a") as stream:
                stream.write(json.dumps(value, separators=(",", ":")) + "\n")

    def summary(status):
        save("summary.json", {
            "status": status, "searchRuntime": "wasm-cloud", "startedAt": started_at,
            "updatedAt": utc(), "elapsedSeconds": time.monotonic() - budget.started,
            "parallelHistories": args.parallel, "attemptedSolves": budget.attempts,
            "completedReplays": len(cache), "completedReplaySolves": sum(r["solveCount"] for r in cache.values()),
            "totalFallbacks": sum(r["fallbackCount"] for r in cache.values()),
            "evaluatedConfigurations": len(evaluations), "trainingStop": training_stop,
            "baselinePreferences": defaults, "selectedPreferences": selected,
            "baselineTrainScore": baseline, "selectedTrainScore": selected_score,
            "baselineHoldoutScore": baseline_holdout, "selectedHoldoutScore": selected_holdout,
        })

    try:
        with replay_process(args.corpus) as replay:
            ready = replay.ready
        with solver_process() as solver:
            transport = solver.ready
        assert transport["runtime"] == "wasm-cloud"
        assert ready["inputVersion"] == "smac-replay-cohort-v2"
        defaults = ready["defaults"]
        train = [h["id"] for h in ready["stores"] if h["split"] == "exploration"]
        holdout = [h["id"] for h in ready["stores"] if h["split"] == "validation"]
        assert train and holdout and not set(train) & set(holdout)
        sources = pathlib.Path("experiments/cpsat-workers")
        save("manifest.json", {
            "startedAt": started_at, "args": vars(args), "corpus": ready,
            "trainHistories": train, "holdoutHistories": holdout, "transport": transport,
            "nativeSolverUsed": False, "automaticRetries": False,
            "parallelUnit": "independent history within one configuration",
            "scoreAggregation": "sum of unchanged TS fixedScore; fallback disqualifies",
            "initialDesign": "default plus two Sobol configurations, then SMAC",
            "bounds": BOUNDS,
            "versions": {name: importlib.metadata.version(name) for name in ("smac", "ConfigSpace", "ortools", "numpy", "scikit-learn")},
            "sourceSha256": {str(p.relative_to(sources)): hashlib.sha256(p.read_bytes()).hexdigest()
                for folder in ("tuning", "search-worker", "src") for p in (sources / folder).glob("*")
                if p.suffix in (".ts", ".py", ".json", ".jsonc", ".mjs", ".lock")},
        })
        summary("starting")

        def replay_one(preferences, history):
            key = json.dumps([preferences, history], sort_keys=True)
            with lock:
                if key in cache:
                    return cache[key]
            budget.check()
            metrics = []
            with replay_process(args.corpus) as client, solver_process(transport["versionId"]) as remote:
                assert client.ready == ready, "Input/configuration changed during search"
                client.send({"kind": "replay", "store": history, "preferences": preferences})
                while True:
                    message = client.read()
                    if message["kind"] == "solve":
                        number = budget.reserve()
                        journal({"kind": "attempt", "number": number, "history": history, "at": utc()})
                        try:
                            result = cloud_solve(remote, message["model"])
                        except BaseException as error:
                            journal({"kind": "error", "number": number, "error": str(error), "at": utc()})
                            raise
                        row = {k: result[k] for k in ("status", "clientElapsedMs", "wasmMemoryBytes", "isolateId", "validated", "requestId", "cfRay", "deterministicTime", "modelVariables")}
                        metrics.append(row)
                        journal({"kind": "result", "number": number, **row})
                        client.send(result)
                    elif message["kind"] == "result":
                        result = message["result"]
                        assert len(metrics) == result["solveCount"] and metrics
                        assert math.isfinite(result["fixedScore"])
                        latencies = sorted(r["clientElapsedMs"] for r in metrics)
                        result["cloud"] = {
                            "solves": len(metrics), "validatedSolutions": sum(r["validated"] for r in metrics),
                            "statusCounts": dict(Counter(r["status"] for r in metrics)),
                            "maxMemoryBytes": max(r["wasmMemoryBytes"] for r in metrics),
                            "isolateCount": len({r["isolateId"] for r in metrics}),
                            "meanRequestMs": sum(latencies) / len(latencies),
                            "p95RequestMs": latencies[math.ceil(len(latencies) * .95) - 1],
                            "maxRequestMs": latencies[-1],
                        }
                        with lock:
                            cache[key] = result
                            save(f"replay-{len(cache):04d}.json", {"history": history, "preferences": preferences, "result": result})
                            print(json.dumps({"history": history, "score": result["fixedScore"], "solves": result["solveCount"], "fallbacks": result["fallbackCount"], "attempts": budget.attempts, "elapsedSeconds": round(time.monotonic() - budget.started, 1)}), flush=True)
                        return result
                    else:
                        raise RuntimeError("Unexpected TS protocol message")

        def evaluate(preferences, histories):
            results = {}
            errors = []
            with ThreadPoolExecutor(max_workers=args.parallel) as pool:
                futures = {pool.submit(replay_one, preferences, history): history for history in histories}
                for future in as_completed(futures):
                    try:
                        results[futures[future]] = future.result()
                    except BaseException as error:
                        budget.cancel.set()
                        errors.append(error)
            # Never hide a real solver fault behind a sibling's cancellation.
            fatal = [e for e in errors if not isinstance(e, BudgetExpired)]
            if fatal:
                raise FatalReplay(str(fatal[0])) from fatal[0]
            if errors:
                raise BudgetExpired(str(errors[0]))
            ordered = [results[h] for h in histories]
            fallbacks = sum(r["fallbackCount"] for r in ordered)
            return 1e12 + fallbacks * 1e6 if fallbacks else sum(r["fixedScore"] for r in ordered)

        try:
            baseline = evaluate(defaults, train)
            selected, selected_score = dict(defaults), baseline
            summary("baseline-complete")
            space = ConfigurationSpace(seed=args.seed)
            space.add([Integer(name, bounds=bounds, default=defaults[name]) for name, bounds in BOUNDS.items()])

            def target(config, seed=0):
                nonlocal selected, selected_score
                preferences = {name: int(value) for name, value in dict(config).items()}
                try:
                    score = evaluate(preferences, train)
                except Exception as error:
                    raise FatalReplay(str(error)) from error
                evaluations.append({"preferences": preferences, "score": score, "at": utc()})
                if score < selected_score:
                    selected, selected_score = preferences, score
                save("evaluations.json", evaluations)
                summary("searching")
                print(json.dumps({"trial": len(evaluations), "score": score, "selectedTrainScore": selected_score}), flush=True)
                return score

            scenario = Scenario(space, deterministic=True, n_trials=args.trials, seed=args.seed, output_directory=output / "smac")
            initial = HyperparameterOptimizationFacade.get_initial_design(scenario,
                n_configs=min(2, args.trials - 1), max_ratio=1.0, additional_configs=[space.get_default_configuration()])
            optimizer = HyperparameterOptimizationFacade(scenario, target, initial_design=initial, overwrite=False)
            optimizer.optimize()
            training_stop = "trial-limit"
        except BudgetExpired:
            training_stop = "training-budget"
        budget.validation()
        summary("validating")
        if selected is not None:
            baseline_holdout = evaluate(defaults, holdout)
            summary("baseline-validation-complete")
            selected_holdout = evaluate(selected, holdout)
            summary("complete" if training_stop == "trial-limit" else "budget-complete; provisional-candidate")
        else:
            summary("budget-reached-before-baseline; no-candidate")
    except BudgetExpired:
        summary("budget-reached; validation-incomplete")
    except BaseException as error:
        budget.cancel.set()
        save("failure.json", {"type": type(error).__name__, "error": str(error), "at": utc()})
        summary("failed")
        raise
    finally:
        print(json.dumps({"output": str(output), "attemptedSolves": budget.attempts}), flush=True)


if __name__ == "__main__":
    main()
