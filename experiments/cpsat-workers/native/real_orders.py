"""Isolated feasibility experiment. Not the production business objective."""
import argparse
import base64
import hashlib
import json
import pathlib

from ortools.sat.python import cp_model


def build(scene):
    request = scene["request"]
    now = scene["now"]
    params = request["params"]
    pending = request["pending"]
    running = request["running"]
    assert len(scene["baseline"]["slices"]) == 1, "This first model covers the single-table corpus only"
    placements = scene["baseline"]["slices"][0]["placements"]
    assert len(placements) == len(pending) > 0
    by_key = {(p["externalOrderId"], p["itemIndex"]): p for p in placements}
    presets = {p["noodleType"]: p["boilSeconds"] for p in request["noodlePresets"]}
    durations = [presets[item["noodleType"]][item["firmness"]] * 1000 for item in pending]
    slot_count = len(params["unitOrigins"]) * 6
    lift_length = params["liftIntervalSeconds"] * 1000
    cap = params["arms"] + 2  # HELPER_ARMS in domain/store.ts; checked by engine after solve.
    horizon = max(p["serveAt"] - now for p in placements) + sum(durations) + lift_length
    model = cp_model.CpModel()
    starts, ends, selections = [], [], []
    slots = [[] for _ in range(slot_count)]
    lifts, demands = [], []
    release = [0] * slot_count
    for timer in running:
        for slot in timer["slotIds"]:
            release[int(slot)] = max(release[int(slot)], 1, timer["endTime"] + timer["adjustment"] - now)
    pinned = 0
    for index, (item, duration) in enumerate(zip(pending, durations)):
        previous = by_key[item["externalOrderId"], item["itemIndex"]]
        start = model.new_int_var(0, horizon - duration, f"start_{index}")
        end = model.new_int_var(duration, horizon, f"end_{index}")
        model.add(end == start + duration)
        choices = [model.new_bool_var(f"slot_{index}_{slot}") for slot in range(slot_count)]
        model.add(sum(choices) == item["slotSpan"])
        siblings = [t["endTime"] + t["adjustment"] for t in running
                    if t["orderItem"] is not None and t["orderItem"]["tableId"] == item["tableId"]]
        if siblings:
            model.add(end >= min(siblings) - now - duration * params["toleranceRatio"] // 100)
        if previous["anchor"] is not None:
            pinned += 1
            model.add(start == previous["startAt"] - now)
            for slot, choice in enumerate(choices):
                model.add(choice == int(str(slot) in previous["slotIds"]))
        for slot, choice in enumerate(choices):
            model.add(start >= release[slot]).only_enforce_if(choice)
            slots[slot].append(model.new_optional_interval_var(start, duration, end, choice, ""))
            model.add_hint(choice, int(str(slot) in previous["slotIds"]))
        lifts.append(model.new_fixed_size_interval_var(end, lift_length, ""))
        demands.append(item["slotSpan"])
        model.add_hint(start, previous["startAt"] - now)
        model.add_hint(end, previous["serveAt"] - now)
        starts.append(start)
        ends.append(end)
        selections.append(choices)

    for intervals in slots:
        model.add_no_overlap(intervals)

    # A lift at t occupies [t,t+L). Clip pre-existing overload to cap: existing-only
    # overload is historical fact, but no new lift may overlap that portion.
    existing = [(t["endTime"] + t["adjustment"] - now, len(t["slotIds"])) for t in running]
    boundaries = sorted({at for at, _ in existing} | {at + lift_length for at, _ in existing})
    for left, right in zip(boundaries, boundaries[1:]):
        load = sum(span for at, span in existing if at <= left < at + lift_length)
        if load:
            lifts.append(model.new_fixed_size_interval_var(left, right - left, ""))
            demands.append(min(cap, load))
    model.add_cumulative(lifts, demands, cap)
    model.minimize(sum(ends))
    assert not model.validate(), model.validate()
    return model, {
        "startVariables": [v.index for v in starts],
        "endVariables": [v.index for v in ends],
        "slotVariables": [[v.index for v in choices] for choices in selections],
        "pinnedAnchors": pinned,
        "freeItems": len(pending) - pinned,
        "modelVariables": len(model.proto.variables),
        "modelConstraints": len(model.proto.constraints),
    }


def solve(model, budget):
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 1
    solver.parameters.max_deterministic_time = budget
    status = solver.solve(model)
    response = solver.response_proto
    found = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    return {
        "case": "model", "status": solver.status_name(status),
        "objective": solver.objective_value if found else None,
        "bestBound": solver.best_objective_bound,
        "solution": list(response.solution) if found else [],
        "modelVariables": len(model.proto.variables), "modelConstraints": len(model.proto.constraints),
        "requestedDeterministicLimit": budget, "wallTimeLimitEnabled": False,
        "deterministicTime": response.deterministic_time, "solverWallTimeMs": response.wall_time * 1000,
        "branches": response.num_branches, "conflicts": response.num_conflicts,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenes", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--budget", type=float, default=0.05)
    parser.add_argument("--repeat", type=int, default=5)
    parser.add_argument("--count", type=int, default=100)
    args = parser.parse_args()
    assert 0 < args.budget <= 0.2 and 1 <= args.repeat <= 10 and 1 <= args.count <= 1000
    source_bytes = pathlib.Path(args.scenes).read_bytes()
    source = json.loads(source_bytes)
    output = pathlib.Path(args.output)
    output.touch(mode=0o600, exist_ok=True)
    output.chmod(0o600)  # Protect partial results as well as completed runs.
    models_dir = output.parent / "models"
    models_dir.mkdir(mode=0o700, exist_ok=True)
    models_dir.chmod(0o700)
    result = {"sceneSha256": hashlib.sha256(source_bytes).hexdigest(), "budget": args.budget,
              "repeat": args.repeat, "objective": "sum(serveAt-now) milliseconds; NOT full engine score",
              "anchorPolicy": "baseline anchor placements fixed; engine keepsAnchor checked afterwards",
              "scenes": []}
    for scene in source["scenes"][:args.count]:
        model, indices = build(scene)
        path = models_dir / f'{scene["id"]}.bin'
        assert model.export_to_file(str(path))
        binary = path.read_bytes()
        assert 0 < len(binary) <= 1048576
        samples = [solve(model, args.budget) for _ in range(args.repeat)]
        result["scenes"].append({"id": scene["id"], **indices, "protoSha256": hashlib.sha256(binary).hexdigest(),
                                 "protoBase64": base64.b64encode(binary).decode("ascii"), "samples": samples})
        print(json.dumps({"nativeScenes": len(result["scenes"]), "status": samples[0]["status"]}), flush=True)
        output.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    output.chmod(0o600)


if __name__ == "__main__":
    main()
