import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from ConfigSpace import ConfigurationSpace, Integer
from smac import HyperparameterOptimizationFacade, Scenario
from smac.runhistory import TrialInfo, TrialValue

spec = importlib.util.spec_from_file_location("resume_cloud", pathlib.Path(__file__).with_name("resume-cloud.py"))
resume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume)


class ResumeCloudTests(unittest.TestCase):
    def test_wall_clock_stops_after_sleep_even_when_monotonic_does_not_advance(self):
        with patch.object(resume.time, "time", return_value=1000), patch.object(resume.time, "monotonic", return_value=100):
            budget = resume.ExtensionBudget(1000, 7200, 9481)
            self.assertEqual(budget.reserve(), 9482)
            with patch.object(resume.time, "time", return_value=7540):
                with self.assertRaises(resume.BudgetExpired):
                    budget.reserve()
                budget.validation()
                self.assertEqual(budget.reserve(), 9483)
            with patch.object(resume.time, "time", return_value=8140):
                with self.assertRaises(resume.BudgetExpired):
                    budget.reserve()

    def test_monotonic_deadline_stops_even_if_wall_clock_moves_back(self):
        with patch.object(resume.time, "time", return_value=1000), patch.object(resume.time, "monotonic", return_value=100):
            budget = resume.ExtensionBudget(1000, 7200, 9481)
            with patch.object(resume.time, "monotonic", return_value=6640):
                with self.assertRaises(resume.BudgetExpired):
                    budget.reserve()

    def test_restore_rejects_partial_and_non_default_holdout(self):
        entry = {"history": "train", "preferences": {"a": 2}, "result": {
            "completedItems": 3, "expectedItems": 3, "fallbackCount": 0, "fixedScore": 100,
            "solveCount": 2, "cloud": {"solves": 2, "validatedSolutions": 2}}}
        allowed = [{"a": 1}, {"a": 2}]
        self.assertEqual(resume.validate_entry(entry, allowed, ["train"], ["holdout"], {"a": 1}), resume.key({"a": 2}, "train"))
        entry["history"] = "holdout"
        with self.assertRaises(AssertionError):
            resume.validate_entry(entry, allowed, ["train"], ["holdout"], {"a": 1})
        entry["history"] = "train"
        entry["result"]["completedItems"] = 2
        with self.assertRaises(AssertionError):
            resume.validate_entry(entry, allowed, ["train"], ["holdout"], {"a": 1})

    def test_reconstructed_sobol_is_identical_before_or_after_baseline_tell(self):
        defaults = json.loads(pathlib.Path(__file__).with_name("defaults.json").read_text())
        def proposals(tell_first):
            with tempfile.TemporaryDirectory(prefix="cpsat-resume-test-") as directory:
                space = ConfigurationSpace(seed=20260909)
                space.add([Integer(name, bounds=bounds, default=defaults[name]) for name, bounds in resume.BOUNDS.items()])
                scenario = Scenario(space, deterministic=True, n_trials=12, seed=20260909, output_directory=pathlib.Path(directory))
                initial = HyperparameterOptimizationFacade.get_initial_design(scenario, n_configs=2, max_ratio=1.0)
                optimizer = HyperparameterOptimizationFacade(scenario, initial_design=initial, logging_level=False)
                if tell_first:
                    optimizer.tell(TrialInfo(config=space.get_default_configuration(), seed=20260909), TrialValue(cost=422132.92))
                return [dict(optimizer.ask().config) for _ in range(2)]
        self.assertEqual(proposals(False), proposals(True))


if __name__ == "__main__":
    unittest.main()
