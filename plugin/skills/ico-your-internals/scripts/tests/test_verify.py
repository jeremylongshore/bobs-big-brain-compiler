#!/usr/bin/env python3
"""
Unit tests for verify.py.

Uses stdlib unittest so the test surface is dependency-free: any box with
python3 ≥ 3.10 can run these. The tests target the Gemini PR #77 review
fixes specifically — every bug Gemini caught has a regression test here
so it can't silently come back.

Run from repo root:
    python3 -m unittest plugin.skills.ico-your-internals.scripts.tests.test_verify

Or directly:
    python3 plugin/skills/ico-your-internals/scripts/tests/test_verify.py
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = (
    pathlib.Path(__file__).resolve().parent.parent / "verify.py"
)


def make_run(tmp: pathlib.Path, target: pathlib.Path, receipts: list[dict]) -> str:
    """Build a minimal run-cache layout that verify.py can consume."""
    run_id = "test-run"
    run_dir = tmp / "cache" / run_id
    run_dir.mkdir(parents=True)
    (run_dir / "manifest.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
                "target": str(target),
                "target_slug": target.name,
                "bank_version": "v1",
                "ico_version": "test",
                "started_at": "2026-05-21T00:00:00Z",
                "workspace": str(tmp / "workspace"),
                "public_dir": str(tmp / "pub"),
            }
        )
    )
    receipts_path = run_dir / "receipts.jsonl"
    receipts_path.write_text("\n".join(json.dumps(r) for r in receipts) + "\n")
    return run_id


def run_verify(tmp: pathlib.Path, run_id: str, target: pathlib.Path) -> dict:
    """Invoke verify.py and return the summary dict it prints."""
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            run_id,
            "--cache-root",
            str(tmp / "cache"),
            "--target",
            str(target),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestSnippetCentering(unittest.TestCase):
    """Gemini PR #77 finding #4: evidence truncation at char 200 could
    omit the actual match on long lines. Fix centers ±100 chars on the
    match position. Regression test ensures the match stays visible."""

    def test_match_past_char_200_appears_in_evidence(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()

            # Single long line. Match at character ~350.
            prefix = "x" * 340
            match = "scoring rubric"
            suffix = "y" * 100
            (target / "doc.md").write_text(prefix + match + suffix)

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q01",
                        "question": "test",
                        "answer": "see doc",
                        "citations": [{"source": "doc.md"}],
                        "expected_substrings": [match],
                        "expected_sources": ["doc.md"],
                    }
                ],
            )

            run_verify(tmp, run_id, target)
            verifications = (
                (tmp / "cache" / run_id / "verifications.jsonl")
                .read_text()
                .strip()
                .splitlines()
            )
            self.assertEqual(len(verifications), 1)
            entry = json.loads(verifications[0])
            self.assertEqual(entry["verdict"], "VERIFIED")
            evidence = entry["hits"][0]["evidence_grep"]
            self.assertIn(
                match,
                evidence,
                f"Match '{match}' should be visible in centered evidence snippet, got: {evidence!r}",
            )


class TestPruneParts(unittest.TestCase):
    """Gemini PR #77 finding #2: rglob fallback was traversing
    node_modules/.git/etc. Fix added PRUNE_PARTS filter. Regression
    test ensures pruned dirs are skipped."""

    def test_node_modules_copy_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()

            # The "real" doc.md has the expected substring; the
            # node_modules copy does NOT. If PRUNE_PARTS is broken,
            # rglob might find the node_modules copy first and verify
            # would CHALLENGE the citation. With the fix, it should
            # find the real one and VERIFY.
            (target / "real-doc.md").write_text("real content with marker_text inside")
            nm_dir = target / "node_modules" / "some-package"
            nm_dir.mkdir(parents=True)
            (nm_dir / "real-doc.md").write_text("vendor stub without the marker")

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q01",
                        "question": "test",
                        "answer": "see real-doc.md",
                        "citations": [{"source": "real-doc.md"}],
                        "expected_substrings": ["marker_text"],
                        "expected_sources": ["real-doc.md"],
                    }
                ],
            )

            run_verify(tmp, run_id, target)
            verifications = (
                (tmp / "cache" / run_id / "verifications.jsonl")
                .read_text()
                .strip()
                .splitlines()
            )
            entry = json.loads(verifications[0])
            self.assertEqual(
                entry["verdict"],
                "VERIFIED",
                "Real doc.md should be found, not the node_modules copy",
            )

    def test_dist_directory_is_skipped(self):
        """PRUNE_PARTS also covers dist/, coverage/, .git/, etc."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()

            # Only the dist copy exists; expected substring is NOT in it.
            # Verify should report UNVERIFIED (file not found in non-pruned
            # search), not CHALLENGED (file found in dist with miss).
            dist_dir = target / "dist"
            dist_dir.mkdir()
            (dist_dir / "build-artifact.md").write_text("compiled output")

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q01",
                        "question": "test",
                        "answer": "see build-artifact.md",
                        "citations": [{"source": "build-artifact.md"}],
                        "expected_substrings": ["wrong"],
                        "expected_sources": ["build-artifact.md"],
                    }
                ],
            )

            run_verify(tmp, run_id, target)
            verifications = (
                (tmp / "cache" / run_id / "verifications.jsonl")
                .read_text()
                .strip()
                .splitlines()
            )
            entry = json.loads(verifications[0])
            self.assertEqual(
                entry["verdict"],
                "UNVERIFIED",
                "dist/ should be pruned; file should not resolve",
            )


class TestCaseInsensitiveSubstring(unittest.TestCase):
    """The expected_substring match is case-insensitive (Gemini PR #77
    finding #3 hoisted .lower() out of the loop). Regression test
    confirms behavior, not perf."""

    def test_uppercase_substring_matches_lowercase_source(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            (target / "doc.md").write_text("lowercase content here")

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q01",
                        "question": "test",
                        "answer": "see doc",
                        "citations": [{"source": "doc.md"}],
                        "expected_substrings": ["LOWERCASE"],
                        "expected_sources": ["doc.md"],
                    }
                ],
            )

            run_verify(tmp, run_id, target)
            verifications = (
                (tmp / "cache" / run_id / "verifications.jsonl")
                .read_text()
                .strip()
                .splitlines()
            )
            entry = json.loads(verifications[0])
            self.assertEqual(entry["verdict"], "VERIFIED")


class TestVerdictMatrix(unittest.TestCase):
    """All three verdicts (VERIFIED / CHALLENGED / UNVERIFIED) on
    one run — sanity check on the verdict-decision logic."""

    def test_all_three_verdicts_in_one_run(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            (target / "real.md").write_text("contains marker_a here")
            (target / "missing-marker.md").write_text("nothing useful")
            # ghost.md does not exist on disk

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q-verified",
                        "question": "?",
                        "answer": "",
                        "citations": [{"source": "real.md"}],
                        "expected_substrings": ["marker_a"],
                    },
                    {
                        "run_id": "test-run",
                        "q_id": "Q-challenged",
                        "question": "?",
                        "answer": "",
                        "citations": [{"source": "missing-marker.md"}],
                        "expected_substrings": ["marker_z"],
                    },
                    {
                        "run_id": "test-run",
                        "q_id": "Q-unverified",
                        "question": "?",
                        "answer": "",
                        "citations": [{"source": "ghost.md"}],
                        "expected_substrings": ["anything"],
                    },
                ],
            )

            summary = run_verify(tmp, run_id, target)
            self.assertEqual(summary["verified"], 1)
            self.assertEqual(summary["challenged"], 1)
            self.assertEqual(summary["unverified"], 1)
            self.assertEqual(summary["total_citations"], 3)


class TestNoCitations(unittest.TestCase):
    """When ICO produces an answer with zero citations, that's
    treated as CHALLENGED (the question bank expected sourced answers)."""

    def test_zero_citations_is_challenged(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            (target / "doc.md").write_text("anything")

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q01",
                        "question": "?",
                        "answer": "no citations here",
                        "citations": [],
                        "expected_substrings": ["x"],
                    }
                ],
            )

            run_verify(tmp, run_id, target)
            verifications = (
                (tmp / "cache" / run_id / "verifications.jsonl")
                .read_text()
                .strip()
                .splitlines()
            )
            entry = json.loads(verifications[0])
            self.assertEqual(entry["verdict"], "CHALLENGED")
            self.assertEqual(entry["reason"], "no citations in answer")


if __name__ == "__main__":
    unittest.main(verbosity=2)
