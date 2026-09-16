"""Local TS replay + cloud-only WASM solving. No native CpSolver is used."""
import json
import os
import select
import signal
import subprocess

from native_bridge import encode


class JsonProcess:
    def __init__(self, command):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, bufsize=1, start_new_session=True)
        try:
            self.ready = self.read()
            assert self.ready["kind"] == "ready"
        except BaseException:
            self.close()
            raise

    def read(self):
        if not select.select([self.process.stdout], [], [], 45)[0]:
            raise TimeoutError("Replay/transport protocol timed out after 45 seconds")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"Replay/transport exited: {self.process.poll()}")
        value = json.loads(line)
        if "error" in value:
            raise RuntimeError(value["error"])
        return value

    def send(self, value):
        self.process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def close(self):
        try:
            if self.process.poll() is None:
                self.send({"kind": "stop"})
                self.process.wait(timeout=2)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            pass
        finally:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=5)
            self.process.stdin.close()
            self.process.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def replay_process(corpus):
    return JsonProcess(["pnpm", "exec", "vite-node", "--config", "tools/preflight.vite.config.ts",
        "experiments/cpsat-workers/tuning/cli.ts", corpus])


def solver_process(version=None):
    return JsonProcess(["node", "experiments/cpsat-workers/tuning/cloud-bridge.mjs"] + ([version] if version else []))


def cloud_solve(transport, spec):
    transport.send({"kind": "solve", "model": spec, "protoBase64": encode(spec)})
    return transport.read()
