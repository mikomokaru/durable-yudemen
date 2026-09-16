// Apache-2.0. Built against Google OR-Tools 9.15 for the isolated Workers PoC.

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include "ortools/sat/cp_model.h"
#include "ortools/sat/cp_model.pb.h"
#include "ortools/sat/cp_model_solver.h"
#include "ortools/sat/sat_parameters.pb.h"
#include "ortools/util/sorted_interval_list.h"

namespace {

using operations_research::Domain;
using operations_research::sat::BoolVar;
using operations_research::sat::CpModelBuilder;
using operations_research::sat::CpModelProto;
using operations_research::sat::CpSolverResponse;
using operations_research::sat::CpSolverStatus;
using operations_research::sat::CpSolverStatus_Name;
using operations_research::sat::IntVar;
using operations_research::sat::LinearExpr;
using operations_research::sat::Model;
using operations_research::sat::NewSatParameters;
using operations_research::sat::SatParameters;
using operations_research::sat::SolutionIntegerValue;
using operations_research::sat::SolveCpModel;

constexpr int kSmallCase = 0;
constexpr int kHardCase = 1;
constexpr int kHardSearchCase = 2;
constexpr int kModelCase = 3;
constexpr int kHardVariableCount = 500;
constexpr uint32_t kHardSeed = 0x12345678u;
constexpr uint32_t kHardEdgeThreshold = 180u;

struct SolveResult {
  std::string case_name;
  CpSolverResponse response;
  std::vector<int64_t> solution;
  int model_variables = 0;
  int model_constraints = 0;
  double requested_deterministic_limit = 0;
};

uint32_t NextRandom(uint32_t* state) {
  *state = *state * 1664525u + 1013904223u;
  return *state;
}

SatParameters SingleThreadParameters(double deterministic_limit) {
  SatParameters parameters;
  parameters.set_num_workers(1);
  parameters.set_random_seed(1);
  // Keep max_time_in_seconds at its default infinity: Workers' clock need not
  // advance during synchronous Wasm. This is a work budget, not a deadline.
  parameters.set_max_deterministic_time(deterministic_limit);
  return parameters;
}

SolveResult SolveSmall(double deterministic_limit) {
  CpModelBuilder model;
  const Domain domain(0, 2);
  const IntVar x = model.NewIntVar(domain).WithName("x");
  const IntVar y = model.NewIntVar(domain).WithName("y");
  const IntVar z = model.NewIntVar(domain).WithName("z");
  model.AddAllDifferent({x, y, z});
  model.Maximize(2 * x + y);

  Model solver;
  solver.Add(NewSatParameters(SingleThreadParameters(deterministic_limit)));
  const CpSolverResponse response = SolveCpModel(model.Build(), &solver);

  std::vector<int64_t> solution;
  if (response.status() == CpSolverStatus::OPTIMAL ||
      response.status() == CpSolverStatus::FEASIBLE) {
    solution = {
        SolutionIntegerValue(response, x),
        SolutionIntegerValue(response, y),
        SolutionIntegerValue(response, z),
    };
  }
  return {
      .case_name = "small",
      .response = response,
      .solution = std::move(solution),
      .model_variables = 3,
      .model_constraints = 1,
      .requested_deterministic_limit = deterministic_limit,
  };
}

SolveResult SolveHard(double deterministic_limit, bool search_only) {
  CpModelBuilder model;
  std::vector<BoolVar> selected;
  selected.reserve(kHardVariableCount);
  LinearExpr objective;
  for (int index = 0; index < kHardVariableCount; ++index) {
    const BoolVar variable = model.NewBoolVar();
    selected.push_back(variable);
    objective += variable;
  }

  uint32_t random = kHardSeed;
  int constraints = 0;
  for (int left = 0; left < kHardVariableCount; ++left) {
    for (int right = left + 1; right < kHardVariableCount; ++right) {
      if (NextRandom(&random) % 1000u >= kHardEdgeThreshold) continue;
      model.AddLessOrEqual(selected[left] + selected[right], 1);
      ++constraints;
    }
  }
  model.Maximize(objective);

  Model solver;
  SatParameters parameters = SingleThreadParameters(deterministic_limit);
  if (search_only) {
    // A separate fixture proves interruption after branching and an incumbent,
    // rather than testing only presolve. Not proposed production tuning.
    parameters.set_cp_model_presolve(false);
    parameters.set_linearization_level(0);
  }
  solver.Add(NewSatParameters(parameters));
  const CpSolverResponse response = SolveCpModel(model.Build(), &solver);

  std::vector<int64_t> solution;
  if (response.status() == CpSolverStatus::OPTIMAL ||
      response.status() == CpSolverStatus::FEASIBLE) {
    solution.assign(response.solution().begin(), response.solution().end());
  }
  return {
      .case_name = search_only ? "hard-search" : "hard",
      .response = response,
      .solution = std::move(solution),
      .model_variables = kHardVariableCount,
      .model_constraints = constraints,
      .requested_deterministic_limit = deterministic_limit,
  };
}

std::string ToJson(const SolveResult& result) {
  const CpSolverResponse& response = result.response;
  std::ostringstream json;
  json << std::setprecision(17);
  json << "{\"case\":\"" << result.case_name << "\"";
  json << ",\"status\":\"" << CpSolverStatus_Name(response.status()) << "\"";
  const bool has_solution = response.status() == CpSolverStatus::OPTIMAL ||
                            response.status() == CpSolverStatus::FEASIBLE;
  json << ",\"objective\":";
  if (has_solution) json << response.objective_value();
  else json << "null";
  json << ",\"bestBound\":" << response.best_objective_bound();
  json << ",\"solution\":[";
  for (size_t index = 0; index < result.solution.size(); ++index) {
    if (index > 0) json << ',';
    json << result.solution[index];
  }
  json << ']';
  json << ",\"modelVariables\":" << result.model_variables;
  json << ",\"modelConstraints\":" << result.model_constraints;
  json << ",\"requestedDeterministicLimit\":" << result.requested_deterministic_limit;
  json << ",\"wallTimeLimitEnabled\":false";
  json << ",\"solverWallTimeMs\":" << response.wall_time() * 1000.0;
  json << ",\"deterministicTime\":" << response.deterministic_time();
  json << ",\"conflicts\":" << response.num_conflicts();
  json << ",\"branches\":" << response.num_branches();
  json << ",\"booleans\":" << response.num_booleans();
  json << '}';
  return json.str();
}

char* CopyForJavaScript(const std::string& value) {
  auto* copy = static_cast<char*>(std::malloc(value.size() + 1));
  if (copy == nullptr) return nullptr;
  std::memcpy(copy, value.data(), value.size());
  copy[value.size()] = '\0';
  return copy;
}

}  // namespace

extern "C" EMSCRIPTEN_KEEPALIVE char* cpsat_solve(
    int case_id, double deterministic_limit, const void* model_bytes, int model_size) {
  if (!std::isfinite(deterministic_limit) || deterministic_limit <= 0 ||
      deterministic_limit > 1) {
    return CopyForJavaScript("{\"error\":\"deterministic limit must be finite and in (0, 1]\"}");
  }
  const double bounded_limit = deterministic_limit;
  if (case_id == kSmallCase) return CopyForJavaScript(ToJson(SolveSmall(bounded_limit)));
  if (case_id == kHardCase) return CopyForJavaScript(ToJson(SolveHard(bounded_limit, false)));
  if (case_id == kHardSearchCase) return CopyForJavaScript(ToJson(SolveHard(bounded_limit, true)));
  if (case_id == kModelCase) {
    CpModelProto proto;
    if (model_bytes == nullptr || model_size <= 0 || model_size > 1048576 ||
        !proto.ParseFromArray(model_bytes, model_size) ||
        proto.variables_size() > 8192 || proto.constraints_size() > 40000) {
      return CopyForJavaScript("{\"error\":\"invalid or oversized model proto\"}");
    }
    Model solver;
    solver.Add(NewSatParameters(SingleThreadParameters(bounded_limit)));
    const CpSolverResponse response = SolveCpModel(proto, &solver);
    SolveResult result{
        .case_name = "model",
        .response = response,
        .solution = {},
        .model_variables = proto.variables_size(),
        .model_constraints = proto.constraints_size(),
        .requested_deterministic_limit = bounded_limit,
    };
    if (response.status() == CpSolverStatus::OPTIMAL ||
        response.status() == CpSolverStatus::FEASIBLE) {
      result.solution.assign(response.solution().begin(), response.solution().end());
    }
    return CopyForJavaScript(ToJson(result));
  }
  return CopyForJavaScript("{\"error\":\"unknown case\"}");
}
