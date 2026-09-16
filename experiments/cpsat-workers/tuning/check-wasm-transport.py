"""Repeat captured WASM models in a fresh owned runtime; native solving is forbidden."""
import argparse
import hashlib
import json
import pathlib
from unittest.mock import patch

from wasm_transport import WasmTransport


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    data = (pathlib.Path(args.directory) / "captures.json").read_bytes()
    captures = json.loads(data)
    rows = []
    transport = WasmTransport()
    try:
        with patch("native_bridge.cp_model.CpSolver", side_effect=AssertionError("Native solver forbidden")):
            for index, entry in enumerate(captures):
                for repeat in range(2):
                    result = transport.solve(entry["model"])
                    for key in ("status", "objective", "solution", "deterministicTime"):
                        assert result[key] == entry["wasm"][key], f"Changed {key}: capture {index}, repeat {repeat}"
                    assert result["isolateId"] != entry["wasm"]["isolateId"], "Expected a fresh isolate"
                    rows.append({"capture": index, "repeat": repeat, "status": result["status"],
                                 "wasmMemoryBytes": result["wasmMemoryBytes"], "clientElapsedMs": result["clientElapsedMs"]})
    finally:
        transport.close()
    report = {"runtime": transport.ready, "captureSha256": hashlib.sha256(data).hexdigest(),
              "nativeSolverForbidden": True, "allRepeatedOutcomesIdentical": True, "rows": rows}
    with pathlib.Path(args.output).open("x") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")
    print(json.dumps({"requests": len(rows), "allRepeatedOutcomesIdentical": True, "nativeSolverForbidden": True}))


if __name__ == "__main__":
    main()
