#!/usr/bin/env python3
"""Validate compile outcomes instead of treating agent exit zero as proof."""

import argparse
import datetime as dt
import importlib.util
import hashlib
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


def decision_hash(path, date, mode):
    matching = [row for row in records(path) if valid_record(row, date, mode)]
    if not matching:
        return None
    return hashlib.sha256(json.dumps(matching[-1], sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verified(path, date, mode, receipts):
    try:
        receipt = json.loads((Path(receipts) / f"verified-{date}.json").read_text())
        digest = decision_hash(path, date, mode)
        return bool(digest and receipt.get("decision_sha256") == digest and
                    receipt.get("date") == date and receipt.get("mode") == mode and
                    receipt.get("event") == "compile_verified" and receipt.get("audit", {}).get("ok") is True)
    except (OSError, ValueError, TypeError, AttributeError):
        return False


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["completed", "verified", "verify", "pending", "audit"])
    parser.add_argument("--decisions")
    parser.add_argument("--date")
    parser.add_argument("--mode", default="auto", choices=["auto", "digest"])
    parser.add_argument("--config")
    parser.add_argument("--output")
    parser.add_argument("--receipts-dir")
    args = parser.parse_args()
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
