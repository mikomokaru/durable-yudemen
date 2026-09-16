"""Offline only: freeze two CpModelProto inputs and their native reference results.

The Worker imports the generated JSON, never this script or Python. Re-running
without --check refuses to overwrite a fixture; --check compares fixed inputs.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import tempfile

import ortools
from ortools.sat.python import cp_model


def fixture(name, budget):
    model = cp_model.CpModel()
    if name == "small":
        variables = [model.new_int_var(0, 2, name) for name in ("x", "y", "z")]
        model.add_all_different(variables)
        model.maximize(2 * variables[0] + variables[1])
    else:
        variables = [model.new_bool_var("") for _ in range(500)]
        random = 0x12345678
        for left in range(500):
            for right in range(left + 1, 500):
                random = (random * 1664525 + 1013904223) & 0xFFFFFFFF
                if random % 1000 < 180:
                    model.add(variables[left] + variables[right] <= 1)
        model.maximize(sum(variables))
    assert model.validate() == ""
    with tempfile.TemporaryDirectory(prefix="cpsat-transport-proto-") as directory:
        path = Path(directory) / "model.bin"
        assert model.export_to_file(str(path))
        proto = path.read_bytes()
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 1
    solver.parameters.max_deterministic_time = budget
    status = solver.solve(model)
    found = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    reference = {
        "status": solver.status_name(status),
        "objective": solver.objective_value if found else None,
        "bestBound": solver.best_objective_bound,
        "solution": list(solver.response_proto.solution) if found else [],
        "deterministicTime": solver.response_proto.deterministic_time,
        "branches": solver.num_branches,
        "conflicts": solver.num_conflicts,
    }
    if name == "small":
        assert reference["status"] == "OPTIMAL"
        assert reference["solution"] == [2, 1, 0] and reference["objective"] == 5
    else:
        assert reference["status"] in ("UNKNOWN", "FEASIBLE")
        assert reference["deterministicTime"] >= budget
    return {
        "name": name,
        "budget": budget,
        "sha256": hashlib.sha256(proto).hexdigest(),
        "byteLength": len(proto),
        "variables": len(model.proto.variables),
        "constraints": len(model.proto.constraints),
        "protoBase64": base64.b64encode(proto).decode("ascii"),
        "native": reference,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    assert ortools.__version__ == "9.15.6755", ortools.__version__
    result = {
        "schemaVersion": 1,
        "nativeVersion": ortools.__version__,
        "seed": 1,
        "numWorkers": 1,
        "fixtures": [fixture("small", 0.01), fixture("hard", 0.14)],
    }
    encoded = json.dumps(result, indent=2, ensure_ascii=True) + "\n"
    destination = Path(__file__).with_name("fixtures.json")
    native_differences = []
    if args.check:
        previous = json.loads(destination.read_text())
        assert {k: v for k, v in previous.items() if k != "fixtures"} == {
            k: v for k, v in result.items() if k != "fixtures"
        }
        assert len(previous["fixtures"]) == len(result["fixtures"])
        for old, new in zip(previous["fixtures"], result["fixtures"]):
            assert {k: v for k, v in old.items() if k != "native"} == {
                k: v for k, v in new.items() if k != "native"
            }, "Fixed protobuf or its configuration changed"
            # An architecture/build-dependent search path is not model drift.
            # fixture() independently asserts the known optimum/work cutoff.
            native_differences.append({
                "fixture": new["name"],
                "fields": [k for k, v in new["native"].items() if old["native"][k] != v],
            })
    else:
        with destination.open("x") as output:
            output.write(encoded)
    print(json.dumps({
        "checked": args.check,
        "nativeDifferences": native_differences,
        "fixtures": [{k: v for k, v in row.items() if k != "protoBase64"}
                     for row in result["fixtures"]],
    }, indent=2))
