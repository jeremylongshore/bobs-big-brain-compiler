"""Hermetic fake-agent process checks; no operator HOME, provider or brain access."""

import importlib.util
import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "review_metrics", HERE / "review-metrics.py"
)
metrics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(metrics)


class ReviewMetricsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="review-metrics-test-")
        self.root = Path(self.temp.name)
        self.logs = self.root / "logs"
        self.logs.mkdir()
        self.transcript = self.root / "review.log"
        self.agent = self.root / "claude"
        self.agent.write_text("""#!/usr/bin/env python3
import json,os,time
time.sleep(float(os.environ.get("FIXTURE_SLEEP","0")))
print("reviewed 4 · promoted 1 · held 2 · rejected 1",flush=True)
print(json.dumps({"type":"result","usage":{"input_tokens":100,"output_tokens":20},"total_cost_usd":0.012,"result":"fixture-secret-never-in-metrics"}),flush=True)
raise SystemExit(int(os.environ.get("FIXTURE_EXIT","0")))
""")
        self.agent.chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def run_phase(
        self,
        provider="minimax",
        token=True,
        config=True,
        expect_metrics=True,
        **overrides,
    ):
        config_path = self.root / "review-mcp.json"
        if config:
            config_path.write_text("{}")
        source = (HERE / "teamkb-compile-daily.sh").read_text()
        functions = source[
            source.index('REVIEW_SUMMARY=""') : source.index(
                "# ── Distiller-output eval"
            )
        ]
        harness = self.root / "phase.sh"
        harness.write_text(
            'set -uo pipefail\numask 077\nlog() { printf "%s\\n" "$*"; }\n'
            + functions
            + '\nrun_inbox_review\nprintf "summary=%s\\n" "$REVIEW_SUMMARY"\n'
        )
        env = {
            "PATH": f"{self.root}:/usr/local/bin:/usr/bin:/bin",
            "HOME": str(self.root),
            "SCRIPT_DIR": str(HERE),
            "LOG_DIR": str(self.logs),
            "SCRATCH": str(self.root),
            "TARGET": "synthetic-date",
            "MODE": "digest",
            "TEAMKB_AGENT": provider,
            "AGENT_NAME": provider,
            "AGENT_BIN": str(self.agent),
            "MINIMAX_MODEL": "MiniMax-M3",
            "MINIMAX_KEY": "fixture-key-never-in-metrics",
            "MINIMAX_BASE_URL": "http://invalid.fixture",
            "REVIEW_API_URL": "http://invalid.fixture",
            "REVIEW_TOKEN_FILE": str(self.root / "absent-token"),
            "REVIEW_MCP_CONFIG": str(config_path),
            "REVIEW_SKILL_DIR": str(self.root),
            "REVIEW_TIMEOUT_SECS": "3",
            "TEAMKB_MAX_TURNS": "1",
        }
        if token:
            env["TEAMKB_REVIEW_AGENT_TOKEN"] = "fixture-token-never-in-metrics"
        env.update(overrides)
        result = subprocess.run(
            ["bash", str(harness)],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        records = list(self.logs.glob("review-metrics-*.json"))
        if not expect_metrics:
            self.assertEqual(records, [])
            self.assertIn("metrics unavailable", result.stdout)
            return None, result
        self.assertEqual(len(records), 1, result.stdout + result.stderr)
        data = json.loads(records[0].read_text())
        self.assertEqual(records[0].stat().st_mode & 0o777, 0o600)
        for private in (
            "fixture-token-never-in-metrics",
            "fixture-key-never-in-metrics",
            "fixture-secret-never-in-metrics",
            str(self.root),
        ):
            self.assertNotIn(private, records[0].read_text())
        return data, result

    def test_success_records_monotonic_client_usage_and_agent_reported_counts(self):
        data, result = self.run_phase()
        self.assertEqual(data["outcome"], "success")
        self.assertEqual(data["selected_model"], "MiniMax-M3")
        self.assertEqual(data["usage_source"], "cli_reported")
        self.assertEqual(data["usage"]["input_tokens"], 100)
        self.assertEqual(data["usage"]["total_cost_usd"], 0.012)
        self.assertIsNone(data["usage"]["cache_read_input_tokens"])
        self.assertEqual(data["candidate_counts"]["reviewed"], 4)
        self.assertEqual(data["candidate_counts_source"], "agent_reported_text")
        self.assertGreaterEqual(data["elapsed_ms"], 0)
        self.assertIn("inbox review OK", result.stdout)

    def test_failure_is_best_effort_and_does_not_become_compile_failure(self):
        data, result = self.run_phase(FIXTURE_EXIT="7")
        self.assertEqual(data["outcome"], "failed")
        self.assertEqual(data["exit_code"], 7)
        self.assertIn("compile still succeeded", result.stdout)

    def test_timeout_is_measured_without_success_claim(self):
        data, _ = self.run_phase(FIXTURE_SLEEP="1", REVIEW_TIMEOUT_SECS="0.05")
        self.assertEqual(data["outcome"], "timeout")
        self.assertIn(data["exit_code"], (124, 137))
        self.assertIsNone(data["candidate_counts"])
        self.assertEqual(data["usage_source"], "unavailable")

    def test_no_token_is_a_measured_skip_not_activation(self):
        data, _ = self.run_phase(token=False)
        self.assertEqual(data["outcome"], "skipped")
        self.assertEqual(data["skip_reason"], "no_token")
        self.assertIsNone(data["invoked_provider"])
        self.assertFalse((self.root / "review-synthetic-date.log").exists())

    def test_missing_config_is_a_measured_skip(self):
        data, _ = self.run_phase(config=False)
        self.assertEqual(data["skip_reason"], "missing_config")
        self.assertIsNone(data["exit_code"])

    def test_other_provider_model_is_not_invented(self):
        data, _ = self.run_phase(provider="claude")
        self.assertEqual(data["invoked_provider"], "claude")
        self.assertIsNone(data["selected_model"])

    def test_grok_fake_process_records_no_invented_model(self):
        data, _ = self.run_phase(provider="grok", TARGET="2026-11-04")
        self.assertEqual(data["invoked_provider"], "grok")
        self.assertEqual(data["target_date"], "2026-11-04")
        self.assertIsNone(data["selected_model"])

    def test_metrics_failure_is_visible_without_changing_review_success(self):
        blocked = self.root / "not-a-directory"
        blocked.write_text("fixture")
        _, result = self.run_phase(expect_metrics=False, LOG_DIR=str(blocked))
        self.assertIn("inbox review OK", result.stdout)

    def test_sigkill_exit_is_not_claimed_as_proven_timeout(self):
        data, _ = self.run_phase(FIXTURE_EXIT="137")
        self.assertEqual(data["outcome"], "failed")
        self.assertEqual(data["exit_code"], 137)

    def test_no_structured_usage_means_unavailable_not_zero(self):
        self.agent.write_text(
            '#!/bin/sh\nprintf "reviewed 2 · promoted 0 · held 2 · rejected 0\\n"\n'
        )
        data, _ = self.run_phase()
        self.assertEqual(data["candidate_counts"]["reviewed"], 2)
        self.assertEqual(data["usage_source"], "unavailable")
        self.assertTrue(all(value is None for value in data["usage"].values()))

    def test_previous_appended_attempt_is_not_reused(self):
        self.agent.write_text("#!/bin/sh\nexit 0\n")
        (self.root / "review-synthetic-date.log").write_text(
            "reviewed 99 · promoted 99 · held 0 · rejected 0\n"
            + json.dumps({"type": "result", "usage": {"input_tokens": 999}})
            + "\n"
        )
        data, _ = self.run_phase()
        self.assertIsNone(data["candidate_counts"])
        self.assertEqual(data["usage_source"], "unavailable")

    def test_arbitrary_selected_model_is_not_copied(self):
        data, _ = self.run_phase(MINIMAX_MODEL="fixture-secret-never-in-metrics")
        self.assertIsNone(data["selected_model"])

    def test_malformed_usage_and_unknown_fields_cannot_echo_content(self):
        lines = [
            "{not json}",
            json.dumps(
                {
                    "type": "result",
                    "usage": {
                        "input_tokens": True,
                        "output_tokens": -1,
                        "cache_read_input_tokens": 10**400,
                        "secret": "private",
                    },
                    "total_cost_usd": float("inf"),
                    "result": "private",
                }
            ),
        ]
        self.transcript.write_text("\n".join(lines))
        counts, usage, source = metrics.transcript_observations(self.transcript, 0)
        self.assertIsNone(counts)
        self.assertEqual(source, "unavailable")
        self.assertTrue(all(value is None for value in usage.values()))

    def test_last_terminal_report_replaces_instead_of_summing_and_zero_is_available(
        self,
    ):
        self.transcript.write_text(
            "\n".join(
                json.dumps(
                    {
                        "type": "result",
                        "usage": {"input_tokens": n},
                        "total_cost_usd": 0,
                    }
                )
                for n in (100, 0)
            )
        )
        _, usage, source = metrics.transcript_observations(self.transcript, 0)
        self.assertEqual(source, "cli_reported")
        self.assertEqual(usage["input_tokens"], 0)
        self.assertEqual(usage["total_cost_usd"], 0)

    def test_bounded_tail_and_invalid_offsets_never_reuse_earlier_content(self):
        self.transcript.write_text(
            "reviewed 99 · promoted 99 · held 0 · rejected 0\n"
            + "x" * (metrics.MAX_BYTES + 10)
        )
        self.assertIsNone(metrics.transcript_observations(self.transcript, 0)[0])
        self.assertIsNone(
            metrics.transcript_observations(
                self.transcript, self.transcript.stat().st_size + 1
            )[0]
        )
        self.assertIsNone(metrics.transcript_observations(self.root / "absent", 0)[0])

    def test_clock_is_monotonic_integer(self):
        result = subprocess.run(
            ["python3", str(HERE / "review-metrics.py"), "clock"],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertLessEqual(int(result.stdout), time.monotonic_ns())


if __name__ == "__main__":
    unittest.main()
