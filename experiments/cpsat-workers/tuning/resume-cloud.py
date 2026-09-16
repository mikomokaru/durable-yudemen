"""Explicit bounded extension of the interrupted initial-design cloud search.

Reuses only complete history replays, reconstructs and verifies the original
Sobol proposals, then continues SMAC ask/tell. No native solver or HTTP retries.
The caller supplies the approved UTC start; setup time counts toward the limit.
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

spec = importlib.util.spec_from_file_location("batched_cloud_search", pathlib.Path(__file__).with_name("search-cloud-batched.py"))
batched = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batched)
BOUNDS, BudgetExpired, FatalReplay = batched.BOUNDS, batched.BudgetExpired, batched.FatalReplay
key, utc, history_jobs = batched.key, batched.utc, batched.history_jobs
ROOT = pathlib.Path("experiments/cpsat-workers")
UNCHANGED = (
    "tuning/schedule.ts", "tuning/cli.ts", "tuning/defaults.json", "tuning/native_bridge.py",
    "tuning/validate-solution.mjs", "tuning/cloud-client.mjs", "tuning/cloud-bridge.mjs",
    "tuning/cloud_transport.py", "src/runtime.ts", "search-worker/index.ts", "search-worker/wrangler.jsonc",
)


class ExtensionBudget(batched.serial.Budget):
    def __init__(self, approved_start, seconds, consumed, reserve_seconds=600, reserve_requests=12000):
        assert 600 < seconds <= 7200 and consumed < 38000
        self.approved_start = approved_start
        # Leave room for one in-flight protocol operation and process cleanup.
        self.wall_hard_deadline = approved_start + seconds - 60
        remaining = self.wall_hard_deadline - time.time()
        assert remaining > reserve_seconds, "No training budget remains"
        super().__init__(remaining, 50000, reserve_seconds, reserve_requests)
        self.wall_deadline = self.wall_hard_deadline - reserve_seconds
        self.attempts = consumed

    def check(self):
        if time.time() >= self.wall_deadline:
            raise BudgetExpired("Approved UTC deadline reached")
        super().check()

    def validation(self):
        super().validation()
        self.wall_deadline = self.wall_hard_deadline


def validate_entry(entry, allowed, train, holdout, defaults):
    preferences, history, result = entry["preferences"], entry["history"], entry["result"]
    assert any(preferences == p for p in allowed), "Unproposed configuration in cache"
    assert history in train or history in holdout and preferences == defaults, "Holdout cannot seed search"
    assert result["completedItems"] == result["expectedItems"] and result["fallbackCount"] == 0
    assert result["solveCount"] > 0 and result["cloud"]["solves"] == result["solveCount"]
    assert result["cloud"]["validatedSolutions"] == result["solveCount"]
    assert math.isfinite(result["fixedScore"])
    return key(preferences, history)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--resume-run", required=True)
    parser.add_argument("--corpus", default="docs/data_samples/noodle_plan_histories")
    parser.add_argument("--approved-start", required=True, help="Timezone-aware ISO UTC start, including setup")
    parser.add_argument("--max-seconds", type=int, default=7200)
    args = parser.parse_args()
    os.umask(0o077)
    approved = datetime.fromisoformat(args.approved_start)
    assert approved.tzinfo is not None and approved.timestamp() <= time.time()
    source = pathlib.Path(args.resume_run).resolve()
    old = json.loads((source / "manifest.json").read_text())
    old_summary = json.loads((source / "summary.json").read_text())
    old_proposals = json.loads((source / "proposals.json").read_text())
    old_evaluations = json.loads((source / "evaluations.json").read_text())
    assert old_summary["evaluatedConfigurations"] == len(old_evaluations) == 1
    assert old_summary["status"] == "budget-complete; provisional-candidate"
    old_log = (source / "requests.jsonl").read_text()
    assert old_log.endswith("\n")
    prior_requests = [json.loads(line) for line in old_log.splitlines()]
    prior_errors = [row for row in prior_requests if row["kind"] == "error"]
    assert prior_errors == old["preservedPriorErrors"], "Undocumented prior transport error"
    assert len(prior_errors) == 1 and prior_errors[0]["error"] == "The operation was aborted due to timeout"
    consumed = sum(row["kind"] == "attempt" for row in prior_requests)
    assert consumed == old_summary["attemptedSolves"]
    budget = ExtensionBudget(approved.timestamp(), args.max_seconds, consumed)
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
    defaults = selected = baseline = selected_score = baseline_holdout = selected_holdout = None
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
            "status": status, "searchRuntime": "wasm-cloud", "startedAt": approved.isoformat(),
            "originalStartedAt": old_summary["startedAt"], "updatedAt": utc(),
            "elapsedSeconds": time.time() - approved.timestamp(), "parallelHistories": 4, "parallelCandidates": 3,
            "attemptedSolves": budget.attempts, "importedAttempts": consumed,
            "extensionAttempts": budget.attempts - consumed, "completedReplays": len(cache),
            "completedReplaySolves": sum(r["solveCount"] for r in cache.values()),
            "totalFallbacks": sum(r["fallbackCount"] for r in cache.values()),
            "evaluatedConfigurations": len(evaluations), "trainingStop": training_stop,
            "baselinePreferences": defaults, "selectedPreferences": selected,
            "baselineTrainScore": baseline, "selectedTrainScore": selected_score,
            "baselineHoldoutScore": baseline_holdout, "selectedHoldoutScore": selected_holdout,
        })

    def score(preferences, histories):
        if any(key(preferences, h) not in cache for h in histories):
            return None
        results = [cache[key(preferences, h)] for h in histories]
        fallback = sum(r["fallbackCount"] for r in results)
        return 1e12 + fallback * 1e6 if fallback else sum(r["fixedScore"] for r in results)

    try:
        with replay_process(args.corpus) as client:
            ready = client.ready
        assert ready == old["corpus"], "Input/configuration changed"
        for name in UNCHANGED:
            assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == old["sourceSha256"][name], f"Changed {name}"
        with solver_process(old["transport"]["versionId"]) as solver:
            transport = solver.ready
        assert transport["wasmSha256"] == old["transport"]["wasmSha256"]
        assert transport["runtime"] == "wasm-cloud" and transport["clock"] == "frozen"
        defaults = ready["defaults"]
        train, holdout = old["trainHistories"], old["holdoutHistories"]
        assert len(train) == 14 and len(holdout) == 6 and not set(train) & set(holdout)
        assert len(old_proposals) == 3 and old_proposals[0]["preferences"] == defaults
        assert old_evaluations[0]["preferences"] == defaults
        imported = []
        for path in sorted(source.glob("replay-*.json")):
            entry = json.loads(path.read_text())
            cache_key = validate_entry(entry, [p["preferences"] for p in old_proposals], train, holdout, defaults)
            assert cache_key not in cache, "Duplicate cached replay"
            cache[cache_key] = entry["result"]
            save(f"replay-{len(cache):04d}.json", entry)
            imported.append({"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        assert len(cache) == old_summary["completedReplays"]
        baseline = score(defaults, train)
        baseline_holdout = score(defaults, holdout)
        assert baseline == old_summary["baselineTrainScore"] == old_evaluations[0]["score"]
        assert baseline_holdout == old_summary["baselineHoldoutScore"] and baseline_holdout is not None
        selected, selected_score = dict(defaults), baseline
        order = sorted(train, key=lambda h: cache[key(defaults, h)]["cloud"]["meanRequestMs"] * cache[key(defaults, h)]["solveCount"], reverse=True)
        (output / "requests.jsonl").write_text(old_log)
        manifest = {**old, "startedAt": approved.isoformat(), "transport": transport,
            "args": {**vars(args), "parallel": 4, "trials": 12, "seed": old["args"]["seed"],
                "max_requests": 50000, "validation_seconds": 600, "validation_requests": 12000},
            "initialDesign": "verified resumed default plus two original Sobol proposals, then SMAC ask/tell batches of three",
            "historyExecutionOrder": order, "extensionDriverSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
            "resumeSource": {"directory": str(source), "manifestSha256": hashlib.sha256((source / "manifest.json").read_bytes()).hexdigest(),
                "journalSha256": hashlib.sha256(old_log.encode()).hexdigest(), "spentRequests": consumed, "replays": imported},
            "absoluteDeadlineUtc": datetime.fromtimestamp(approved.timestamp() + args.max_seconds, timezone.utc).isoformat(),
            "requestStartDeadlineUtc": datetime.fromtimestamp(budget.wall_hard_deadline, timezone.utc).isoformat(),
            "deadlineClocks": ["UTC wall clock", "monotonic"], "cleanupReserveSeconds": 60,
            "restoredScoresUseOnlyTrainHistories": True,
        }
        save("manifest.json", manifest)
        summary("resumed-cache-verified")

        def replay_one(preferences, history):
            cache_key = key(preferences, history)
            with lock:
                if cache_key in cache:
                    return cache[cache_key]
            budget.check()
            metrics = []
            with replay_process(args.corpus) as client, solver_process(transport["versionId"]) as remote:
                assert client.ready == ready, "Inputs changed during search"
                client.send({"kind": "replay", "store": history, "preferences": preferences})
                while True:
                    message = client.read()
                    if message["kind"] == "solve":
                        number = budget.reserve()
                        journal({"kind": "attempt", "number": number, "history": history, "at": utc(),
                            "configurationSha256": hashlib.sha256(key(preferences, "").encode()).hexdigest()})
                        try:
                            result = cloud_solve(remote, message["model"])
                        except BaseException as error:
                            save(f"failed-model-{number}.json", {"history": history, "preferences": preferences, "model": message["model"]})
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
                        assert result["completedItems"] == result["expectedItems"]
                        times = sorted(r["clientElapsedMs"] for r in metrics)
                        result["cloud"] = {"solves": len(metrics), "validatedSolutions": sum(r["validated"] for r in metrics),
                            "statusCounts": dict(Counter(r["status"] for r in metrics)),
                            "maxMemoryBytes": max(r["wasmMemoryBytes"] for r in metrics),
                            "isolateCount": len({r["isolateId"] for r in metrics}),
                            "meanRequestMs": sum(times) / len(times), "p95RequestMs": times[math.ceil(len(times) * .95) - 1], "maxRequestMs": times[-1]}
                        with lock:
                            cache[cache_key] = result
                            save(f"replay-{len(cache):04d}.json", {"history": history, "preferences": preferences, "result": result})
                            summary("searching" if training_stop is None else "validating")
                            print(json.dumps({"history": history, "score": result["fixedScore"], "solves": result["solveCount"], "fallbacks": result["fallbackCount"], "attempts": budget.attempts}), flush=True)
                        return result
                    else:
                        raise RuntimeError("Unexpected TS protocol message")

        def batch(preferences, histories):
            errors = []
            # Four global lanes, not four lanes for each candidate.
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

        seed = old["args"]["seed"]
        space = ConfigurationSpace(seed=seed)
        space.add([Integer(name, bounds=bounds, default=defaults[name]) for name, bounds in BOUNDS.items()])
        scenario = Scenario(space, deterministic=True, n_trials=12, seed=seed, output_directory=output / "smac")
        initial = HyperparameterOptimizationFacade.get_initial_design(scenario, n_configs=2, max_ratio=1.0)
        optimizer = HyperparameterOptimizationFacade(scenario, initial_design=initial, overwrite=False)

        def tell(info, value):
            nonlocal selected, selected_score
            preferences = {name: int(v) for name, v in dict(info.config).items()}
            assert score(preferences, train) == value, "Only complete training cohorts can receive a score"
            optimizer.tell(info, TrialValue(cost=value))
            evaluations.append({"preferences": preferences, "score": value, "origin": info.config.origin, "at": utc()})
            if value < selected_score:
                selected, selected_score = preferences, value
            save("evaluations.json", evaluations)
            summary("searching")
            print(json.dumps({"trial": len(evaluations), "origin": info.config.origin, "score": value, "selectedTrainScore": selected_score}), flush=True)

        tell(TrialInfo(config=space.get_default_configuration(), seed=seed), baseline)
        proposals.append(old_proposals[0])
        asked, first = 1, True
        try:
            while asked < 12:
                budget.check()
                infos = [optimizer.ask() for _ in range(min(2 if first else 3, 12 - asked))]
                preferences = [{name: int(value) for name, value in dict(info.config).items()} for info in infos]
                assert len({key(p, "") for p in preferences}) == len(preferences)
                assert not any(p == old_p["preferences"] for p in preferences for old_p in proposals), "Previously proposed configuration"
                if first:
                    assert preferences == [p["preferences"] for p in old_proposals[1:]], "Sobol proposals drifted"
                    assert [info.config.origin for info in infos] == [p["origin"] for p in old_proposals[1:]]
                proposals.extend({"preferences": p, "origin": info.config.origin, "at": utc()} for info, p in zip(infos, preferences))
                save("proposals.json", proposals)
                asked += len(infos)
                first = False
                print(json.dumps({"proposed": asked, "origins": [info.config.origin for info in infos]}), flush=True)
                stopped = batch(preferences, order)
                # Stable order, independent of remote completion timing.
                for info, p in zip(infos, preferences):
                    value = score(p, train)
                    if value is not None:
                        tell(info, value)
                if stopped:
                    raise BudgetExpired("Training batch reached its budget")
            training_stop = "trial-limit"
        except BudgetExpired:
            training_stop = "interrupted" if interrupted.is_set() else "training-budget"
        if interrupted.is_set():
            summary("interrupted; validation-not-run")
            return
        budget.validation()
        summary("validating")
        stopped = batch([selected], holdout)
        selected_holdout = score(selected, holdout)
        summary("budget-reached; validation-incomplete" if stopped else "complete" if training_stop == "trial-limit" else "budget-complete; provisional-candidate")
    except BaseException as error:
        budget.cancel.set()
        save("failure.json", {"type": type(error).__name__, "error": str(error), "at": utc()})
        summary("failed")
        raise
    finally:
        print(json.dumps({"output": str(output), "attemptedSolves": budget.attempts}), flush=True)


if __name__ == "__main__":
    main()
