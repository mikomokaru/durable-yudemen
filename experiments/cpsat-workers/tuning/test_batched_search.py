import importlib.util
import json
import pathlib
import tempfile
import unittest

from ConfigSpace import ConfigurationSpace, Integer
from smac import HyperparameterOptimizationFacade, Scenario
from smac.runhistory import TrialInfo, TrialValue

spec = importlib.util.spec_from_file_location("batched_cloud_search", pathlib.Path(__file__).with_name("search-cloud-batched.py"))
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)


class BatchSearchTests(unittest.TestCase):
    def test_history_round_robin_starts_longest_history_for_each_candidate(self):
        preferences = [{"a": 1}, {"a": 2}, {"a": 3}]
        jobs = search.history_jobs(preferences, ["heavy", "medium", "light"])
        self.assertEqual(jobs[:3], [(p, "heavy") for p in preferences])
        self.assertEqual(len(jobs), 9)

    def test_smac_ask_tell_reaches_model_based_batches_without_native_solver(self):
        defaults = json.loads(pathlib.Path(__file__).with_name("defaults.json").read_text())
        with tempfile.TemporaryDirectory(prefix="cpsat-smac-batch-test-") as output:
            space = ConfigurationSpace(seed=20260909)
            space.add([Integer(name, bounds=bounds, default=defaults[name]) for name, bounds in search.BOUNDS.items()])
            scenario = Scenario(space, deterministic=True, n_trials=12, seed=20260909, output_directory=pathlib.Path(output))
            initial = HyperparameterOptimizationFacade.get_initial_design(scenario, n_configs=2, max_ratio=1.0)
            smac = HyperparameterOptimizationFacade(scenario, initial_design=initial, logging_level=False)
            smac.tell(TrialInfo(config=space.get_default_configuration(), seed=20260909), TrialValue(cost=10000))
            origins = []
            for size in [2, 3, 3, 3]:
                infos = [smac.ask() for _ in range(size)]
                configs = [dict(info.config) for info in infos]
                self.assertEqual(len({json.dumps(p, sort_keys=True) for p in configs}), size)
                for info in infos:
                    origins.append(info.config.origin)
                    cost = sum((int(value) - defaults[name]) ** 2 for name, value in dict(info.config).items())
                    smac.tell(info, TrialValue(cost=cost))
            self.assertEqual(smac.runhistory.finished, 12)
            self.assertTrue(any("Search" in origin for origin in origins[2:]), origins)


if __name__ == "__main__":
    unittest.main()
