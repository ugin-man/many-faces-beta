#!/usr/bin/env python3
"""Run all three repetitions sequentially on one fixed CPU, retaining failures."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=ROOT / "work/face-search")
    parser.add_argument("--output", type=Path, default=ROOT / "work/face-search/experiment-v1")
    parser.add_argument("--python-dependencies", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Existing experiment directories must be preserved")
    args.output.mkdir(parents=True)
    environment = dict(os.environ)
    for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        environment[name] = "1"
    if args.python_dependencies:
        environment["PYTHONPATH"] = str(args.python_dependencies) + (os.pathsep + environment["PYTHONPATH"] if environment.get("PYTHONPATH") else "")
    affinity = sorted(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else []
    if affinity:
        os.sched_setaffinity(0, {affinity[0]})
    original_orders = json.loads((args.data / "orders.json").read_text())
    reversed_orders = {**original_orders, "orders": dict(reversed(list(original_orders["orders"].items())))}
    reversed_path = args.output / "orders-reversed.json"
    reversed_path.write_text(json.dumps(reversed_orders, indent=2) + "\n")
    record = {"started_unix": time.time(), "experiment_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "production_source_commit": json.loads((ROOT / "research/face-search/protocol.json").read_text())["source_commit"],
              "available_affinity": affinity, "measurement_affinity": [affinity[0]] if affinity else None,
              "repetitions": 3, "parallel_benchmarks": False, "steps": [], "completed": False}
    record_path = args.output / "execution.json"

    def save():
        record_path.write_text(json.dumps(record, indent=2, allow_nan=False) + "\n")

    save()
    try:
        for repeat in range(3):
            commands = {
                "python": [sys.executable, "research/face-search/benchmark.py", "--data", str(args.data.resolve()),
                           "--output", str((args.output / f"python-{repeat}").resolve()), "--repeat", str(repeat)],
                "current": ["node", "--max-old-space-size=4096", "research/face-search/benchmark-current.mjs",
                            "--data", str(args.data.resolve()), "--order-file", str((reversed_path if repeat % 2 else args.data / "orders.json").resolve()),
                            "--repetitions", "1", "--output", str((args.output / f"current-{repeat}.json").resolve())],
            }
            for kind in (["python", "current"] if repeat % 2 == 0 else ["current", "python"]):
                step = {"kind": kind, "repeat": repeat, "command": commands[kind], "started_unix": time.time()}
                record["steps"].append(step)
                save()
                print(json.dumps({"event": "step-start", "kind": kind, "repeat": repeat}), flush=True)
                with (args.output / f"{kind}-{repeat}.log").open("w") as logfile:
                    process = subprocess.Popen(commands[kind], cwd=ROOT, env=environment, stdout=subprocess.PIPE,
                                               stderr=subprocess.STDOUT, text=True, bufsize=1)
                    for line in process.stdout:
                        logfile.write(line)
                        logfile.flush()
                        print(line, end="", flush=True)
                    code = process.wait()
                step.update({"finished_unix": time.time(), "exit_code": code})
                save()
                if code:
                    raise RuntimeError(f"{kind} repeat {repeat} failed with exit code {code}")
        record.update({"completed": True, "finished_unix": time.time()})
        save()
        print(json.dumps({"event": "experiment-complete", "output": str(args.output)}), flush=True)
    except BaseException as error:
        record.update({"failure": {"type": type(error).__name__, "message": str(error)}, "finished_unix": time.time()})
        save()
        raise


if __name__ == "__main__":
    main()
