import importlib.util
import pathlib
import threading
import unittest
from unittest.mock import patch

from cloud_transport import cloud_solve

spec = importlib.util.spec_from_file_location("cloud_search", pathlib.Path(__file__).with_name("search-cloud.py"))
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)


class CloudSearchTests(unittest.TestCase):
    def test_global_request_budget_is_shared_across_threads(self):
        budget = search.Budget(100, 100, 10, 20)
        claimed = []
        def claim():
            while True:
                try:
                    claimed.append(budget.reserve())
                except search.BudgetExpired:
                    return
        threads = [threading.Thread(target=claim) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(claimed), list(range(1, 81)))
        budget.validation()
        claim()
        self.assertEqual(sorted(claimed), list(range(1, 101)))

    def test_cancellation_and_time_limit_stop_before_request(self):
        budget = search.Budget(100, 100, 10, 20)
        budget.cancel.set()
        with self.assertRaises(search.BudgetExpired):
            budget.reserve()
        self.assertEqual(budget.attempts, 0)
        budget.validation()
        budget.deadline = 0
        with self.assertRaises(search.BudgetExpired):
            budget.reserve()
        self.assertEqual(budget.attempts, 0)

    def test_cloud_path_only_encodes_and_never_constructs_native_solver(self):
        class FakeTransport:
            def send(self, value):
                self.message = value
            def read(self):
                return {"status": "OPTIMAL", "solution": [0]}
        model = {"variables": [[0, 1]], "intervals": [], "constraints": [], "objective": [[0, 1]], "hints": [], "budget": .1}
        transport = FakeTransport()
        with patch("native_bridge.cp_model.CpSolver", side_effect=AssertionError("Native solver forbidden")):
            result = cloud_solve(transport, model)
        self.assertEqual(result["status"], "OPTIMAL")
        self.assertTrue(transport.message["protoBase64"])
        self.assertEqual(transport.message["kind"], "solve")

    def test_defaults_are_inside_all_twelve_search_ranges(self):
        defaults = __import__("json").loads(pathlib.Path(__file__).with_name("defaults.json").read_text())
        self.assertEqual(len(search.BOUNDS), 12)
        self.assertEqual(set(search.BOUNDS), set(defaults))
        for name, (low, high) in search.BOUNDS.items():
            self.assertLessEqual(low, defaults[name])
            self.assertLessEqual(defaults[name], high)


if __name__ == "__main__":
    unittest.main()
