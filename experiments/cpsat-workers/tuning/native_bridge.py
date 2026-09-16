"""Generic offline CP-SAT transport. All business constraints are built in TS."""
import base64
import json
import sys
import pathlib
import tempfile

from ortools.sat.python import cp_model


def build_model(spec):
    model = cp_model.CpModel()
    variables = [model.new_int_var(lo, hi, f"v{i}") for i, (lo, hi) in enumerate(spec["variables"])]

    def expression(terms):
        return sum(variables[index] * coefficient for index, coefficient in terms)

    def literal(index):
        return variables[index] if index >= 0 else variables[-index - 1].Not()

    intervals = []
    for entry in spec["intervals"]:
        start, size, end, presence = entry
        if presence is None:
            intervals.append(model.new_interval_var(variables[start], variables[size], variables[end], ""))
        else:
            intervals.append(model.new_optional_interval_var(variables[start], variables[size], variables[end], literal(presence), ""))
    for row in spec["constraints"]:
        kind = row["kind"]
        if kind == "linear":
            constraint = model.add_linear_constraint(expression(row["terms"]), row["lo"], row["hi"])
            if row["when"]:
                constraint.only_enforce_if([literal(i) for i in row["when"]])
        elif kind == "max":
            model.add_max_equality(variables[row["target"]], [expression(terms) for terms in row["expressions"]])
        elif kind == "min":
            model.add_min_equality(variables[row["target"]], [variables[i] for i in row["values"]])
        elif kind == "element":
            model.add_element(variables[row["index"]], row["values"], variables[row["target"]])
        elif kind == "noOverlap":
            model.add_no_overlap([intervals[i] for i in row["intervals"]])
        else:
            raise ValueError(f"Unknown generic constraint {kind}")
    model.minimize(expression(spec["objective"]))
    for index, value in spec["hints"]:
        model.add_hint(variables[index], value)
    invalid = model.validate()
    if invalid:
        raise ValueError(invalid)
    return model


def encode(spec):
    """Serialization only. In WASM mode no native CpSolver is constructed or run."""
    model = build_model(spec)
    with tempfile.TemporaryDirectory(prefix="cpsat-encode-") as directory:
        path = pathlib.Path(directory) / "model.bin"
        if not model.export_to_file(str(path)):
            raise RuntimeError("CP-SAT model export failed")
        return base64.b64encode(path.read_bytes()).decode("ascii")


def solve(spec, capture=False):
    model = build_model(spec)
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 1
    solver.parameters.max_deterministic_time = spec["budget"]
    status = solver.solve(model)
    found = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    result = {
        "status": solver.status_name(status),
        "objective": solver.objective_value if found else None,
        "bestBound": solver.best_objective_bound,
        "solution": list(solver.response_proto.solution) if found else [],
        "deterministicTime": solver.response_proto.deterministic_time,
        "wallTimeSeconds": solver.wall_time,
        "branches": solver.num_branches,
        "conflicts": solver.num_conflicts,
        "modelVariables": len(model.proto.variables),
        "modelConstraints": len(model.proto.constraints),
    }
    if capture:
        result["protoBase64"] = encode(spec)
    return result


if __name__ == "__main__":
    for line in sys.stdin:
        try:
            request = json.loads(line)
            print(json.dumps(solve(request["model"], request.get("capture", False))), flush=True)
        except Exception as error:
            print(json.dumps({"error": str(error)}), flush=True)
