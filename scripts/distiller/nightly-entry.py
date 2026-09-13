#!/usr/bin/env python3
"""Bounded nightly reconciliation over durable pending dates and verified outcomes."""

import datetime as dt
import fcntl
import importlib.util
import json
import signal
import time
import os
from pathlib import Path
import subprocess
import sys


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("compile_proof", HERE / "runtime-proof.py")
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


def persist(path, dates):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"version": 1, "pending": sorted(dates)}) + "\n")
    os.replace(temporary, path)


def process_family(pid):
    """Snapshot Linux child identities, including descendants with their own session."""
    found = {}
    pending = [pid]
    while pending:
        current = pending.pop()
        if current in found:
            continue
        try:
            stat = Path(f"/proc/{current}/stat").read_text().rsplit(") ", 1)[1].split()
            found[current] = stat[19]  # Linux start-time ticks fence PID reuse.
            for children in Path(f"/proc/{current}/task").glob("*/children"):
                pending.extend(int(value) for value in children.read_text().split())
        except (OSError, ValueError, IndexError):
            continue  # A process exited between the snapshot reads.
    return found


def signal_family(family, sig):
    for pid, started in reversed(list(family.items())):
        try:
            current = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
            if current == started:
                os.kill(pid, sig)
        except (OSError, ValueError, IndexError):
            continue  # Already exited; never signal a reused PID.


def run_bounded(command, env, seconds, kill_grace=10):
    child = subprocess.Popen(command, env=env, start_new_session=True)
    try:
        return child.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        family = process_family(child.pid)
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass  # Exited at the deadline boundary.
        signal_family(family, signal.SIGTERM)
        # Keep tracking descendants during graceful exit, including nested PTYs.
        deadline = time.monotonic() + kill_grace
        while time.monotonic() < deadline:
            family.update(process_family(child.pid))
            if not any(Path(f"/proc/{pid}").exists() for pid in family):
                break
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        signal_family(family, signal.SIGKILL)
        child.wait()
        print(json.dumps({"event": "compile_run_deadline", "timeout_seconds": seconds,
                          "kill_grace_seconds": kill_grace}), flush=True)
        return 124


def main():
    os.umask(0o077)
    root = Path(os.environ.get("TEAMKB_COMPILE_LOG_DIR", str(Path.home() / ".local/state/teamkb-compile-daily")))
    root.mkdir(parents=True, exist_ok=True)
    explicit = os.environ.get("TEAMKB_COMPILE_DATE")
    target = explicit or (dt.date.today() - dt.timedelta(days=1)).isoformat()
    date = dt.date.fromisoformat(target)
    if target != date.isoformat() or date >= dt.date.today():
        raise ValueError("target must be a completed calendar day")
    run_timeout = int(os.environ.get("TEAMKB_COMPILE_RUN_TIMEOUT", "3000"))
    if not 1 <= run_timeout <= 86400:
        raise ValueError("run deadline must be between one and 86400 seconds")
    if explicit or os.environ.get("TEAMKB_COMPILE_DRYRUN"):
        return run_bounded(["bash", str(HERE / "teamkb-compile-daily.sh")], os.environ.copy(), run_timeout)
    mode_file = root / "mode"
    mode = os.environ.get("TEAMKB_COMPILE_MODE", mode_file.read_text().strip() if mode_file.exists() else "digest")
    if mode not in ("auto", "digest"):
        raise ValueError("invalid compile mode")
    decisions = Path.home() / ".claude/skills/teamkb-compile/methodology/decisions.jsonl"
    pending_file = root / "pending-dates.json"
    limit = int(os.environ.get("TEAMKB_COMPILE_MAX_DATES", "3"))
    if not 1 <= limit <= 7:
        raise ValueError("date limit must be between one and seven")
    with (root / "dispatch.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"event": "compile_dispatch", "outcome": "already-running"}))
            return 0
        pending = set()
        if pending_file.exists():
            data = json.loads(pending_file.read_text())
            if data.get("version") != 1 or not isinstance(data.get("pending"), list):
                raise ValueError("invalid pending state")
            for item in data["pending"]:
                parsed = dt.date.fromisoformat(item)
                if item != parsed.isoformat() or parsed >= dt.date.today():
                    raise ValueError("invalid pending date")
                pending.add(item)
        # Bootstrap one week only; already-persisted misses survive arbitrarily long outages.
        pending.update((date - dt.timedelta(days=n)).isoformat() for n in range(7))
        pending = {item for item in pending if not proof.verified(decisions, item, mode, root)}
        persist(pending_file, pending)
        ordered = ([target] if target in pending else []) + sorted(pending - {target})
        failure = False
        for item in ordered[:limit]:
            env = os.environ.copy()
            env["TEAMKB_COMPILE_DATE"] = item
            exit_code = run_bounded(["bash", str(HERE / "teamkb-compile-daily.sh")], env, run_timeout)
            # Recheck the business outcome, including a wrapper lock-skip with exit zero.
            if exit_code != 0 or not proof.verified(decisions, item, mode, root):
                failure = True
                break
            pending.remove(item)
            persist(pending_file, pending)
        outcome = "failed" if failure else "partial" if pending else "complete"
        print(json.dumps({"event": "compile_dispatch", "outcome": outcome,
                          "pending_count": len(pending), "limit": limit}))
        return 1 if failure else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError):
        print("compile-dispatch: invalid or unavailable persistent state", file=sys.stderr)
        raise SystemExit(1)
