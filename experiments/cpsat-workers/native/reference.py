#!/usr/bin/env python3
"""Native OR-Tools 9.15 reference for the exact two PoC models."""

from __future__ import annotations

import argparse
import json
import math
from typing import Any

from ortools.sat.python import cp_model

HARD_VARIABLE_COUNT = 500
HARD_SEED = 0x12345678
HARD_EDGE_THRESHOLD = 180


def next_random(state: int) -> int:
    return (state * 1664525 + 1013904223) & 0xFFFFFFFF


def small_model() -> tuple[cp_model.CpModel, list[cp_model.IntVar], int]:
    model = cp_model.CpModel()
    variables = [model.new_int_var(0, 2, name) for name in ("x", "y", "z")]
    model.add_all_different(variables)
    model.maximize(2 * variables[0] + variables[1])
    return model, variables, 1


def hard_model() -> tuple[cp_model.CpModel, list[cp_model.IntVar], int]:
    model = cp_model.CpModel()
    variables = [model.new_bool_var(f"x{index}") for index in range(HARD_VARIABLE_COUNT)]
    random = HARD_SEED
    constraints = 0
    for left in range(HARD_VARIABLE_COUNT):
        for right in range(left + 1, HARD_VARIABLE_COUNT):
            random = next_random(random)
            if random % 1000 >= HARD_EDGE_THRESHOLD:
                continue
            model.add(variables[left] + variables[right] <= 1)
            constraints += 1
    model.maximize(sum(variables))
    return model, variables, constraints


def solve(case_name: str, deterministic_limit: float) -> dict[str, Any]:
    model, variables, constraints = small_model() if case_name == "small" else hard_model()
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 1
    solver.parameters.max_deterministic_time = deterministic_limit
    if case_name == "hard-search":
        solver.parameters.cp_model_presolve = False
        solver.parameters.linearization_level = 0
    status = solver.solve(model)
    has_solution = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    return {
        "case": case_name,
        "status": solver.status_name(status),
        "objective": solver.objective_value if has_solution else None,
        "bestBound": solver.best_objective_bound,
        "solution": [solver.value(variable) for variable in variables] if has_solution else [],
        "modelVariables": len(variables),
        "modelConstraints": constraints,
        "requestedDeterministicLimit": deterministic_limit,
        "wallTimeLimitEnabled": False,
        "solverWallTimeMs": solver.wall_time * 1000,
        "deterministicTime": solver.response_proto.deterministic_time,
        "conflicts": solver.num_conflicts,
        "branches": solver.num_branches,
        "booleans": solver.response_proto.num_booleans,
        "searchWorkers": 1,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=("small", "hard", "hard-search"), default="small")
    parser.add_argument("--deterministic-limit", type=float, default=0.05)
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    if not math.isfinite(args.deterministic_limit) or not 0 < args.deterministic_limit <= 1 or not 1 <= args.repeat <= 50:
        parser.error("deterministic limit must be finite and in (0, 1]; repeat must be 1..50")
    print(json.dumps([solve(args.case, args.deterministic_limit) for _ in range(args.repeat)]))


if __name__ == "__main__":
    main()
