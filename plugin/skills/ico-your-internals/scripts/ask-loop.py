#!/usr/bin/env python3
"""
ask-loop.py — execute the ask phase of a dog-food run.

Replaces the inline `python3 - <<PY` heredoc that lived in run.sh through
v0.1. Extraction is required because the v0.2 schema (ADR-029) makes the
ask loop iterate over (intent, paraphrase) pairs via bank.py's
iter_prompts() — much harder to keep readable inside a bash heredoc.

Reads the question bank via bank.load_bank() + bank.iter_prompts(). For
each prompt, calls `ico --workspace WS --json ask <text>` and writes one
receipt line to receipts.jsonl with intent_id + paraphrase_idx +
paraphrase_text + paraphrase_style stamped on every receipt (per the
receipt-schema update for v0.2).

The runtime mode (--paraphrases primary|all) is owned by run.sh; this
script just receives whichever mode was selected and forwards it to
iter_prompts. Default 'primary' matches v0.1 cost shape.

Usage (called from run.sh, not invoked directly by operators):
    ask-loop.py <bank_path> <ws> <cache_root> <pub_dir> <run_id> <mode>

Exit codes:
    0  — receipts written (possibly with per-prompt friction entries)
    2  — argument shape wrong
    3  — bank failed to load
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from bank import BankSchemaError, iter_prompts, load_bank  # noqa: E402


def _friction(path: pathlib.Path, payload: dict) -> None:
    with path.open("a") as f:
        f.write(json.dumps(payload) + "\n")


def main(argv: list[str]) -> int:
    if len(argv) != 7:
        print(
            "usage: ask-loop.py <bank_path> <ws> <cache_root> <pub_dir> "
            "<run_id> <mode>",
            file=sys.stderr,
        )
        return 2
    _, bank_path, ws, cache_root, pub_dir, run_id, mode = argv

    try:
        bank = load_bank(bank_path)
    except (BankSchemaError, FileNotFoundError) as exc:
        print(f"bank load failed: {exc}", file=sys.stderr)
        return 3

    receipts_path = pathlib.Path(cache_root) / "receipts.jsonl"
    friction_path = pathlib.Path(pub_dir) / "friction.jsonl"

    for prompt in iter_prompts(bank, mode=mode):
        intent_id = prompt["intent_id"]
        paraphrase_idx = prompt["paraphrase_idx"]
        text = prompt["text"]
        started = time.time()

        # IMPORTANT: --workspace and --json are GLOBAL flags. They go BEFORE
        # the subcommand. `ico ask "..." --workspace ... --json` silently
        # drops both flags and falls back to defaults. Anti-pattern caught
        # in the v0.1 first real run; test_run_sh.sh pins the shape.
        try:
            result = subprocess.run(
                ["ico", "--workspace", ws, "--json", "ask", text],
                capture_output=True,
                text=True,
                timeout=180,
            )
        except subprocess.TimeoutExpired:
            _friction(
                friction_path,
                {
                    "run_id": run_id,
                    "intent_id": intent_id,
                    "paraphrase_idx": paraphrase_idx,
                    "stage": "ask",
                    "severity": "error",
                    "message": "ico ask timed out (>180s)",
                    "recommend_bead": True,
                },
            )
            continue

        elapsed_ms = int((time.time() - started) * 1000)

        if result.returncode != 0:
            stderr_tail = (
                (result.stderr or "ico ask non-zero exit").strip().splitlines()
            )
            _friction(
                friction_path,
                {
                    "run_id": run_id,
                    "intent_id": intent_id,
                    "paraphrase_idx": paraphrase_idx,
                    "stage": "ask",
                    "severity": "error",
                    "message": stderr_tail[-1] if stderr_tail else "ico ask non-zero exit",
                    "exit_code": result.returncode,
                    "recommend_bead": True,
                },
            )
            continue

        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            _friction(
                friction_path,
                {
                    "run_id": run_id,
                    "intent_id": intent_id,
                    "paraphrase_idx": paraphrase_idx,
                    "stage": "ask",
                    "severity": "error",
                    "message": "ico ask returned non-JSON stdout",
                    "recommend_bead": True,
                },
            )
            continue

        receipt = {
            "run_id": run_id,
            # q_id retained for backward compat with verify.py + render-summary
            # readers that still look at q_id. intent_id is the v0.2 canonical
            # name and both are written so older tools keep working.
            "q_id": intent_id,
            "intent_id": intent_id,
            "paraphrase_idx": paraphrase_idx,
            "paraphrase_text": text,
            "paraphrase_style": prompt["style"],
            "primary": prompt["primary"],
            "question": text,
            "answer": payload.get("answer", ""),
            "citations": payload.get("citations", []),
            "trace_correlation_id": payload.get("correlation_id"),
            "tokens_in": payload.get("tokens_in"),
            "tokens_out": payload.get("tokens_out"),
            "latency_ms": elapsed_ms,
            "model": payload.get("model"),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "expected_substrings": prompt["expected_substrings"],
            "expected_sources": prompt["expected_sources"],
        }
        with receipts_path.open("a") as f:
            f.write(json.dumps(receipt) + "\n")

    return 0


def plan_count(bank_path: str, mode: str) -> int:
    """How many asks would be made for this bank in this mode. Used by
    run.sh --dry to surface 'asks_planned' in the budget payload."""
    bank = load_bank(bank_path)
    return sum(1 for _ in iter_prompts(bank, mode=mode))


if __name__ == "__main__":
    # Subcommand surface: pure script + a `plan` helper for --dry.
    if len(sys.argv) >= 2 and sys.argv[1] == "plan":
        if len(sys.argv) != 4:
            print("usage: ask-loop.py plan <bank_path> <mode>", file=sys.stderr)
            sys.exit(2)
        try:
            print(plan_count(sys.argv[2], sys.argv[3]))
            sys.exit(0)
        except (BankSchemaError, FileNotFoundError) as exc:
            print(f"plan failed: {exc}", file=sys.stderr)
            sys.exit(3)
    sys.exit(main(sys.argv))
