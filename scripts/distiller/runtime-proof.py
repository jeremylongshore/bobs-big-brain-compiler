#!/usr/bin/env python3
"""Validate compile outcomes instead of treating agent exit zero as proof."""

import argparse
import datetime as dt
import importlib.util
import hashlib
import fcntl
import re
import stat
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time


def records(path):
    if not Path(path).exists():
        return []
    result = []
    for line in Path(path).read_text().splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue  # Existing append-only history is retained; malformed rows prove nothing.
        if isinstance(row, dict):
            result.append(row)
    return result


def valid_record(row, date, mode):
    if row.get("date") != date or row.get("mode") != mode:
        return False
    window = row.get("window")
    expected_end = (dt.date.fromisoformat(date) + dt.timedelta(days=1)).isoformat()
    if not isinstance(window, dict) or window.get("start") != date or window.get("end") != expected_end:
        return False
    if mode == "digest":
        return row.get("govern") is None and isinstance(row.get("candidates"), list)
    govern = row.get("govern")
    if not isinstance(govern, dict) or govern.get("indexUpdated") is not True:
        return False
    for key in ("ingested", "promoted", "rejected", "duplicates", "flagged"):
        if type(govern.get(key)) is not int or govern[key] < 0:
            return False
    audit = row.get("audit_verify", row.get("auditVerify"))
    intact = isinstance(audit, str) and audit.lower().startswith("intact")
    intact = intact or (isinstance(audit, dict) and audit.get("ok") is True)
    return bool(intact)


def completed(path, date, mode):
    return any(valid_record(row, date, mode) for row in records(path))


def record_hash(row):
    return hashlib.sha256(json.dumps(row, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def decision_hash(path, date, mode):
    matching = [row for row in records(path) if valid_record(row, date, mode)]
    if not matching:
        return None
    return record_hash(matching[-1])


def verification_matches(digest, date, mode, receipts):
    try:
        receipt = json.loads((Path(receipts) / f"verified-{date}.json").read_text())
        return bool(digest and receipt.get("decision_sha256") == digest and
                    receipt.get("date") == date and receipt.get("mode") == mode and
                    receipt.get("event") == "compile_verified" and receipt.get("audit", {}).get("ok") is True)
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def verified(path, date, mode, receipts):
    try:
        return verification_matches(decision_hash(path, date, mode), date, mode, receipts)
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def clean_digest_nights(path, before, receipts):
    """Count distinct prior nights with a valid digest bound to its read proof."""
    cutoff = dt.date.fromisoformat(before)
    latest = {}
    for row in records(path):
        date = row.get("date")
        if not isinstance(date, str):
            continue
        try:
            parsed = dt.date.fromisoformat(date)
        except ValueError:
            continue
        if parsed.isoformat() != date or parsed >= cutoff:
            continue
        if valid_record(row, date, "digest"):
            # Match decision_hash's last-valid-record rule without re-reading
            # the entire methodology history once per date.
            latest[date] = row
    count = 0
    for date, row in latest.items():
        if row.get("error") is not None:
            continue
        digest = record_hash(row)
        if verification_matches(digest, date, "digest", receipts):
            count += 1
    return count


def mcp_read(config, name):
    spec = importlib.util.spec_from_file_location("nightly_c8", Path(__file__).with_name("c8-mcp.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    command, env = module.native_config(config)
    child = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, bufsize=1)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + 45

    def send(value):
        child.stdin.write(json.dumps(value) + "\n")
        child.stdin.flush()

    def response(identifier):
        while time.monotonic() < deadline:
            if not selector.select(max(0, deadline - time.monotonic())):
                break
            line = child.stdout.readline()
            if not line:
                raise ValueError("MCP ended before read proof")
            result = json.loads(line)
            if result.get("id") == identifier:
                if "error" in result:
                    raise ValueError("MCP rejected proof")
                return result["result"]
        raise ValueError("MCP proof timeout")

    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "nightly-proof", "version": "1"},
        }})
        response(1)
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": {}}})
        result = response(2)
        if result.get("isError"):
            raise ValueError("MCP proof tool failed")
        return json.loads(next(item["text"] for item in result["content"] if item.get("type") == "text"))
    finally:
        selector.close()
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()



PHASES = ("setup", "gather", "distill", "govern", "audit", "digest")
PHASE_PREFIX = "BBB_PHASE "


def phase_event(event, phase=None):
    """Append diagnostic progress, never evidence of a governed outcome.

    The wrapper supplies context, but every caller runs as the same OS user.
    Event/source labels describe the requested record, not authenticated caller
    identity. Even an end record reports entries, never phase completion.
    Local writers can alter the log or choose another writable destination.
    """
    required = ("LOG", "ATTEMPT", "DATE", "MODE", "DECISIONS", "DIGEST", "RECEIPTS")
    context = {key: os.environ.get("TEAMKB_PHASE_" + key, "") for key in required}
    if any(not value or len(value) > 4096 or any(ord(c) < 32 for c in value)
           for value in context.values()):
        raise ValueError("phase logging unavailable: missing or invalid wrapper context")
    if not re.fullmatch(r"[0-9a-f]{32}", context["ATTEMPT"]):
        raise ValueError("invalid phase attempt")
    if dt.date.fromisoformat(context["DATE"]).isoformat() != context["DATE"]:
        raise ValueError("invalid phase date")
    if context["MODE"] not in ("auto", "digest"):
        raise ValueError("invalid phase mode")
    if event == "phase" and phase not in PHASES:
        raise ValueError("invalid phase name")
    if event not in ("start", "phase", "end"):
        raise ValueError("invalid phase event")
    for key in ("LOG", "DECISIONS", "DIGEST", "RECEIPTS"):
        if not Path(context[key]).is_absolute():
            raise ValueError("phase paths must be absolute")
    row = {"event": event, "attempt": context["ATTEMPT"], "date": context["DATE"],
           "mode": context["MODE"], "at": dt.datetime.now(dt.timezone.utc).isoformat(),
           "source": "agent_reported" if event == "phase" else "wrapper",
           "meaning": "diagnostic_only", "attribution": "unverified"}
    # This helper alone refuses a missing/nonregular destination or a symlink
    # at the supplied final path. This is not a wrapper-wide path guarantee:
    # existing wrapper logging creates the log and follows its configured path.
    # Descriptor checks do not restrict other same-user processes or ancestors.
    fd = os.open(context["LOG"], os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "r+", encoding="utf-8", errors="replace") as log:
        if not stat.S_ISREG(os.fstat(log.fileno()).st_mode):
            raise ValueError("phase log must be a regular file")
        fcntl.flock(log.fileno(), fcntl.LOCK_EX)
        history = []
        # Bounded line reads avoid loading a transcript into memory. Only our
        # fixed-prefix records for this attempt participate in the diagnostic.
        while True:
            line = log.readline(32768)
            if not line:
                break
            if line.startswith(PHASE_PREFIX):
                try:
                    previous = json.loads(line[len(PHASE_PREFIX):])
                except ValueError:
                    continue
                if isinstance(previous, dict) and previous.get("attempt") == context["ATTEMPT"]:
                    history.append(previous)
                    if len(history) > 32:
                        raise ValueError("too many phase records for one attempt")
        names = [item.get("phase") for item in history if item.get("event") == "phase"]
        if event == "start":
            if history:
                raise ValueError("phase attempt already exists")
            row["artifacts"] = {key.lower(): context[key] for key in ("DECISIONS", "DIGEST", "RECEIPTS")}
        else:
            if not history or history[0].get("event") != "start" or any(item.get("event") == "end" for item in history):
                raise ValueError("phase attempt is not active")
            if event == "phase":
                row["phase"] = phase
                row["sequence_ok"] = len(names) < len(PHASES) and phase == PHASES[len(names)] and names == list(PHASES[:len(names)])
            else:
                row["entered"] = names
                row["missing"] = [name for name in PHASES if name not in names]
                row["sequence_ok"] = names == list(PHASES)
                row["last_entered"] = names[-1] if names else None
        log.write(PHASE_PREFIX + json.dumps(row, separators=(",", ":")) + "\n")
        log.flush()
        os.fsync(log.fileno())
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["completed", "verified", "verify", "pending", "audit", "clean-digest-count", "phase-start", "phase", "phase-end"])
    parser.add_argument("--decisions")
    parser.add_argument("--date")
    parser.add_argument("--mode", default="auto", choices=["auto", "digest"])
    parser.add_argument("--config")
    parser.add_argument("--output")
    parser.add_argument("--receipts-dir")
    parser.add_argument("--phase", choices=PHASES)
    args = parser.parse_args()
    if args.action in ("phase-start", "phase", "phase-end"):
        try:
            phase_event({"phase-start": "start", "phase": "phase", "phase-end": "end"}[args.action], args.phase)
        except (OSError, ValueError, TypeError):
            print("compile-proof: phase logging unavailable or invalid", file=sys.stderr)
            return 1
        return 0
    if args.action == "clean-digest-count":
        print(clean_digest_nights(args.decisions, args.date, args.receipts_dir))
        return 0
    if args.action == "completed":
        return 0 if completed(args.decisions, args.date, args.mode) else 1
    if args.action == "verified":
        return 0 if verified(args.decisions, args.date, args.mode, args.receipts_dir) else 1
    if args.action == "pending":
        end = dt.date.fromisoformat(args.date)
        # Keep current work first; bounded catch-up then repairs older missed nights.
        dates = [end, *(end - dt.timedelta(days=n) for n in range(6, 0, -1))]
        for date in dates:
            if not completed(args.decisions, date.isoformat(), args.mode):
                print(date.isoformat())
        return 0
    if args.action == "verify" and not completed(args.decisions, args.date, args.mode):
        raise ValueError("missing or invalid compile outcome")
    # A completed receipt is historical evidence, not a cache to overwrite after
    # its bound methodology decision changes. Mode graduation is a separate outcome.
    if args.action == "verify" and args.output and Path(args.output).exists():
        previous = json.loads(Path(args.output).read_text())
        if (previous.get("event") != "compile_verified" or previous.get("date") != args.date or
                (previous.get("mode") == args.mode and
                 previous.get("decision_sha256") != decision_hash(args.decisions, args.date, args.mode))):
            raise ValueError("previous verified decision changed; preserve evidence")
        if previous.get("mode") != args.mode:
            historical = Path(args.output).with_name(f"verified-{args.date}-{previous.get('mode')}.json")
            if not historical.exists():
                historical.write_bytes(Path(args.output).read_bytes())
    audit = mcp_read(args.config, "brain_audit_verify")
    if audit.get("ok") is not True or not isinstance(audit.get("totalEvents"), int):
        raise ValueError("live audit verification failed")
    receipt = {"event": "compile_verified", "date": args.date, "mode": args.mode,
               "decision_sha256": decision_hash(args.decisions, args.date, args.mode) if args.decisions else None,
               "verified_at": dt.datetime.now(dt.timezone.utc).isoformat(),
               "audit": {k: audit.get(k) for k in ("ok", "totalEvents", "tamperSignatures", "anchorBreaks", "anchorCount", "chainForks")}}
    if args.output:
        destination = Path(args.output)
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_text(json.dumps(receipt, sort_keys=True) + "\n")
        os.replace(temporary, destination)
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError, StopIteration):
        print("compile-proof: missing, invalid or unavailable outcome evidence", file=sys.stderr)
        raise SystemExit(1)
