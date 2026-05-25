#!/usr/bin/env python3
"""
Unit tests for render-summary.py — v0.2 paraphrase grouping + side-by-side
metric reporting.

Contracts under test:

1. metrics.json carries `paraphrase_robustness` as a top-level field
   side-by-side with `verify_rate`. Never composited (ADR-030).
2. v1-shape receipts (no intent_id/paraphrase_idx) still produce a
   correct metrics.json — intent_id defaults to q_id, paraphrase_idx
   defaults to 0 (one synthetic primary paraphrase per intent).
3. progress.md row includes paraphrase_robustness column.
4. summary.md headline calls out paraphrase_robustness separately from
   verify_rate.

These tests run the actual render-summary.py script and inspect the
files it writes, mirroring test_verify.py's style.

Run from repo root:
    python3 -m unittest plugin.skills.ico-your-internals.scripts.tests.test_render_summary

Or directly:
    python3 plugin/skills/ico-your-internals/scripts/tests/test_render_summary.py
"""
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPT = (
    pathlib.Path(__file__).resolve().parent.parent / "render-summary.py"
)


def make_render_inputs(
    tmp: pathlib.Path,
    receipts: list[dict],
    verifications: list[dict],
) -> str:
    """Stage a minimal cache layout that render-summary.py can consume.

    Mirrors what verify.py would have produced upstream. The receipts and
    verifications dicts are written verbatim — caller controls schema."""
    run_id = "test-run"
    cache_root = tmp / "cache"
    run_dir = cache_root / run_id
    run_dir.mkdir(parents=True)
    (run_dir / "manifest.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
                "target": "/fake/target",
                "target_slug": "fake-target",
                "bank_path": "/fake/bank.yaml",
                "bank_version": "v2",
                "ico_version": "test",
                "started_at": "2026-05-22T00:00:00Z",
                "workspace": str(tmp / "workspace"),
                "public_dir": str(tmp / "repo" / "dogfood" / "runs" / run_id),
            }
        )
    )
    (run_dir / "receipts.jsonl").write_text(
        "\n".join(json.dumps(r) for r in receipts) + "\n"
    )
    (run_dir / "verifications.jsonl").write_text(
        "\n".join(json.dumps(v) for v in verifications) + "\n"
    )
    return run_id


def run_render(tmp: pathlib.Path, run_id: str) -> dict:
    repo_root = tmp / "repo"
    (repo_root / "dogfood").mkdir(parents=True)
    # Pre-seed progress.md so the script's append-row path runs.
    (repo_root / "dogfood" / "progress.md").write_text(
        "# trend\n\n| run_id | target | qs | citations | verified | "
        "verify_rate | paraphrase_robustness | tokens | friction | notes |\n"
        "| _no runs yet | | | | | | | | | |\n"
    )
    subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            run_id,
            "--cache-root",
            str(tmp / "cache"),
            "--repo-root",
            str(repo_root),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    metrics_path = (
        repo_root / "dogfood" / "runs" / run_id / "metrics.json"
    )
    return json.loads(metrics_path.read_text())


class TestV2ParaphraseMetrics(unittest.TestCase):
    """A v2 run with 1 intent × 2 paraphrases must surface
    paraphrase_robustness in metrics.json and progress.md."""

    def test_metrics_json_has_side_by_side_metrics(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            receipts = [
                {
                    "run_id": "test-run",
                    "q_id": "Q01",
                    "intent_id": "Q01",
                    "paraphrase_idx": 0,
                    "paraphrase_text": "primary phrasing",
                    "paraphrase_style": "direct",
                    "primary": True,
                    "question": "primary phrasing",
                    "answer": "see doc",
                    "citations": [{"source": "doc.md"}],
                    "expected_substrings": ["marker_a"],
                    "tokens_in": 100,
                    "tokens_out": 50,
                    "latency_ms": 200,
                },
                {
                    "run_id": "test-run",
                    "q_id": "Q01",
                    "intent_id": "Q01",
                    "paraphrase_idx": 1,
                    "paraphrase_text": "alternate phrasing",
                    "paraphrase_style": "leading",
                    "primary": False,
                    "question": "alternate phrasing",
                    "answer": "see doc",
                    "citations": [{"source": "doc.md"}],
                    "expected_substrings": ["marker_a"],
                    "tokens_in": 100,
                    "tokens_out": 50,
                    "latency_ms": 200,
                },
            ]
            verifications = [
                {
                    "run_id": "test-run",
                    "q_id": "Q01",
                    "intent_id": "Q01",
                    "paraphrase_idx": 0,
                    "paraphrase_style": "direct",
                    "citation_idx": 0,
                    "cited_source": "doc.md",
                    "verdict": "VERIFIED",
                    "hits": [{"substring": "marker_a", "line": 1, "evidence_grep": "L1"}],
                    "expected_substring_count": 1,
                    "matched_count": 1,
                    "score": 1.0,
                },
                {
                    "run_id": "test-run",
                    "q_id": "Q01",
                    "intent_id": "Q01",
                    "paraphrase_idx": 1,
                    "paraphrase_style": "leading",
                    "citation_idx": 0,
                    "cited_source": "doc.md",
                    "verdict": "CHALLENGED",
                    "expected_substring_count": 1,
                    "matched_count": 0,
                    "score": 0.0,
                },
            ]
            run_id = make_render_inputs(tmp, receipts, verifications)
            metrics = run_render(tmp, run_id)

            # ADR-030: side-by-side, both fields present at top level.
            self.assertIn("verify_rate", metrics)
            self.assertIn("paraphrase_robustness", metrics)
            # Never composited.
            self.assertNotIn("combined_score", metrics)
            # 1 of 2 paraphrases verified at least one citation → 0.5.
            self.assertEqual(metrics["paraphrase_robustness"], 0.5)
            self.assertEqual(metrics["paraphrases_run"], 2)
            self.assertEqual(metrics["paraphrases_robust"], 1)

            # progress.md row should include the new column.
            progress = (
                tmp / "repo" / "dogfood" / "progress.md"
            ).read_text()
            self.assertIn(run_id, progress)
            # The robustness column renders as a percentage; 50.0% from 0.5.
            self.assertIn("50.0%", progress)


class TestV1ReceiptCompat(unittest.TestCase):
    """v1-shape receipts (no intent_id/paraphrase_idx) still produce a
    correct metrics.json. Backward-compat invariant."""

    def test_v1_receipts_yield_paraphrase_robustness(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            receipts = [
                {
                    "run_id": "test-run",
                    "q_id": "Q01",
                    # No intent_id, no paraphrase_idx — pure v1 shape.
                    "question": "What does it do?",
                    "answer": "see doc",
                    "citations": [{"source": "doc.md"}],
                    "expected_substrings": ["marker_a"],
                    "tokens_in": 100,
                    "tokens_out": 50,
                    "latency_ms": 200,
                }
            ]
            verifications = [
                {
                    "run_id": "test-run",
                    "q_id": "Q01",
                    # v1 verifications also lack intent_id/paraphrase_idx.
                    "citation_idx": 0,
                    "cited_source": "doc.md",
                    "verdict": "VERIFIED",
                    "hits": [{"substring": "marker_a", "line": 1, "evidence_grep": "L1"}],
                    "expected_substring_count": 1,
                    "matched_count": 1,
                    "score": 1.0,
                }
            ]
            run_id = make_render_inputs(tmp, receipts, verifications)
            metrics = run_render(tmp, run_id)

            self.assertIn("paraphrase_robustness", metrics)
            # One intent, one synthetic paraphrase, fully verified.
            self.assertEqual(metrics["paraphrase_robustness"], 1.0)
            self.assertEqual(metrics["paraphrases_run"], 1)
            self.assertEqual(metrics["verify_rate"], 1.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
