#!/usr/bin/env python3
"""
verify.py — deterministic citation verification for a dog-food run.

Reads ~/.cache/ico-your-internals/runs/<run-id>/receipts.jsonl. For each
citation in each receipt, greps the cited source file for evidence
matching the question bank's `expected_substrings`. Writes one
verifications.jsonl line per (question, citation) pair.

Verdicts:
  VERIFIED    — cited source exists AND at least one expected_substring is
                findable in it via case-insensitive grep
  CHALLENGED  — cited source exists but no expected_substring matched
  UNVERIFIED  — cited source path does not resolve to a real file

The strong signal is the per-question substring match — that's the
hand-authored ground truth. The weaker signal is that the cited file
exists at all (catches hallucinated filenames).

Usage:
    verify.py <run-id> [--cache-root PATH] [--target PATH]
"""
import argparse
import json
import os
import pathlib
import sys
from typing import Any


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_id")
    ap.add_argument(
        "--cache-root",
        default=os.path.expanduser("~/.cache/ico-your-internals/runs"),
        help="Root of run cache (default: ~/.cache/ico-your-internals/runs)",
    )
    ap.add_argument(
        "--target",
        help="Target project path (default: read from manifest.json)",
    )
    args = ap.parse_args()

    run_dir = pathlib.Path(args.cache_root) / args.run_id
    if not run_dir.is_dir():
        print(f"run dir not found: {run_dir}", file=sys.stderr)
        return 2

    receipts_path = run_dir / "receipts.jsonl"
    if not receipts_path.is_file():
        print(f"receipts.jsonl not found: {receipts_path}", file=sys.stderr)
        return 2

    manifest = json.loads((run_dir / "manifest.json").read_text())
    target_root = pathlib.Path(args.target or manifest["target"]).expanduser().resolve()

    verifications_path = run_dir / "verifications.jsonl"
    verifications_path.unlink(missing_ok=True)

    total = 0
    verified = 0
    challenged = 0
    unverified = 0

    with receipts_path.open() as f, verifications_path.open("w") as out:
        for line in f:
            line = line.strip()
            if not line:
                continue
            receipt = json.loads(line)
            citations: list[Any] = receipt.get("citations", []) or []
            expected_substrings = receipt.get("expected_substrings", []) or []
            q_id = receipt["q_id"]

            if not citations:
                # ICO produced no citations — that's a CHALLENGED-equivalent
                # outcome since the question bank expected sourced answers.
                out.write(
                    json.dumps(
                        {
                            "run_id": receipt["run_id"],
                            "q_id": q_id,
                            "citation_idx": -1,
                            "claim_substring": None,
                            "cited_source": None,
                            "verdict": "CHALLENGED",
                            "reason": "no citations in answer",
                            "score": 0.0,
                        }
                    )
                    + "\n"
                )
                challenged += 1
                total += 1
                continue

            for idx, cite in enumerate(citations):
                source = (
                    cite.get("source") if isinstance(cite, dict) else cite
                )
                if not isinstance(source, str) or not source:
                    out.write(
                        json.dumps(
                            {
                                "run_id": receipt["run_id"],
                                "q_id": q_id,
                                "citation_idx": idx,
                                "claim_substring": None,
                                "cited_source": None,
                                "verdict": "UNVERIFIED",
                                "reason": "citation has no source field",
                                "score": 0.0,
                            }
                        )
                        + "\n"
                    )
                    unverified += 1
                    total += 1
                    continue

                source_path = (target_root / source).resolve()

                # Try multiple resolution strategies: as-is, basename-only,
                # and search target tree for matching filename.
                if not source_path.is_file():
                    matches = list(target_root.rglob(pathlib.Path(source).name))
                    matches = [m for m in matches if m.is_file()]
                    source_path = matches[0] if matches else None

                if not source_path or not source_path.is_file():
                    out.write(
                        json.dumps(
                            {
                                "run_id": receipt["run_id"],
                                "q_id": q_id,
                                "citation_idx": idx,
                                "claim_substring": None,
                                "cited_source": source,
                                "verdict": "UNVERIFIED",
                                "reason": "cited source not found in target tree",
                                "score": 0.0,
                            }
                        )
                        + "\n"
                    )
                    unverified += 1
                    total += 1
                    continue

                source_text = source_path.read_text(errors="replace")
                hits: list[dict[str, Any]] = []
                for sub in expected_substrings:
                    # Case-insensitive containment + capture the matching line.
                    idx_in_text = source_text.lower().find(sub.lower())
                    if idx_in_text >= 0:
                        line_start = source_text.rfind("\n", 0, idx_in_text) + 1
                        line_end = source_text.find("\n", idx_in_text)
                        line_end = (
                            line_end if line_end >= 0 else len(source_text)
                        )
                        line_text = source_text[line_start:line_end].strip()
                        line_no = source_text.count("\n", 0, idx_in_text) + 1
                        hits.append(
                            {
                                "substring": sub,
                                "line": line_no,
                                "evidence_grep": f"L{line_no}: {line_text[:200]}",
                            }
                        )

                if hits:
                    verdict = "VERIFIED"
                    score = round(len(hits) / max(len(expected_substrings), 1), 2)
                    verified += 1
                else:
                    verdict = "CHALLENGED"
                    score = 0.0
                    challenged += 1

                out.write(
                    json.dumps(
                        {
                            "run_id": receipt["run_id"],
                            "q_id": q_id,
                            "citation_idx": idx,
                            "cited_source": str(source_path.relative_to(target_root)),
                            "verdict": verdict,
                            "hits": hits,
                            "expected_substring_count": len(expected_substrings),
                            "matched_count": len(hits),
                            "score": score,
                        }
                    )
                    + "\n"
                )
                total += 1

    rate = (verified / total) if total else 0.0
    summary = {
        "run_id": args.run_id,
        "total_citations": total,
        "verified": verified,
        "challenged": challenged,
        "unverified": unverified,
        "verify_rate": round(rate, 4),
    }
    (run_dir / "verify-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
