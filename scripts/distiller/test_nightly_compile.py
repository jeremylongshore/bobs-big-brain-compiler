"""Hermetic process proofs; never load the operator's brain or credentials."""

import importlib.util
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proof = load("proof", "runtime-proof.py")
guard = load("guard", "c8-mcp.py")


def record(date="2026-09-08"):
    return {"date": date, "window": {"start": date, "end": "2026-09-09"}, "mode": "auto",
            "govern": {"ingested": 1, "promoted": 1, "rejected": 0, "duplicates": 0,
                       "flagged": 0, "indexUpdated": True}, "audit_verify": "intact"}


class NightlyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nightly-test-")
        self.root = Path(self.temp.name)
        self.skill = self.root / ".claude/skills/teamkb-compile"
        (self.skill / "scripts").mkdir(parents=True)
        (self.skill / "methodology").mkdir()
        self.decisions = self.skill / "methodology/decisions.jsonl"
        self.decisions.write_text("")
        self.native = self.root / "native.py"
        self.native.write_text('''import json,sys
for line in sys.stdin:
 m=json.loads(line)
 if "id" not in m:continue
 if m.get("method")=="initialize":result={"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}
 else:result={"content":[{"type":"text","text":json.dumps({"ok":True,"totalEvents":10,"tamperSignatures":0,"anchorBreaks":0,"anchorCount":2,"chainForks":0})}]}
 print(json.dumps({"jsonrpc":"2.0","id":m["id"],"result":result}),flush=True)
''')
        self.config = self.skill / "scripts/brain-mcp-config.json"
        self.config.write_text(json.dumps({"mcpServers": {"governed-brain": {
            "command": "python3", "args": [str(self.native)]}}}))
        self.preflight = self.root / "preflight.sh"
        self.preflight.write_text("#!/bin/sh\nexit 0\n")
        self.gate = self.root / "gate.sh"
        self.gate.write_text("""#!/usr/bin/env bash
python3 -c 'import hashlib,json,sys; row=json.loads(sys.stdin.readline()); open(sys.argv[1],"a").write(json.dumps({"decision":"pass","sink":"brain-ingest","content_sha256":hashlib.sha256(row["text"].encode()).hexdigest()})+"\\n"); print(json.dumps(row))' "$2"
""")
        self.agent = self.root / "agent"
        self.agent.write_text('''#!/usr/bin/env python3
import datetime,json,os,pathlib
p=pathlib.Path(os.environ["HOME"])
(p/"agent-ran").write_text(json.dumps({k:os.environ.get(k) for k in ("ANTHROPIC_BASE_URL","ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN")}))
if os.environ.get("FIXTURE_OUTCOME")=="success":
 record=json.loads(os.environ["FIXTURE_RECORD"])
 if os.environ.get("FIXTURE_DYNAMIC_DATE"):
  date=os.environ["TEAMKB_COMPILE_DATE"];record.update(date=date,window={"start":date,"end":(datetime.date.fromisoformat(date)+datetime.timedelta(days=1)).isoformat()})
 with (p/".claude/skills/teamkb-compile/methodology/decisions.jsonl").open("a") as f:f.write(json.dumps(record)+"\\n")
''')
        self.agent.chmod(0o755)
        self.env = os.environ.copy()
        self.env.update(HOME=str(self.root), TEAMKB_HOME=str(self.root / ".teamkb"),
                        TEAMKB_COMPILE_DATE="2026-09-08", TEAMKB_COMPILE_MODE="auto",
                        TEAMKB_COMPILE_SCRATCH=str(self.root / "scratch"),
                        TEAMKB_C8_PREFLIGHT=str(self.preflight), TEAMKB_C8_GATE=str(self.gate),
                        MINIMAX_API_KEY="fixture-key-never-log", MINIMAX_SOPS_FILE=str(self.root / "absent"),
                        CLAUDE_BIN=str(self.agent), TEAMKB_AGENT="minimax", TEAMKB_COMPILE_TIMEOUT="5",
                        FIXTURE_RECORD=json.dumps(record()), CLAUDE_CODE_OAUTH_TOKEN="expired-fixture")

    def tearDown(self):
        self.temp.cleanup()

    def run_wrapper(self):
        return subprocess.run(["bash", str(HERE / "teamkb-compile-daily.sh")], env=self.env,
                              capture_output=True, text=True, timeout=15)

    def test_exit_zero_without_governed_outcome_is_failure(self):
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing or invalid governed outcome", result.stdout)

    def test_completed_outcome_and_live_audit_proof_then_idempotent_replay(self):
        self.env["FIXTURE_OUTCOME"] = "success"
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stdout)
        receipt = self.root / ".local/state/teamkb-compile-daily/verified-2026-09-08.json"
        self.assertTrue(json.loads(receipt.read_text())["audit"]["ok"])
        before = self.decisions.read_bytes()
        (self.root / "agent-ran").unlink()
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse((self.root / "agent-ran").exists())
        self.assertEqual(self.decisions.read_bytes(), before)

    def test_expired_oauth_is_not_passed_to_configured_minimax(self):
        self.run_wrapper()
        child_env = json.loads((self.root / "agent-ran").read_text())
        self.assertEqual(child_env["CLAUDE_CODE_OAUTH_TOKEN"], "")
        self.assertEqual(child_env["ANTHROPIC_API_KEY"], "fixture-key-never-log")
        for path in (self.root / ".local/state/teamkb-compile-daily").glob("*.log"):
            self.assertNotIn("fixture-key-never-log", path.read_text())

    def test_missing_key_never_silently_uses_expired_claude(self):
        self.env.pop("MINIMAX_API_KEY")
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "agent-ran").exists())

    def test_c8_preflight_failure_prevents_agent(self):
        self.preflight.write_text("#!/bin/sh\nexit 2\n")
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertFalse((self.root / "agent-ran").exists())

    def test_missing_capture_gate_prevents_agent(self):
        self.gate.unlink()
        self.assertEqual(self.run_wrapper().returncode, 2)
        self.assertFalse((self.root / "agent-ran").exists())

    def test_failed_old_record_does_not_poison_retry(self):
        self.decisions.write_text(json.dumps({"date": "2026-09-08", "mode": "auto", "error": "provider"}) + "\n")
        self.env["FIXTURE_OUTCOME"] = "success"
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(len(self.decisions.read_text().splitlines()), 2)

    def test_capture_policy_rejection_cannot_be_forwarded(self):
        self.gate.write_text("#!/bin/sh\ncat >/dev/null\n")
        self.assertEqual(guard.authorize_capture({"content": "fixture"}, str(self.gate), str(self.root / "receipt")),
                         (False, "policy-rejected"))

    def test_capture_policy_failure_is_closed(self):
        self.gate.write_text("#!/bin/sh\ncat\nexit 2\n")
        self.assertEqual(guard.authorize_capture({"content": "fixture"}, str(self.gate), str(self.root / "receipt")),
                         (False, "policy-unavailable"))

    def test_capture_policy_checks_exact_whole_candidate(self):
        self.assertEqual(guard.authorize_capture({"title": "fixture", "content": "allowed", "filePaths": ["fixture"]},
                                                str(self.gate), str(self.root / "receipt")), (True, "accepted"))
        self.gate.write_text("#!/bin/sh\nprintf '%s\\n' '{\"text\":\"different\"}'\n")
        self.assertFalse(guard.authorize_capture({"content": "original"}, str(self.gate), str(self.root / "receipt"))[0])

    def test_capture_requires_new_matching_policy_receipt(self):
        receipt = self.root / "receipt"
        self.gate.write_text("#!/bin/sh\ncat\n")
        for prior in (None, {"decision": "pass", "sink": "brain-ingest", "content_sha256": "unrelated"}):
            if prior:
                receipt.write_text(json.dumps(prior) + "\n")
            self.assertEqual(guard.authorize_capture({"content": "fixture"}, str(self.gate), str(receipt)),
                             (False, "policy-receipt-unavailable"))

    def test_changed_verified_decision_cannot_be_silently_recertified(self):
        self.env["FIXTURE_OUTCOME"] = "success"
        self.assertEqual(self.run_wrapper().returncode, 0)
        receipt = self.root / ".local/state/teamkb-compile-daily/verified-2026-09-08.json"
        before = receipt.read_bytes()
        changed = record()
        changed["govern"]["promoted"] = 2
        self.decisions.write_text(json.dumps(changed) + "\n")
        (self.root / "agent-ran").unlink()
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(receipt.read_bytes(), before)
        self.assertFalse((self.root / "agent-ran").exists())

    def test_tamper_or_stale_index_is_not_a_success_record(self):
        row = record()
        self.assertTrue(proof.valid_record(row, "2026-09-08", "auto"))
        row["audit_verify"] = "tamper detected"
        self.assertFalse(proof.valid_record(row, "2026-09-08", "auto"))
        row["audit_verify"] = "intact"
        row["govern"]["indexUpdated"] = False
        self.assertFalse(proof.valid_record(row, "2026-09-08", "auto"))

    def test_real_stdio_proxy_never_forwards_denied_capture_or_transition(self):
        seen = self.root / "seen.jsonl"
        self.native.write_text('''import json,sys
from pathlib import Path
for line in sys.stdin:
 m=json.loads(line)
 with Path(sys.argv[1]).open("a") as f:f.write(line)
 print(json.dumps({"jsonrpc":"2.0","id":m["id"],"result":{"content":[{"type":"text","text":"native accepted"}]}}),flush=True)
''')
        self.config.write_text(json.dumps({"mcpServers": {"governed-brain": {
            "command": "python3", "args": [str(self.native), str(seen)]}}}))
        self.gate.write_text("#!/bin/sh\ncat >/dev/null\n")
        messages = [{"jsonrpc": "2.0", "id": n, "method": "tools/call", "params": {
            "name": name, "arguments": {"title": "fixture", "content": "do not forward this fixture"}}}
            for n, name in enumerate(("brain_capture", "brain_transition", "brain_status"), 1)]
        result = subprocess.run(["python3", str(HERE / "c8-mcp.py"), "--config", str(self.config),
                                 "--gate", str(self.gate), "--receipts", str(self.root / "receipts")],
                                input="".join(json.dumps(message) + "\n" for message in messages),
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        forwarded = [json.loads(line) for line in seen.read_text().splitlines()]
        self.assertEqual([message["params"]["name"] for message in forwarded], ["brain_status"])
        responses = {message["id"]: message for message in map(json.loads, result.stdout.splitlines())}
        self.assertTrue(responses[1]["result"]["isError"])
        self.assertTrue(responses[2]["result"]["isError"])
        self.assertNotIn("do not forward this fixture", result.stdout + result.stderr)

    def test_entry_persists_misses_before_agent_failure(self):
        self.env.pop("TEAMKB_COMPILE_DATE")
        result = subprocess.run(["python3", str(HERE / "nightly-entry.py")], env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        pending = self.root / ".local/state/teamkb-compile-daily/pending-dates.json"
        original = json.loads(pending.read_text())["pending"]
        self.assertEqual(len(original), 7)
        result = subprocess.run(["python3", str(HERE / "nightly-entry.py")], env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(pending.read_text())["pending"], original)

    def test_entry_bounds_catchup_and_restarts_without_duplicate_dates(self):
        self.env.pop("TEAMKB_COMPILE_DATE")
        self.env.update(FIXTURE_OUTCOME="success", FIXTURE_DYNAMIC_DATE="1", TEAMKB_COMPILE_MAX_DATES="2")
        for expected in (5, 3):
            result = subprocess.run(["python3", str(HERE / "nightly-entry.py")], env=self.env,
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            pending = self.root / ".local/state/teamkb-compile-daily/pending-dates.json"
            self.assertEqual(len(json.loads(pending.read_text())["pending"]), expected)
        dates = [row["date"] for row in proof.records(self.decisions)]
        self.assertEqual(len(dates), 4)
        self.assertEqual(len(set(dates)), 4)

    def test_compile_lock_never_takes_brain_writer_lock(self):
        self.env["TEAMKB_COMPILE_DRYRUN"] = "1"
        self.env["TEAMKB_LOCK_WAIT"] = "0"
        self.assertEqual(self.run_wrapper().returncode, 0)
        brain = self.root / ".teamkb"
        self.assertTrue((brain / ".compile.lock").exists())
        self.assertFalse((brain / ".write.lock").exists())
        with (brain / ".compile.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_wrapper()
            self.assertEqual(result.returncode, 0)
            self.assertIn("skipping this compile run", result.stdout)
            with (brain / ".write.lock").open("a") as writer:
                fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_crash_after_decision_before_proof_recovers_without_recapture(self):
        self.decisions.write_text(json.dumps(record()) + "\n")
        log_dir = self.root / ".local/state/teamkb-compile-daily"
        self.assertFalse(proof.verified(self.decisions, "2026-09-08", "auto", log_dir))
        before = self.decisions.read_bytes()
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(proof.verified(self.decisions, "2026-09-08", "auto", log_dir))
        self.assertFalse((self.root / "agent-ran").exists())
        self.assertEqual(self.decisions.read_bytes(), before)

    def test_unverified_decision_with_failed_audit_remains_pending(self):
        self.decisions.write_text(json.dumps(record()) + "\n")
        self.native.write_text(self.native.read_text().replace('"ok":True', '"ok":False'))
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "agent-ran").exists())
        self.assertFalse(proof.verified(self.decisions, "2026-09-08", "auto",
                                        self.root / ".local/state/teamkb-compile-daily"))

    def test_verified_receipt_binds_exact_decision_hash_date_and_mode(self):
        self.env["FIXTURE_OUTCOME"] = "success"
        self.assertEqual(self.run_wrapper().returncode, 0)
        log_dir = self.root / ".local/state/teamkb-compile-daily"
        self.assertTrue(proof.verified(self.decisions, "2026-09-08", "auto", log_dir))
        modified = record()
        modified["govern"]["promoted"] = 2
        self.decisions.write_text(json.dumps(modified) + "\n")
        self.assertFalse(proof.verified(self.decisions, "2026-09-08", "auto", log_dir))
        self.assertFalse(proof.verified(self.decisions, "2026-09-08", "digest", log_dir))


if __name__ == "__main__":
    unittest.main()
