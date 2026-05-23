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

    # Per-paraphrase summary (counts only — no raw answers).
    # Grouped by (intent_id, paraphrase_idx) per ADR-029 + ADR-030. v1
    # receipts default intent_id := q_id and paraphrase_idx := 0 so they
    # still produce one row per question.
    def _intent_key(rec: dict[str, Any]) -> tuple[str, int]:
        intent_id = rec.get("intent_id") or rec.get("q_id") or ""
        idx = rec.get("paraphrase_idx")
        return (str(intent_id), int(idx if idx is not None else 0))

    q_summaries: list[dict[str, Any]] = []
    paraphrase_verified: dict[tuple[str, int], bool] = {}

    for r in receipts:
        intent_id, paraphrase_idx = _intent_key(r)
        # Match this receipt's verifications by the same composite key so a
        # v2 bank with two paraphrases under the same intent doesn't smear
        # both paraphrases' citations into the same row.
        v_for_q = [
            v for v in verifications if _intent_key(v) == (intent_id, paraphrase_idx)
        ]
        verified_q = sum(1 for v in v_for_q if v.get("verdict") == "VERIFIED")
        challenged_q = sum(1 for v in v_for_q if v.get("verdict") == "CHALLENGED")
        unverified_q = sum(1 for v in v_for_q if v.get("verdict") == "UNVERIFIED")
        paraphrase_verified[(intent_id, paraphrase_idx)] = (
            paraphrase_verified.get((intent_id, paraphrase_idx), False)
            or verified_q > 0
        )

        # Did the answer contain every expected_substring? (strong signal)
        expected = r.get("expected_substrings", []) or []
        answer_lower = (r.get("answer") or "").lower()
        substrings_hit = sum(1 for s in expected if s.lower() in answer_lower)
        q_summaries.append(
            {
                "q_id": r.get("q_id"),
                "intent_id": intent_id,
                "paraphrase_idx": paraphrase_idx,
                "paraphrase_style": r.get("paraphrase_style") or "legacy",
                "primary": bool(r.get("primary", paraphrase_idx == 0)),
                "citations": len(r.get("citations") or []),
                "verified": verified_q,
                "challenged": challenged_q,
                "unverified": unverified_q,
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

    # paraphrase_robustness rollup. Side-by-side with verify_rate; never
    # composited. See ADR-030 § Decision.
    paraphrases_run = len(paraphrase_verified)
    paraphrases_robust = sum(1 for v in paraphrase_verified.values() if v)
    paraphrase_robustness = (
        round(paraphrases_robust / paraphrases_run, 4) if paraphrases_run else 0.0
    )

    # Count distinct intents (separate from paraphrases_run; useful for
    # honest progress.md when --paraphrases all multiplied the ask count).
    distinct_intents = len({key[0] for key in paraphrase_verified})

    metrics = {
        "run_id": args.run_id,
        "target": manifest.get("target"),
        "target_slug": manifest.get("target_slug"),
        "bank_version": manifest.get("bank_version"),
        "ico_version": manifest.get("ico_version"),
        "started_at": manifest.get("started_at"),
        "paraphrases_mode": manifest.get("paraphrases_mode"),
        "intents": distinct_intents,
        "questions": len(q_summaries),
        "total_citations": total_citations,
        "verified": verified,
        "challenged": challenged,
        "unverified": unverified,
        "verify_rate": verify_rate,
        "paraphrases_run": paraphrases_run,
        "paraphrases_robust": paraphrases_robust,
        "paraphrase_robustness": paraphrase_robustness,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "friction_count": len(merged_friction),
        "per_question": q_summaries,
    }
    (public_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")

    # summary.md (no raw answer content)
    paraphrases_mode = manifest.get("paraphrases_mode") or "legacy"
    lines = [
        f"# Dog-food run summary — {args.run_id}",
        "",
        f"**Target**: `{manifest.get('target')}`",
        f"**Bank**: `{manifest.get('bank_path')}` (version {manifest.get('bank_version')})",
        f"**ICO version**: {manifest.get('ico_version')}",
        f"**Started**: {manifest.get('started_at')}",
        f"**Paraphrases mode**: `{paraphrases_mode}`",
        "",
        "## Headline",
        "",
        f"- Intents: **{distinct_intents}**",
        f"- Paraphrases run: **{paraphrases_run}**",
        f"- Total citations: **{total_citations}**",
        f"- Verified: **{verified}**, Challenged: **{challenged}**, Unverified: **{unverified}**",
        f"- **Verify-rate: {verify_rate * 100:.1f}%**",
        f"- **Paraphrase robustness: {paraphrase_robustness * 100:.1f}%** "
        f"({paraphrases_robust}/{paraphrases_run} paraphrases surfaced ≥1 verified citation)",
        f"- Tokens: {tokens_in} in / {tokens_out} out",
        f"- Friction entries: {len(merged_friction)}",
        "",
        "_The two headline metrics answer different questions and are "
        "reported side-by-side per ADR-030 — never composited._",
        "",
        "## Per-paraphrase signal",
        "",
        "| intent_id | idx | style | primary | citations | verified | challenged | unverified | substrings_hit | tokens_in | tokens_out | latency_ms |",
        "|-----------|-----|-------|---------|-----------|----------|------------|------------|----------------|-----------|------------|------------|",
    ]
    for q in q_summaries:
        primary_mark = "✓" if q.get("primary") else ""
        lines.append(
            "| {intent_id} | {paraphrase_idx} | {paraphrase_style} | {primary_mark} | "
            "{citations} | {verified} | {challenged} | {unverified} | "
            "{substrings_hit_in_answer}/{expected_substrings} | "
            "{tokens_in} | {tokens_out} | {latency_ms} |".format(
                primary_mark=primary_mark, **q
            )
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
    # paraphrase_robustness column lives between verify_rate and tokens.
    # v1 runs (no paraphrases_mode in manifest) get an em-dash placeholder
    # so historical rows stay readable while the column exists.
    if paraphrases_run > 0:
        robustness_cell = f"{paraphrase_robustness * 100:.1f}%"
    else:
        robustness_cell = "—"
    mode_tag = (
        f" (`--paraphrases {paraphrases_mode}`)" if manifest.get("paraphrases_mode") else ""
    )
    new_row = (
        f"| {args.run_id} | {manifest.get('target_slug', '?')} | "
        f"{distinct_intents} | {paraphrases_run} | "
        f"{total_citations} | {verified} | {verify_rate * 100:.1f}% | "
        f"{robustness_cell} | {tokens_in + tokens_out} | {len(merged_friction)} | "
        f"[summary](runs/{args.run_id}/summary.md){mode_tag} |"
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
