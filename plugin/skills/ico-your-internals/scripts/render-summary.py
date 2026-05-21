#!/usr/bin/env python3
"""
render-summary.py — turn JSONL streams from a run into the public summary
artifacts (summary.md + metrics.json) and append one row to progress.md.

Reads from ~/.cache/ico-your-internals/runs/<run-id>/:
  - manifest.json
  - receipts.jsonl (local-only — extracts counts/citations, never raw answer)
  - verifications.jsonl
  - friction.jsonl (may also exist in public_dir already)
  - verify-summary.json (from verify.py)

Writes into <repo>/dogfood/runs/<run-id>/:
  - summary.md
  - metrics.json
  - friction.jsonl (copy/merge from cache)

Appends one row to <repo>/dogfood/progress.md.

Usage:
    render-summary.py <run-id> [--cache-root PATH] [--repo-root PATH]
"""
import argparse
import json
import os
import pathlib
import sys
from typing import Any


PROGRESS_HEADER_PATTERN = "| run_id "


def safe_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    return [
        json.loads(line)
        for line in path.read_text().splitlines()
        if line.strip()
    ]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_id")
    ap.add_argument(
        "--cache-root",
        default=os.path.expanduser("~/.cache/ico-your-internals/runs"),
    )
    ap.add_argument("--repo-root", default=os.getcwd())
    args = ap.parse_args()

    run_dir = pathlib.Path(args.cache_root) / args.run_id
    public_dir = pathlib.Path(args.repo_root) / "dogfood" / "runs" / args.run_id
    public_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads((run_dir / "manifest.json").read_text())
    receipts = safe_jsonl(run_dir / "receipts.jsonl")
    verifications = safe_jsonl(run_dir / "verifications.jsonl")
    cache_friction = safe_jsonl(run_dir / "friction.jsonl")
    pub_friction = safe_jsonl(public_dir / "friction.jsonl")

    # Merge friction (de-dup by stage+message)
    seen = set()
    merged_friction: list[dict[str, Any]] = []
    for entry in pub_friction + cache_friction:
        key = (entry.get("stage"), entry.get("message"))
        if key not in seen:
            seen.add(key)
            merged_friction.append(entry)
    (public_dir / "friction.jsonl").write_text(
        "\n".join(json.dumps(e) for e in merged_friction) + ("\n" if merged_friction else "")
    )

    # Per-question summary (counts only — no raw answers)
    q_summaries: list[dict[str, Any]] = []
    for r in receipts:
        q_id = r.get("q_id")
        v_for_q = [v for v in verifications if v.get("q_id") == q_id]
        verified = sum(1 for v in v_for_q if v.get("verdict") == "VERIFIED")
        challenged = sum(1 for v in v_for_q if v.get("verdict") == "CHALLENGED")
        unverified = sum(1 for v in v_for_q if v.get("verdict") == "UNVERIFIED")
        # Did the answer contain every expected_substring? (strong signal)
        expected = r.get("expected_substrings", []) or []
        answer_lower = (r.get("answer") or "").lower()
        substrings_hit = sum(1 for s in expected if s.lower() in answer_lower)
        q_summaries.append(
            {
                "q_id": q_id,
                "citations": len(r.get("citations") or []),
                "verified": verified,
                "challenged": challenged,
                "unverified": unverified,
                "expected_substrings": len(expected),
                "substrings_hit_in_answer": substrings_hit,
                "tokens_in": r.get("tokens_in"),
                "tokens_out": r.get("tokens_out"),
                "latency_ms": r.get("latency_ms"),
            }
        )

    total_citations = sum(q["citations"] for q in q_summaries)
    verified = sum(q["verified"] for q in q_summaries)
    challenged = sum(q["challenged"] for q in q_summaries)
    unverified = sum(q["unverified"] for q in q_summaries)
    verify_rate = round(verified / total_citations, 4) if total_citations else 0.0
    tokens_in = sum((q["tokens_in"] or 0) for q in q_summaries)
    tokens_out = sum((q["tokens_out"] or 0) for q in q_summaries)

    metrics = {
        "run_id": args.run_id,
        "target": manifest.get("target"),
        "target_slug": manifest.get("target_slug"),
        "bank_version": manifest.get("bank_version"),
        "ico_version": manifest.get("ico_version"),
        "started_at": manifest.get("started_at"),
        "questions": len(q_summaries),
        "total_citations": total_citations,
        "verified": verified,
        "challenged": challenged,
        "unverified": unverified,
        "verify_rate": verify_rate,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "friction_count": len(merged_friction),
        "per_question": q_summaries,
    }
    (public_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")

    # summary.md (no raw answer content)
    lines = [
        f"# Dog-food run summary — {args.run_id}",
        "",
        f"**Target**: `{manifest.get('target')}`",
        f"**Bank**: `{manifest.get('bank_path')}` (version {manifest.get('bank_version')})",
        f"**ICO version**: {manifest.get('ico_version')}",
        f"**Started**: {manifest.get('started_at')}",
        "",
        "## Headline",
        "",
        f"- Questions: **{len(q_summaries)}**",
        f"- Total citations: **{total_citations}**",
        f"- Verified: **{verified}**, Challenged: **{challenged}**, Unverified: **{unverified}**",
        f"- **Verify-rate: {verify_rate * 100:.1f}%**",
        f"- Tokens: {tokens_in} in / {tokens_out} out",
        f"- Friction entries: {len(merged_friction)}",
        "",
        "## Per-question signal",
        "",
        "| q_id | citations | verified | challenged | unverified | substrings_hit | tokens_in | tokens_out | latency_ms |",
        "|------|-----------|----------|------------|------------|----------------|-----------|------------|------------|",
    ]
    for q in q_summaries:
        lines.append(
            "| {q_id} | {citations} | {verified} | {challenged} | {unverified} | "
            "{substrings_hit_in_answer}/{expected_substrings} | "
            "{tokens_in} | {tokens_out} | {latency_ms} |".format(**q)
        )

    if merged_friction:
        lines += [
            "",
            "## Friction",
            "",
            "| stage | severity | message |",
            "|-------|----------|---------|",
        ]
        for f in merged_friction:
            lines.append(
                "| {stage} | {severity} | {message} |".format(
                    stage=f.get("stage", "?"),
                    severity=f.get("severity", "?"),
                    message=(f.get("message", "") or "").replace("|", "/"),
                )
            )

    lines += [
        "",
        "---",
        "_Raw receipts, source-grep evidence, and per-API-call cost remain in_",
        f"`~/.cache/ico-your-internals/runs/{args.run_id}/` _and are not committed._",
        "",
    ]
    (public_dir / "summary.md").write_text("\n".join(lines))

    # Append one row to progress.md
    progress_path = pathlib.Path(args.repo_root) / "dogfood" / "progress.md"
    if progress_path.is_file():
        progress_lines = progress_path.read_text().splitlines()
    else:
        progress_lines = []
    new_row = (
        f"| {args.run_id} | {manifest.get('target_slug', '?')} | {len(q_summaries)} | "
        f"{total_citations} | {verified} | {verify_rate * 100:.1f}% | "
        f"{tokens_in + tokens_out} | {len(merged_friction)} | "
        f"[summary](runs/{args.run_id}/summary.md) |"
    )
    # Replace the placeholder row if present; otherwise just append
    placeholder = "| _no runs yet"
    out_lines: list[str] = []
    placeholder_replaced = False
    for ln in progress_lines:
        if ln.startswith(placeholder) and not placeholder_replaced:
            out_lines.append(new_row)
            placeholder_replaced = True
        else:
            out_lines.append(ln)
    if not placeholder_replaced:
        out_lines.append(new_row)
    progress_path.write_text("\n".join(out_lines) + "\n")

    print(json.dumps({"public_dir": str(public_dir), "metrics": metrics}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
