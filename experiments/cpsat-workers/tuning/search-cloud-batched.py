"""SMAC ask/tell batches with ONE shared four-history executor across candidates.

Imports a verified complete baseline, including its elapsed time/request spend.
The first two Sobol candidates run together; later batches use SMAC's posterior.
All fourteen histories must complete before any candidate receives a score.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import signal
import threading
import time

from ConfigSpace import ConfigurationSpace, Integer
from smac import HyperparameterOptimizationFacade, Scenario
from smac.runhistory import TrialInfo, TrialValue
from cloud_transport import replay_process, solver_process, cloud_solve

module_spec = importlib.util.spec_from_file_location("serial_cloud_search", pathlib.Path(__file__).with_name("search-cloud.py"))
serial = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(serial)
BudgetExpired, FatalReplay, BOUNDS, utc = serial.BudgetExpired, serial.FatalReplay, serial.BOUNDS, serial.utc


def key(preferences, history):
    return json.dumps([preferences, history], sort_keys=True)


def history_jobs(preferences, histories):
    # Round-robin over candidates: their longest histories start together.
    return [(p, h) for h in histories for p in preferences]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--baseline-run", required=True)
    parser.add_argument("--resume-after-host-sleep", action="store_true", help="Explicitly acknowledge the documented idle-sleep timeout; preserve it in the journal")
    args = parser.parse_args()
    os.umask(0o077)
    source = pathlib.Path(args.baseline_run).resolve()
    old = json.loads((source / "manifest.json").read_text())
    old_summary = json.loads((source / "summary.json").read_text())
    started_at = old_summary["startedAt"]
    elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(started_at)).total_seconds()
    assert 0 < elapsed < 3000, "Baseline left no training budget"
    old_log = (source / "requests.jsonl").read_text()
    assert old_log.endswith("\n"), "Stop the source runner before importing its journal"
    previous_requests = [json.loads(line) for line in old_log.splitlines()]
    prior_errors = [r for r in previous_requests if r["kind"] == "error"]
    if args.resume_after_host_sleep:
        assert len(prior_errors) == 1 and prior_errors[0]["error"] == "The operation was aborted due to timeout"
    else:
        assert not prior_errors, "Source contains a solver failure"
    consumed = sum(r["kind"] == "attempt" for r in previous_requests)
    budget = serial.Budget(3600 - elapsed, 50000, 600, 12000)
    budget.started -= elapsed
    budget.attempts = consumed
    interrupted = threading.Event()

    def interrupt(_signum, _frame):
        interrupted.set()
        budget.cancel.set()
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    output = pathlib.Path(args.output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    lock = threading.Lock()
    cache, evaluations, proposals = {}, [], []
    baseline = selected_score = baseline_holdout = selected_holdout = None
    selected = defaults = None
    training_stop = None

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
            "parallelHistories": 4, "parallelCandidates": 3,
            "attemptedSolves": budget.attempts, "completedReplays": len(cache),
            "completedReplaySolves": sum(r["solveCount"] for r in cache.values()),
            "totalFallbacks": sum(r["fallbackCount"] for r in cache.values()),
            "evaluatedConfigurations": len(evaluations), "trainingStop": training_stop,
            "baselinePreferences": defaults, "selectedPreferences": selected,
            "baselineTrainScore": baseline, "selectedTrainScore": selected_score,
            "baselineHoldoutScore": baseline_holdout, "selectedHoldoutScore": selected_holdout,
        })

    try:
        with replay_process(old["args"]["corpus"]) as client:
            ready = client.ready
        assert ready == old["corpus"], "Input/configuration changed"
        # Orchestration can change, but no model, scoring or solving code may drift.
        for name in ("tuning/schedule.ts", "tuning/cli.ts", "tuning/defaults.json", "tuning/native_bridge.py",
                "tuning/validate-solution.mjs", "tuning/cloud-client.mjs", "tuning/cloud-bridge.mjs",
                "src/runtime.ts", "search-worker/index.ts", "search-worker/wrangler.jsonc"):
            assert hashlib.sha256((pathlib.Path("experiments/cpsat-workers") / name).read_bytes()).hexdigest() == old["sourceSha256"][name], f"Changed {name}"
        with solver_process(old["transport"]["versionId"]) as solver:
            transport = solver.ready
        defaults = ready["defaults"]
        train, holdout = old["trainHistories"], old["holdoutHistories"]
        for path in sorted(source.glob("replay-*.json")):
            entry = json.loads(path.read_text())
            if entry["preferences"] != defaults or entry["history"] not in train:
                continue
            result = entry["result"]
            assert result["completedItems"] == result["expectedItems"] and result["fallbackCount"] == 0
            cache[key(defaults, entry["history"])] = result
            save(f"replay-{len(cache):04d}.json", entry)
        assert len(train) == 14 and (len(cache) == 14 or args.resume_after_host_sleep and len(cache) == 13)
        (output / "requests.jsonl").write_text(old_log)
        if len(cache) == 14:
            baseline = sum(cache[key(defaults, h)]["fixedScore"] for h in train)
            selected, selected_score = dict(defaults), baseline
        # The tail of the longest history is the main serial barrier. Prioritize
        # histories by observed baseline client service time, without using scores.
        order = sorted(train, key=lambda h: cache[key(defaults, h)]["cloud"]["meanRequestMs"] * cache[key(defaults, h)]["solveCount"] if key(defaults, h) in cache else float("inf"), reverse=True)
        manifest = {**old, "transport": transport, "args": {"parallel": 4, "trials": 12, "max_seconds": 3600,
                "max_requests": 50000, "validation_seconds": 600, "validation_requests": 12000, "seed": old["args"]["seed"]},
            "parallelUnit": "four global history lanes shared across up to three candidate configurations",
            "initialDesign": "imported complete default baseline, two Sobol candidates together, then SMAC ask/tell batches of three",
            "importedBaseline": {"directory": str(source), "manifestSha256": hashlib.sha256((source / "manifest.json").read_bytes()).hexdigest(),
                "journalSha256": hashlib.sha256(old_log.encode()).hexdigest(), "spentRequests": consumed, "elapsedSeconds": elapsed},
            "historyExecutionOrder": order,
            "batchDriverSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
            "completionOrderDoesNotAffectTellOrder": True,
            "explicitHostSleepRecovery": args.resume_after_host_sleep,
            "preservedPriorErrors": prior_errors,
            "absoluteDeadlineUtc": datetime.fromtimestamp(datetime.fromisoformat(started_at).timestamp() + 3600, timezone.utc).isoformat(),
        }
        save("manifest.json", manifest)
        summary("baseline-imported")

        def replay_one(preferences, history):
            cache_key = key(preferences, history)
            with lock:
                if cache_key in cache:
                    return cache[cache_key]
            budget.check()
            metrics = []
            with replay_process(old["args"]["corpus"]) as client, solver_process(transport["versionId"]) as remote:
                assert client.ready == ready, "Inputs changed during search"
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
                        times = sorted(r["clientElapsedMs"] for r in metrics)
                        result["cloud"] = {"solves": len(metrics), "validatedSolutions": sum(r["validated"] for r in metrics),
                            "statusCounts": dict(Counter(r["status"] for r in metrics)),
                            "maxMemoryBytes": max(r["wasmMemoryBytes"] for r in metrics),
                            "isolateCount": len({r["isolateId"] for r in metrics}),
                            "meanRequestMs": sum(times) / len(times), "p95RequestMs": times[math.ceil(len(times) * .95) - 1], "maxRequestMs": times[-1]}
                        with lock:
                            cache[cache_key] = result
                            save(f"replay-{len(cache):04d}.json", {"history": history, "preferences": preferences, "result": result})
                            print(json.dumps({"history": history, "score": result["fixedScore"], "solves": result["solveCount"], "fallbacks": result["fallbackCount"], "attempts": budget.attempts, "elapsedSeconds": round(time.monotonic() - budget.started, 1)}), flush=True)
                        return result
                    else:
                        raise RuntimeError("Unexpected TS protocol message")

        def batch(preferences, histories):
            errors = []
            # Exactly one pool: never parallel_candidates * parallel_histories.
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(replay_one, p, h) for p, h in history_jobs(preferences, histories)]
                for future in as_completed(futures):
                    try:
                        future.result()
                    except BaseException as error:
                        budget.cancel.set()
                        errors.append(error)
            fatal = [e for e in errors if not isinstance(e, BudgetExpired)]
            if fatal:
                raise FatalReplay(str(fatal[0])) from fatal[0]
            return bool(errors)

        def score(preferences, histories):
            if any(key(preferences, h) not in cache for h in histories):
                return None
            results = [cache[key(preferences, h)] for h in histories]
            fallback = sum(r["fallbackCount"] for r in results)
            return 1e12 + fallback * 1e6 if fallback else sum(r["fixedScore"] for r in results)

        space = ConfigurationSpace(seed=old["args"]["seed"])
        space.add([Integer(name, bounds=bounds, default=defaults[name]) for name, bounds in BOUNDS.items()])
        scenario = Scenario(space, deterministic=True, n_trials=12, seed=old["args"]["seed"], output_directory=output / "smac")
        initial = HyperparameterOptimizationFacade.get_initial_design(scenario, n_configs=2, max_ratio=1.0)
        optimizer = HyperparameterOptimizationFacade(scenario, initial_design=initial, overwrite=False)

        def tell(info, value):
            nonlocal baseline, selected, selected_score
            preferences = {name: int(value) for name, value in dict(info.config).items()}
            optimizer.tell(info, TrialValue(cost=value))
            evaluations.append({"preferences": preferences, "score": value, "origin": info.config.origin, "at": utc()})
            if preferences == defaults:
                baseline = value
            if selected_score is None or value < selected_score:
                selected, selected_score = preferences, value
            save("evaluations.json", evaluations)
            summary("searching")
            print(json.dumps({"trial": len(evaluations), "origin": info.config.origin, "score": value, "selectedTrainScore": selected_score}), flush=True)

        default_info = TrialInfo(config=space.get_default_configuration(), seed=old["args"]["seed"])
        if baseline is not None:
            tell(default_info, baseline)
        asked = 1
        first = True
        try:
            while asked < 12:
                budget.check()
                count = min(2 if first else 3, 12 - asked)
                infos = [optimizer.ask() for _ in range(count)]
                asked += len(infos)
                if first and baseline is None:
                    infos.insert(0, default_info)
                first = False
                preferences = [{name: int(value) for name, value in dict(info.config).items()} for info in infos]
                assert len({key(p, "") for p in preferences}) == len(preferences), "Duplicate in-flight configuration"
                proposals.extend({"preferences": p, "origin": info.config.origin, "at": utc()} for info, p in zip(infos, preferences))
                save("proposals.json", proposals)
                stopped = batch(preferences, order)
                # Tell in proposal order, never completion order. A partial batch
                # can contribute only candidates with all 14 histories completed.
                for info, p in zip(infos, preferences):
                    value = score(p, train)
                    if value is not None:
                        tell(info, value)
                if stopped:
                    raise BudgetExpired("Training batch hit its budget")
            training_stop = "trial-limit"
        except BudgetExpired:
            training_stop = "interrupted" if interrupted.is_set() else "training-budget"
        if interrupted.is_set():
            summary("interrupted; validation-not-run")
            return
        if baseline is None or selected is None:
            summary("budget-reached-before-baseline; no-comparison")
            return
        budget.validation()
        summary("validating")
        validate = [defaults] if selected == defaults else [defaults, selected]
        stopped = batch(validate, holdout)
        baseline_holdout, selected_holdout = score(defaults, holdout), score(selected, holdout)
        if stopped:
            summary("budget-reached; validation-incomplete")
        else:
            summary("complete" if training_stop == "trial-limit" else "budget-complete; provisional-candidate")
    except BaseException as error:
        budget.cancel.set()
        save("failure.json", {"type": type(error).__name__, "error": str(error), "at": utc()})
        summary("failed")
        raise
    finally:
        print(json.dumps({"output": str(output), "attemptedSolves": budget.attempts}), flush=True)


if __name__ == "__main__":
    main()
