#!/usr/bin/env python3
"""
compile-vs-rag experiment runner — bead zcc.4 v1.

Runs two retrieval conditions over a non-author corpus and grades each
question's answer against hand-authored expected_substrings:

  Condition A — RAG baseline (stuff all corpus into Claude context, ask)
  Condition B — ICO compile + ico ask (compile the corpus via ICO, query)

This is a v1 scaled-down version: 10 questions, 5-doc corpus. Future
expansions: bigger corpus, 100-question eval, statistical significance
test, third condition with INTKB-curated memory.

Grading: case-insensitive substring containment. The strong signal is
the hand-authored expected_substrings list per question — same scheme as
the dog-food verify.py.

Usage:
    python3 run.py                                    # both conditions
    python3 run.py --only rag                         # just RAG baseline
    python3 run.py --only ico                         # just ICO compile-then-ask
    python3 run.py --skip-compile                     # reuse existing ICO workspace

Outputs:
  - results.jsonl  — per-question results (raw)
  - results.md     — human-readable summary
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
from typing import Any

import yaml

THIS_DIR = pathlib.Path(__file__).resolve().parent
CORPUS_DIR = THIS_DIR / "corpus"
EVAL_FILE = THIS_DIR / "eval" / "questions.yaml"
# Resolve ICO_CLI relative to this script. The script lives at
# `<repo>/dogfood/experiments/compile-vs-rag/run.py`; the CLI dist lives at
# `<repo>/packages/cli/dist/index.js` — 3 levels up + into packages/.
# Override with $ICO_CLI for repo-out-of-tree invocation.
ICO_CLI = pathlib.Path(
    os.environ.get(
        "ICO_CLI",
        THIS_DIR.parent.parent.parent / "packages" / "cli" / "dist" / "index.js",
    )
)

CLAUDE_MODEL = os.environ.get("ICO_MODEL", "claude-sonnet-4-6")


def load_eval() -> dict[str, Any]:
    with EVAL_FILE.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_corpus() -> str:
    """Concatenate every corpus file into a single string for the RAG baseline."""
    files = sorted(CORPUS_DIR.glob("*.md"))
    parts: list[str] = []
    for fp in files:
        parts.append(f"\n\n=== {fp.name} ===\n")
        parts.append(fp.read_text(encoding="utf-8"))
    return "".join(parts)


def grade(answer: str, expected: list[str]) -> dict[str, Any]:
    """Case-insensitive substring containment grading."""
    answer_lower = answer.lower()
    hits = [sub for sub in expected if sub.lower() in answer_lower]
    return {
        "matched_count": len(hits),
        "expected_count": len(expected),
        "matched_substrings": hits,
        "verdict": "PASS" if len(hits) == len(expected) else ("PARTIAL" if hits else "FAIL"),
        "score": round(len(hits) / max(len(expected), 1), 3),
    }


def call_claude_rag(question: str, corpus: str) -> tuple[str, int]:
    """Condition A — stuff entire corpus into context, ask Claude."""
    from anthropic import Anthropic  # type: ignore
    client = Anthropic()
    prompt = (
        "You are answering a question about the Anthropic Python SDK.\n"
        "Use ONLY the corpus below as your source of truth.\n"
        "Quote relevant passages where helpful. Be concise.\n\n"
        f"CORPUS:\n{corpus}\n\n"
        f"QUESTION: {question}\n\n"
        "Answer:"
    )
    resp = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(b.text for b in resp.content if b.type == "text")
    return text, resp.usage.input_tokens + resp.usage.output_tokens


def call_ico_ask(workspace: pathlib.Path, question: str) -> tuple[str, int]:
    """Condition B — ask via the compiled ICO workspace."""
    proc = subprocess.run(
        ["node", str(ICO_CLI), "--workspace", str(workspace), "ask", question, "--json"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        return f"ICO_ASK_FAILED: {proc.stderr[:500]}", 0
    try:
        data = json.loads(proc.stdout)
        text = data.get("answer") or data.get("response") or proc.stdout
        tokens = data.get("tokens_used", 0)
        return text, tokens
    except Exception:
        return proc.stdout, 0


def setup_ico_workspace() -> pathlib.Path:
    """Create a fresh ICO workspace, mount + ingest the corpus, compile.

    Uses tempfile.mkdtemp() rather than a hardcoded /tmp prefix for
    platform independence (Windows tempdir, sandboxed CI runners with
    custom $TMPDIR, etc.). The slow `ico compile all` step streams
    stdout/stderr directly to the operator instead of buffering with
    capture_output=True — this is the 5-10 minute step and silent
    capture would make the run feel hung.
    """
    work_root = pathlib.Path(
        tempfile.mkdtemp(prefix=f"compile-vs-rag-ico-{int(time.time())}-")
    )
    print(f"[ICO setup] init workspace at {work_root}")
    subprocess.run(
        ["node", str(ICO_CLI), "init", "experiment", "--path", str(work_root)],
        check=True, capture_output=True, text=True,
    )
    workspace = work_root / "experiment"
    print(f"[ICO setup] mount corpus")
    subprocess.run(
        ["node", str(ICO_CLI), "--workspace", str(workspace), "mount", "add", "corpus", str(CORPUS_DIR)],
        check=True, capture_output=True, text=True,
    )
    print(f"[ICO setup] ingest each file")
    for md in sorted(CORPUS_DIR.glob("*.md")):
        subprocess.run(
            ["node", str(ICO_CLI), "--workspace", str(workspace), "ingest", str(md), "--yes"],
            check=False, capture_output=True, text=True,
        )
    print(f"[ICO setup] compile all (slow step — runs Claude, ~5-10 min)")
    print("[ICO setup] streaming compile output below:")
    # NOT capture_output=True: this step is slow (5-10 min) and silent
    # capture would make the run appear hung. Stream to the operator's
    # terminal so they can see the per-pass progress in real time.
    compile_proc = subprocess.run(
        ["node", str(ICO_CLI), "--workspace", str(workspace), "compile", "all"],
        check=False, timeout=600,
    )
    # check=False intentionally — a partial compile still produces useful
    # wiki content for the experiment (e.g. summarise-pass landed but
    # synthesise-pass failed on a rate-limit). But we MUST surface the
    # non-zero exit loudly so the operator knows the comparison is being
    # run against a degraded compile rather than a clean one.
    if compile_proc.returncode != 0:
        print(
            f"[ICO setup] ⚠ compile exited non-zero (rc={compile_proc.returncode}). "
            f"Experiment will run against whatever wiki content was produced; "
            f"results.md should note 'partial compile'.",
            file=sys.stderr,
        )
    return workspace


def run_experiment(only: str | None = None, ico_workspace: pathlib.Path | None = None) -> dict[str, Any]:
    eval_data = load_eval()
    corpus = load_corpus()
    results: list[dict[str, Any]] = []

    if (only is None or only == "ico") and ico_workspace is None:
        ico_workspace = setup_ico_workspace()

    rag_pass = rag_partial = rag_fail = 0
    ico_pass = ico_partial = ico_fail = 0
    rag_total_tokens = ico_total_tokens = 0
    rag_total_latency = ico_total_latency = 0.0

    for q in eval_data["questions"]:
        qid = q["id"]
        question = q["question"]
        expected = q["expected_substrings"]
        row: dict[str, Any] = {"q_id": qid, "question": question, "expected": expected}

        if only is None or only == "rag":
            t0 = time.time()
            try:
                rag_answer, rag_tokens = call_claude_rag(question, corpus)
                rag_grade = grade(rag_answer, expected)
                rag_latency = time.time() - t0
                rag_total_tokens += rag_tokens
                rag_total_latency += rag_latency
                if rag_grade["verdict"] == "PASS":
                    rag_pass += 1
                elif rag_grade["verdict"] == "PARTIAL":
                    rag_partial += 1
                else:
                    rag_fail += 1
                row["rag"] = {
                    **rag_grade,
                    "tokens": rag_tokens,
                    "latency_s": round(rag_latency, 2),
                    "answer_preview": rag_answer[:200],
                }
                print(f"  [{qid} RAG] {rag_grade['verdict']:7} {rag_grade['matched_count']}/{rag_grade['expected_count']} ({rag_tokens}tok, {rag_latency:.1f}s)")
            except Exception as e:
                row["rag"] = {"verdict": "ERROR", "error": str(e)[:200]}
                rag_fail += 1
                print(f"  [{qid} RAG] ERROR: {e}")

        if only is None or only == "ico":
            t0 = time.time()
            try:
                ico_answer, ico_tokens = call_ico_ask(ico_workspace, question)  # type: ignore
                ico_grade = grade(ico_answer, expected)
                ico_latency = time.time() - t0
                ico_total_tokens += ico_tokens
                ico_total_latency += ico_latency
                if ico_grade["verdict"] == "PASS":
                    ico_pass += 1
                elif ico_grade["verdict"] == "PARTIAL":
                    ico_partial += 1
                else:
                    ico_fail += 1
                row["ico"] = {
                    **ico_grade,
                    "tokens": ico_tokens,
                    "latency_s": round(ico_latency, 2),
                    "answer_preview": ico_answer[:200],
                }
                print(f"  [{qid} ICO] {ico_grade['verdict']:7} {ico_grade['matched_count']}/{ico_grade['expected_count']} ({ico_tokens}tok, {ico_latency:.1f}s)")
            except Exception as e:
                row["ico"] = {"verdict": "ERROR", "error": str(e)[:200]}
                ico_fail += 1
                print(f"  [{qid} ICO] ERROR: {e}")

        results.append(row)

    total = len(results)
    summary = {
        "experiment": "compile-vs-rag",
        "version": "v1",
        "ico_workspace": str(ico_workspace) if ico_workspace else None,
        "question_count": total,
        "rag": {
            "pass": rag_pass, "partial": rag_partial, "fail": rag_fail,
            "score": round((rag_pass + 0.5 * rag_partial) / max(total, 1), 3),
            "total_tokens": rag_total_tokens,
            "avg_latency_s": round(rag_total_latency / max(total, 1), 2),
        },
        "ico": {
            "pass": ico_pass, "partial": ico_partial, "fail": ico_fail,
            "score": round((ico_pass + 0.5 * ico_partial) / max(total, 1), 3),
            "total_tokens": ico_total_tokens,
            "avg_latency_s": round(ico_total_latency / max(total, 1), 2),
        },
        "results": results,
    }
    return summary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["rag", "ico"], help="Run only one condition")
    ap.add_argument("--ico-workspace", help="Reuse an existing ICO workspace (skip mount/ingest/compile)")
    args = ap.parse_args()

    # Fail-fast on missing API key. BOTH conditions need it:
    #   - RAG baseline calls Claude directly via the anthropic SDK
    #   - ICO compile + ask invokes Claude through the kernel
    # Better to error here than burn time on workspace setup only to fail
    # at the first per-question call.
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "ANTHROPIC_API_KEY is not set in the environment. "
            "Both conditions (RAG baseline + ICO compile+ask) require it. "
            "Set the env var and re-run.",
            file=sys.stderr,
        )
        return 2

    if not ICO_CLI.is_file():
        print(f"ICO CLI not built. Run: cd {ICO_CLI.parent.parent.parent} && pnpm build", file=sys.stderr)
        return 2
    if not EVAL_FILE.is_file():
        print(f"Eval file missing: {EVAL_FILE}", file=sys.stderr)
        return 2

    ws = pathlib.Path(args.ico_workspace) if args.ico_workspace else None
    summary = run_experiment(only=args.only, ico_workspace=ws)

    out_jsonl = THIS_DIR / "results.jsonl"
    with out_jsonl.open("w") as f:
        for row in summary["results"]:
            f.write(json.dumps(row) + "\n")

    out_summary = THIS_DIR / "results-summary.json"
    summary_clean = {k: v for k, v in summary.items() if k != "results"}
    with out_summary.open("w") as f:
        json.dump(summary_clean, f, indent=2)

    print("\n=== Headline ===")
    print(json.dumps(summary_clean, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
