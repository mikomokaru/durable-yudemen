"""Offline protobuf encoding and local workerd transport; never solves natively."""
import json
import os
import select
import signal
import subprocess

from native_bridge import encode


class WasmTransport:
    def __init__(self, port=8792):
        self.process = subprocess.Popen(
            ["node", "experiments/cpsat-workers/tuning/wasm-bridge.mjs", str(port)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            bufsize=1, start_new_session=True,
        )
        try:
            self.ready = self.read()
            assert self.ready["kind"] == "ready" and self.ready["runtime"] == "wasm-workerd"
        except BaseException:
            self.close()
            raise

    def read(self):
        if not select.select([self.process.stdout], [], [], 45)[0]:
            raise TimeoutError("Local workerd transport timed out")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"Local workerd transport exited: {self.process.poll()}")
        value = json.loads(line)
        if "error" in value:
            raise RuntimeError(value["error"])
        return value

    def send(self, value):
        self.process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def solve(self, spec, capture=False):
        proto = encode(spec)
        self.send({"kind": "solve", "model": spec, "protoBase64": proto})
        result = self.read()
        if capture:
            result["protoBase64"] = proto
        return result

    def close(self):
        try:
            if self.process.poll() is None:
                self.send({"kind": "stop"})
                self.process.wait(timeout=3)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            pass
        finally:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=5)
