#!/usr/bin/env python3
"""
Unit tests for bank.py — the question-bank schema parser.

Contracts under test:

1. v1 banks (no `paraphrases:` field) load as "one intent, one synthetic
   primary paraphrase, style=legacy". Backward compat invariant.
2. v2 banks (with `paraphrases:` list-of-dicts) load each paraphrase as
   a distinct iteration unit with stable positional `paraphrase_idx`.
3. iter_prompts() yields (intent, paraphrase) pairs in declaration order;
   the `--paraphrases primary` filter keeps only the primary per intent.
4. Schema validation rejects bad shapes: zero primaries, multiple
   primaries, mixed v1/v2 entries, malformed paraphrase dicts.
5. expected_substrings + expected_sources stay PER-INTENT (not duplicated
   per paraphrase) — surfaced uniformly to consumers.

Run from repo root:
    python3 -m unittest plugin.skills.ico-your-internals.scripts.tests.test_bank

Or directly:
    python3 plugin/skills/ico-your-internals/scripts/tests/test_bank.py
"""
import pathlib
import sys
import tempfile
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parent.parent
FIXTURES_DIR = pathlib.Path(__file__).resolve().parent / "fixtures"

# Make bank module importable from the scripts/ dir.
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


class TestV1Compat(unittest.TestCase):
    """v1 banks must load without modification — backward compat."""

    def test_v1_bank_yields_single_paraphrase_per_question(self):
        from bank import iter_prompts, load_bank

        bank = load_bank(str(FIXTURES_DIR / "bank-v1.yaml"))
        prompts = list(iter_prompts(bank))

        self.assertEqual(len(prompts), 1, "v1 bank with 1 question → 1 prompt")
        prompt = prompts[0]
        self.assertEqual(prompt["intent_id"], "Q01")
        self.assertEqual(prompt["paraphrase_idx"], 0)
        self.assertTrue(prompt["primary"])
        self.assertEqual(prompt["style"], "legacy")
        self.assertIn("fixture", prompt["text"].lower())
        # Ground truth comes through unchanged.
        self.assertEqual(prompt["expected_substrings"], ["fixture"])
        self.assertEqual(prompt["expected_sources"], ["README.md"])


class TestV2Schema(unittest.TestCase):
    """v2 banks expand each paraphrase to a distinct prompt entry."""

    def test_v2_bank_yields_one_prompt_per_paraphrase(self):
        from bank import iter_prompts, load_bank

        bank = load_bank(str(FIXTURES_DIR / "bank-v2.yaml"))
        prompts = list(iter_prompts(bank))

        self.assertEqual(len(prompts), 2, "v2 bank with 1 intent × 2 paraphrases → 2 prompts")
        # Order preserved; positional index is 0, 1.
        self.assertEqual([p["paraphrase_idx"] for p in prompts], [0, 1])
        self.assertEqual([p["intent_id"] for p in prompts], ["Q01", "Q01"])
        # Exactly one is primary.
        self.assertEqual(sum(1 for p in prompts if p["primary"]), 1)
        # Both share the same ground truth.
        self.assertEqual(prompts[0]["expected_substrings"], prompts[1]["expected_substrings"])
        self.assertEqual(prompts[0]["expected_sources"], prompts[1]["expected_sources"])
        # Style fields are carried through.
        self.assertEqual(prompts[0]["style"], "direct")
        self.assertEqual(prompts[1]["style"], "open")


class TestPrimaryFilter(unittest.TestCase):
    """The mode='primary' filter selects exactly the primary paraphrase per intent."""

    def test_primary_mode_yields_one_prompt_per_intent(self):
        from bank import iter_prompts, load_bank

        bank = load_bank(str(FIXTURES_DIR / "bank-v2.yaml"))
        prompts = list(iter_prompts(bank, mode="primary"))

        self.assertEqual(len(prompts), 1, "primary mode on 1 intent × 2 paraphrases → 1 prompt")
        self.assertTrue(prompts[0]["primary"])
        self.assertEqual(prompts[0]["style"], "direct")

    def test_all_mode_yields_every_paraphrase(self):
        from bank import iter_prompts, load_bank

        bank = load_bank(str(FIXTURES_DIR / "bank-v2.yaml"))
        prompts = list(iter_prompts(bank, mode="all"))
        self.assertEqual(len(prompts), 2)


class TestMalformedRejection(unittest.TestCase):
    """Bad bank shapes must be rejected at load time, not at runtime."""

    def test_multiple_primaries_rejected(self):
        from bank import BankSchemaError, load_bank

        with self.assertRaises(BankSchemaError) as ctx:
            load_bank(str(FIXTURES_DIR / "bank-malformed.yaml"))
        # The error message should name the offending intent so authors
        # can find it quickly.
        self.assertIn("Q01", str(ctx.exception))

    def test_mixed_bank_rejected(self):
        """A v2 bank where one intent uses `question:` (v1 shape) and another
        uses `paraphrases:` (v2 shape) is a half-migrated file — reject it."""
        from bank import BankSchemaError, load_bank

        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            f.write(
                """\
version: v2
target: fixture-target
questions:
  - id: Q01
    question: "old v1 shape inline"
    expected_substrings: ['x']
  - id: Q02
    intent: "new v2 shape inline"
    paraphrases:
      - text: "v2 paraphrase"
        style: direct
        primary: true
    expected_substrings: ['x']
"""
            )
            path = f.name

        try:
            with self.assertRaises(BankSchemaError) as ctx:
                load_bank(path)
            self.assertTrue(
                "mixed" in str(ctx.exception).lower()
                or "inconsistent" in str(ctx.exception).lower(),
                f"error should mention mixed/inconsistent shapes, got: {ctx.exception}",
            )
        finally:
            pathlib.Path(path).unlink()


if __name__ == "__main__":
    unittest.main(verbosity=2)
