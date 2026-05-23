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


def make_run(
    tmp: pathlib.Path,
    target: pathlib.Path,
    receipts: list[dict],
    workspace: pathlib.Path | None = None,
) -> str:
    """Build a minimal run-cache layout that verify.py can consume.

    If ``workspace`` is provided, the manifest points there (matches how
    run.sh writes manifest.json with the actual ico workspace path). The
    workspace is where ICO's compiled wiki lives — verify.py must resolve
    ``wiki/...`` citation paths against it, NOT the target tree.
    """
    run_id = "test-run"
    run_dir = tmp / "cache" / run_id
    run_dir.mkdir(parents=True)
    ws = str(workspace) if workspace is not None else str(tmp / "workspace")
    (run_dir / "manifest.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
                "target": str(target),
                "target_slug": target.name,
                "bank_version": "v1",
                "ico_version": "test",
                "started_at": "2026-05-21T00:00:00Z",
                "workspace": ws,
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


class TestWikiPathResolution(unittest.TestCase):
    """h99 regression tests: ICO emits citation paths like
    'wiki/sources/foo.md' which live in the WORKSPACE cache (per the
    manifest.json `workspace` field), NOT in the TARGET tree. Pre-fix,
    verify.py greps the target tree and reports every wiki/-prefixed
    citation as UNVERIFIED, which makes verify_rate misleading-0% on
    successful dog-food runs."""

    def test_wiki_prefixed_citation_resolves_against_workspace_not_target(
        self,
    ) -> None:
        """A citation with source='wiki/sources/foo.md' must be looked up
        inside the workspace's wiki/ subdir. The substring is grepped
        against that wiki page, not against any target file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            # Target tree intentionally LACKS foo.md — proves the resolver
            # is hitting the workspace, not falling through to target.

            workspace = tmp / "workspace"
            wiki_sources = workspace / "wiki" / "sources"
            wiki_sources.mkdir(parents=True)
            (wiki_sources / "foo.md").write_text(
                "# foo\n\nThis page contains the marker_substring evidence.\n"
            )

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q01",
                        "question": "What is foo?",
                        "answer": "...",
                        "citations": [
                            {
                                "source": "wiki/sources/foo.md",
                                "title": "foo",
                                "verified": True,
                            }
                        ],
                        "expected_substrings": ["marker_substring"],
                    }
                ],
                workspace=workspace,
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
            self.assertEqual(
                entry["verdict"],
                "VERIFIED",
                f"wiki/-prefixed citation should resolve via workspace, got: {entry}",
            )
            self.assertGreater(len(entry["hits"]), 0)
            self.assertEqual(entry["hits"][0]["substring"], "marker_substring")

    def test_wiki_prefixed_citation_unverified_when_wiki_page_absent(self) -> None:
        """If wiki/sources/ghost.md doesn't exist in the workspace, the
        verdict is UNVERIFIED (not CHALLENGED — there's no source to grep)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            workspace = tmp / "workspace"
            (workspace / "wiki").mkdir(parents=True)
            # Notice: NO wiki/sources/ghost.md

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q01",
                        "question": "?",
                        "answer": "",
                        "citations": [{"source": "wiki/sources/ghost.md"}],
                        "expected_substrings": ["anything"],
                    }
                ],
                workspace=workspace,
            )

            run_verify(tmp, run_id, target)
            entry = json.loads(
                (tmp / "cache" / run_id / "verifications.jsonl").read_text().strip()
            )
            self.assertEqual(entry["verdict"], "UNVERIFIED")

    def test_wiki_prefixed_citation_challenged_when_substring_missing(
        self,
    ) -> None:
        """Wiki page exists in workspace but doesn't contain the
        expected_substring. CHALLENGED verdict — citation resolves, evidence
        is absent."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            workspace = tmp / "workspace"
            wiki_sources = workspace / "wiki" / "sources"
            wiki_sources.mkdir(parents=True)
            (wiki_sources / "foo.md").write_text("# foo\n\nUnrelated content.\n")

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q01",
                        "question": "?",
                        "answer": "",
                        "citations": [{"source": "wiki/sources/foo.md"}],
                        "expected_substrings": ["marker_substring"],
                    }
                ],
                workspace=workspace,
            )

            run_verify(tmp, run_id, target)
            entry = json.loads(
                (tmp / "cache" / run_id / "verifications.jsonl").read_text().strip()
            )
            self.assertEqual(entry["verdict"], "CHALLENGED")

    def test_non_wiki_citation_still_resolves_against_target_tree(self) -> None:
        """Backward compatibility: citations WITHOUT the `wiki/` prefix
        keep resolving against the target tree as before (older ICO output
        + other tools that emit raw source paths)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            (target / "doc.md").write_text("contains marker_substring inline\n")
            workspace = tmp / "workspace"
            workspace.mkdir()
            # No wiki/ — the citation should fall through to target resolution

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q01",
                        "question": "?",
                        "answer": "",
                        "citations": [{"source": "doc.md"}],
                        "expected_substrings": ["marker_substring"],
                    }
                ],
                workspace=workspace,
            )

            run_verify(tmp, run_id, target)
            entry = json.loads(
                (tmp / "cache" / run_id / "verifications.jsonl").read_text().strip()
            )
            self.assertEqual(entry["verdict"], "VERIFIED")

    def test_ico_verified_false_marks_unverified_even_if_path_resolves(
        self,
    ) -> None:
        """If ICO's own citation-verification flag is False, trust ICO's
        signal: the citation is marked UNVERIFIED regardless of whether
        the path happens to resolve. ICO's internal check is the strong
        signal here — it knows whether the title actually mapped to a wiki
        page during answer generation."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            workspace = tmp / "workspace"
            wiki_sources = workspace / "wiki" / "sources"
            wiki_sources.mkdir(parents=True)
            # Even though we write a file at the cited path, ICO told us
            # this citation is NOT verified — likely a hallucinated title
            # that incidentally matches a filename.
            (wiki_sources / "foo.md").write_text("marker_substring here\n")

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "q_id": "Q01",
                        "question": "?",
                        "answer": "",
                        "citations": [
                            {
                                "source": "wiki/sources/foo.md",
                                "title": "foo",
                                "verified": False,
                            }
                        ],
                        "expected_substrings": ["marker_substring"],
                    }
                ],
                workspace=workspace,
            )

            run_verify(tmp, run_id, target)
            entry = json.loads(
                (tmp / "cache" / run_id / "verifications.jsonl").read_text().strip()
            )
            self.assertEqual(entry["verdict"], "UNVERIFIED")
            self.assertIn("ICO", entry.get("reason", ""))


class TestParaphraseVariance(unittest.TestCase):
    """v0.2 paraphrase_robustness metric — see ADR-030.

    paraphrase_robustness = (# paraphrases that surfaced ≥1 VERIFIED citation)
                          / (# paraphrases run in this execution)

    Receipts in v0.2 carry intent_id + paraphrase_idx + paraphrase_text +
    paraphrase_style. verify.py must group citations by (intent_id,
    paraphrase_idx) and emit the new aggregate in verify-summary.json
    side-by-side with verify_rate (NEVER composited)."""

    def test_paraphrase_robustness_appears_in_summary(self):
        """The new field must be present in verify-summary.json alongside
        verify_rate. Side-by-side reporting per ADR-030."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            (target / "doc.md").write_text("contains marker_a\n")

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "intent_id": "Q01",
                        "paraphrase_idx": 0,
                        "paraphrase_text": "What does it do?",
                        "paraphrase_style": "direct",
                        "q_id": "Q01",  # carried for v1-compat readers
                        "question": "What does it do?",
                        "answer": "",
                        "citations": [{"source": "doc.md"}],
                        "expected_substrings": ["marker_a"],
                    }
                ],
            )
            summary = run_verify(tmp, run_id, target)
            self.assertIn("paraphrase_robustness", summary)
            self.assertIn("verify_rate", summary)
            self.assertNotIn(
                "combined_score",
                summary,
                "ADR-030 forbids compositing the two metrics",
            )

    def test_all_paraphrases_verified_yields_robustness_1(self):
        """Two paraphrases, both surface ≥1 VERIFIED citation → 1.0."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            (target / "doc.md").write_text("contains marker_a inside\n")

            receipts = [
                {
                    "run_id": "test-run",
                    "intent_id": "Q01",
                    "paraphrase_idx": idx,
                    "paraphrase_text": f"phrasing {idx}",
                    "paraphrase_style": "direct",
                    "q_id": "Q01",
                    "question": f"phrasing {idx}",
                    "answer": "",
                    "citations": [{"source": "doc.md"}],
                    "expected_substrings": ["marker_a"],
                }
                for idx in (0, 1)
            ]
            run_id = make_run(tmp, target, receipts)
            summary = run_verify(tmp, run_id, target)
            self.assertEqual(summary["paraphrase_robustness"], 1.0)
            self.assertEqual(summary["paraphrases_run"], 2)
            self.assertEqual(summary["paraphrases_robust"], 2)

    def test_one_of_two_paraphrases_robust(self):
        """Same intent, two paraphrases — one verifies, one doesn't.
        Robustness = 0.5. verify_rate is a separate quantity."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            (target / "good.md").write_text("contains marker_a\n")
            (target / "miss.md").write_text("does not contain it\n")

            receipts = [
                {
                    "run_id": "test-run",
                    "intent_id": "Q01",
                    "paraphrase_idx": 0,
                    "paraphrase_text": "good phrasing",
                    "paraphrase_style": "direct",
                    "q_id": "Q01",
                    "question": "?",
                    "answer": "",
                    "citations": [{"source": "good.md"}],
                    "expected_substrings": ["marker_a"],
                },
                {
                    "run_id": "test-run",
                    "intent_id": "Q01",
                    "paraphrase_idx": 1,
                    "paraphrase_text": "bad phrasing",
                    "paraphrase_style": "leading",
                    "q_id": "Q01",
                    "question": "?",
                    "answer": "",
                    "citations": [{"source": "miss.md"}],
                    "expected_substrings": ["marker_a"],
                },
            ]
            run_id = make_run(tmp, target, receipts)
            summary = run_verify(tmp, run_id, target)
            self.assertEqual(summary["paraphrase_robustness"], 0.5)
            self.assertEqual(summary["paraphrases_run"], 2)
            self.assertEqual(summary["paraphrases_robust"], 1)

    def test_paraphrase_robust_when_any_citation_under_it_verifies(self):
        """A paraphrase counts as robust if AT LEAST ONE of its citations
        verifies — not all of them. Numerator semantics per ADR-030."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            (target / "good.md").write_text("contains marker_a\n")
            (target / "miss.md").write_text("no match\n")

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "intent_id": "Q01",
                        "paraphrase_idx": 0,
                        "paraphrase_text": "p0",
                        "paraphrase_style": "direct",
                        "q_id": "Q01",
                        "question": "?",
                        "answer": "",
                        "citations": [
                            {"source": "good.md"},
                            {"source": "miss.md"},
                            {"source": "ghost.md"},  # unverified
                        ],
                        "expected_substrings": ["marker_a"],
                    }
                ],
            )
            summary = run_verify(tmp, run_id, target)
            self.assertEqual(summary["paraphrase_robustness"], 1.0)
            self.assertEqual(summary["paraphrases_robust"], 1)
            # And the citation-level metric still reports the mixed result.
            self.assertEqual(summary["verified"], 1)
            self.assertEqual(summary["challenged"], 1)
            self.assertEqual(summary["unverified"], 1)

    def test_per_paraphrase_emit_in_verifications_jsonl(self):
        """Every verification line must carry intent_id + paraphrase_idx +
        paraphrase_style so render-summary can group by them downstream."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            (target / "doc.md").write_text("contains marker_a\n")

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        "intent_id": "Q01",
                        "paraphrase_idx": 2,
                        "paraphrase_text": "phrasing 2",
                        "paraphrase_style": "leading",
                        "q_id": "Q01",
                        "question": "?",
                        "answer": "",
                        "citations": [{"source": "doc.md"}],
                        "expected_substrings": ["marker_a"],
                    }
                ],
            )
            run_verify(tmp, run_id, target)
            entry = json.loads(
                (tmp / "cache" / run_id / "verifications.jsonl").read_text().strip()
            )
            self.assertEqual(entry["intent_id"], "Q01")
            self.assertEqual(entry["paraphrase_idx"], 2)
            self.assertEqual(entry["paraphrase_style"], "leading")


class TestV1ReceiptCompat(unittest.TestCase):
    """v1 receipts (no intent_id / paraphrase_idx fields) must produce
    an equivalent summary to v2 receipts where each q_id maps to a single
    synthetic paraphrase (idx=0). Backward-compat invariant per the v0.2
    rollout plan — pre-v0.2 receipts in the field still verify correctly."""

    def test_v1_receipts_produce_equivalent_summary(self):
        """A v1-shape receipt (no intent_id/paraphrase_idx) is treated as
        intent_id=q_id, paraphrase_idx=0. Robustness math still works."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            target = tmp / "target"
            target.mkdir()
            (target / "doc.md").write_text("contains marker_a\n")

            run_id = make_run(
                tmp,
                target,
                [
                    {
                        "run_id": "test-run",
                        # No intent_id, no paraphrase_idx — pure v1 shape.
                        "q_id": "Q01",
                        "question": "?",
                        "answer": "",
                        "citations": [{"source": "doc.md"}],
                        "expected_substrings": ["marker_a"],
                    }
                ],
            )
            summary = run_verify(tmp, run_id, target)
            self.assertEqual(summary["paraphrase_robustness"], 1.0)
            self.assertEqual(summary["paraphrases_run"], 1)
            self.assertEqual(summary["paraphrases_robust"], 1)
            self.assertEqual(summary["verify_rate"], 1.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
