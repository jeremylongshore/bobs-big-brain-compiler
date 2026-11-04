#!/usr/bin/env python3
"""Sanitized, local review-phase observations; never provider billing evidence."""

import argparse
import datetime as dt
import json
import math
import os
import re
import tempfile
import time
from pathlib import Path

MAX_BYTES = 1024 * 1024
MAX_COUNT = 10**12
PROVIDERS = {"minimax", "grok", "claude"}
TALLY = re.compile(
    r"reviewed ([0-9]{1,12}) · promoted ([0-9]{1,12}) · held ([0-9]{1,12}) · rejected ([0-9]{1,12})(?![0-9])(?: · refused-by-rules ([0-9]{1,12})(?![0-9]))?"
)
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def number(value, integer=False):
    """Reject booleans, nonfinite/negative values and implausibly large counters."""
    if type(value) not in ((int,) if integer else (int, float)):
        return None
    if value < 0 or value > MAX_COUNT or not math.isfinite(value):
        return None
    return value


def transcript_observations(path, offset):
    counts = None
    usage = {
        "input_tokens": None,
        "output_tokens": None,
        "cache_creation_input_tokens": None,
        "cache_read_input_tokens": None,
        "total_cost_usd": None,
    }
    source = "unavailable"
    try:
        with Path(path).open("rb") as stream:
            size = os.fstat(stream.fileno()).st_size
            if offset < 0 or offset > size:
                return counts, usage, source
            start = max(offset, size - MAX_BYTES)
            stream.seek(start)
            data = stream.read(MAX_BYTES).decode("utf-8", errors="replace")
        # A bounded tail may begin inside a prior line. Never interpret that fragment.
        if start > offset:
            data = data.partition("\n")[2]
    except (OSError, ValueError):
        return counts, usage, source
    for line in data.splitlines():
        line = ANSI.sub("", line).strip()
        matches = list(TALLY.finditer(line))
        if matches:
            groups = matches[-1].groups()
            counts = dict(
                zip(
                    ("reviewed", "promoted", "held", "rejected", "refused_by_rules"),
                    (int(value) if value is not None else None for value in groups),
                )
            )
        if not line.startswith("{"):
            continue
        try:
            result = json.loads(line)
        except (ValueError, RecursionError):
            continue
        if not isinstance(result, dict) or result.get("type") != "result":
            continue
        # A terminal client result is a report, not independently verified metering.
        # Replace, never sum streaming fragments or repeated terminal objects.
        raw = result.get("usage")
        raw = raw if isinstance(raw, dict) else {}
        usage = {
            key: number(raw.get(key), integer=True)
            for key in usage
            if key != "total_cost_usd"
        }
        usage["total_cost_usd"] = number(result.get("total_cost_usd"))
        source = (
            "cli_reported"
            if any(value is not None for value in usage.values())
            else "unavailable"
        )
    return counts, usage, source


def measurement(args):
    provider = args.provider if args.provider in PROVIDERS else "unknown"
    configured = args.configured if args.configured in PROVIDERS else "unknown"
    attempted = args.outcome != "skipped"
    try:
        target_date = dt.date.fromisoformat(args.target_date).isoformat()
        if target_date != args.target_date:
            target_date = None
    except ValueError:
        target_date = None
    elapsed = max(0, time.monotonic_ns() - args.started_ns) // 1_000_000
    counts, usage, usage_source = (
        transcript_observations(args.transcript, args.offset)
        if attempted
        else (
            None,
            {
                "input_tokens": None,
                "output_tokens": None,
                "cache_creation_input_tokens": None,
                "cache_read_input_tokens": None,
                "total_cost_usd": None,
            },
            "unavailable",
        )
    )
    return {
        "schema": "bbb-review-metrics/v1",
        "recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "target_date": target_date,
        "configured_provider": configured,
        "invoked_provider": provider if attempted else None,
        # Only the literal known invocation selection is retained. Never echo arbitrary env values.
        "selected_model": "MiniMax-M3"
        if attempted and provider == "minimax" and args.model == "MiniMax-M3"
        else None,
        "model_source": "invocation_selection"
        if attempted and provider == "minimax" and args.model == "MiniMax-M3"
        else "unavailable",
        "mode": "live" if args.mode == "auto" else "dry_run",
        "outcome": args.outcome,
        "skip_reason": args.reason
        if args.reason in {"no_token", "missing_config"}
        else None,
        "exit_code": args.exit_code if attempted else None,
        "elapsed_ms": elapsed,
        "elapsed_source": "monotonic_wrapper_phase",
        "candidate_counts": counts,
        "candidate_counts_source": "agent_reported_text" if counts else "unavailable",
        "usage": usage,
        "usage_source": usage_source,
        "usage_unavailable_reason": "no_supported_terminal_usage_in_bounded_invocation_transcript"
        if usage_source == "unavailable"
        else None,
    }


def main():
    if len(os.sys.argv) == 2 and os.sys.argv[1] == "clock":
        print(time.monotonic_ns())
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--target-date", default="")
    parser.add_argument("--started-ns", type=int, required=True)
    parser.add_argument("--configured", required=True)
    parser.add_argument("--provider", default="unknown")
    parser.add_argument("--model", default="")
    parser.add_argument("--mode", required=True)
    parser.add_argument(
        "--outcome", choices=("success", "failed", "timeout", "skipped"), required=True
    )
    parser.add_argument("--reason", default="")
    parser.add_argument("--exit-code", type=int, default=0)
    parser.add_argument("--transcript", default="")
    parser.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()
    directory = Path(args.directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = json.dumps(measurement(args), allow_nan=False, sort_keys=True) + "\n"
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=directory,
            prefix=".review-metrics-",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / (temporary.stem.lstrip(".") + ".json"))
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
