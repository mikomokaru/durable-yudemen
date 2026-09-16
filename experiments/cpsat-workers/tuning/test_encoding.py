"""No native solver can accidentally enter the WASM serialization path."""
import base64
import unittest
from unittest.mock import patch
from native_bridge import encode


class EncodingTest(unittest.TestCase):
    def test_encoding_does_not_construct_a_solver(self):
        spec = {"variables": [[0, 10]], "intervals": [], "constraints": [],
                "objective": [[0, 1]], "hints": [[0, 0]], "budget": 0.04}
        with patch("native_bridge.cp_model.CpSolver", side_effect=AssertionError("Native solver forbidden")):
            first = encode(spec)
            self.assertEqual(first, encode(spec))
            self.assertTrue(base64.b64decode(first))


if __name__ == "__main__":
    unittest.main()
