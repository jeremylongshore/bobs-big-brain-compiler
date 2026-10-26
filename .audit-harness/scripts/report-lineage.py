#!/usr/bin/env python3
"""
audit-harness report-lineage — verify generic Run/Grade/report projections.

This gate validates the read-only report projection emitted by J-Rig without
importing J-Rig, opening SQLite, fetching schemas, or changing the inspected
filesystem. It checks the report's internal arithmetic and per-cell sample-slot
lineage and, for a suite report, the optional source audit manifest that records
the jobs that produced the projection.

Usage:
  audit-harness report-lineage --report report.json [--json] [--strict]
  audit-harness report-lineage --report suite.json --audit-manifest audit.json

The default is advisory: an unverifiable report yields an ADVISORY row and exit
0. `--strict` turns every finding into FAIL/exit 1. A clean claim is withheld
whenever parsing, identity, arithmetic, or source-manifest validation fails.
"""

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timezone


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
POLICY = "report-lineage/v1:run-grade-report-invariants"
GATE_ID = "audit-harness:ci:report-lineage"
REPORT_SCHEMAS = {"j-rig/unified-report/v1", "j-rig/suite-report/v1"}
RUN_STATUSES = {"pending", "running", "completed", "runner_error", "timed_out"}
SOURCE_STATUSES = RUN_STATUSES | {"planned", "failed"}
VERDICTS = {"pass", "fail"}
MISSING = object()
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")


def sha256_bytes(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def sha256_text(value):
    return sha256_bytes(value.encode("utf-8"))


def read_json(path):
    """Return (decoded value, error text, raw bytes). Reject non-standard JSON."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read()

        def reject_constant(value):
            raise ValueError(f"non-standard JSON constant {value}")

        def reject_duplicate_keys(pairs):
            decoded = {}
            for key, value in pairs:
                if key in decoded:
                    raise ValueError(f"duplicate JSON object key {key!r}")
                decoded[key] = value
            return decoded

        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_constant,
        ), None, raw
    except Exception as exc:  # parse and read failures are gate findings
        return None, str(exc), b""


def is_mapping(value):
    return isinstance(value, dict)


def nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def nonnegative_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def safe_identifier(value):
    return isinstance(value, str) and SAFE_IDENTIFIER.fullmatch(value) is not None


def path_key(*parts):
    return ".".join(str(part) for part in parts)


def add_error(errors, code, path, message):
    errors.append(f"{code} at {path}: {message}")


def require_mapping(value, errors, path):
    if not is_mapping(value):
        add_error(errors, "shape", path, f"expected object, got {type(value).__name__}")
        return False
    return True


def require_string(obj, key, errors, path, *, pattern=None):
    value = obj.get(key, MISSING)
    if not nonempty_string(value):
        add_error(errors, "shape", path_key(path, key), "expected a non-empty string")
        return None
    if pattern is not None and not pattern(value):
        add_error(errors, "identity", path_key(path, key), "has an invalid value")
        return None
    return value


def require_count(obj, key, errors, path):
    value = obj.get(key, MISSING)
    if not nonnegative_int(value):
        add_error(errors, "arithmetic", path_key(path, key), "expected a non-negative integer")
        return None
    return value


def validate_selector(selector, errors, path="grader"):
    if not require_mapping(selector, errors, path):
        return None
    grader_id = require_string(selector, "grader_id", errors, path, pattern=safe_identifier)
    grader_version = require_string(selector, "grader_version", errors, path)
    digest = require_string(
        selector,
        "grader_snapshot_sha256",
        errors,
        path,
        pattern=lambda value: len(value) == 71 and value.startswith("sha256:")
        and all(char in "0123456789abcdef" for char in value[7:]),
    )
    return {
        "grader_id": grader_id,
        "grader_version": grader_version,
        "grader_snapshot_sha256": digest,
    }


def same_identity(left, right, keys):
    return all(left.get(key) == right.get(key) for key in keys)


def validate_grade(grade, selector, errors, path):
    if grade is None:
        return
    if not require_mapping(grade, errors, path):
        return
    identity = validate_selector(grade, errors, path)
    if identity and selector and not same_identity(identity, selector, identity.keys()):
        add_error(errors, "identity", path, "Grade does not match the report's selected Grader snapshot")
    verdict = grade.get("verdict", MISSING)
    if verdict not in VERDICTS:
        add_error(errors, "shape", path_key(path, "verdict"), "must be pass or fail")
    score = grade.get("score", MISSING)
    if not finite_number(score):
        add_error(errors, "shape", path_key(path, "score"), "must be a finite number")


def validate_run(run, selector, errors, path):
    if not require_mapping(run, errors, path):
        return None
    fields = {}
    for key in ("raw_run_id", "task_id", "task_version", "config_id", "config_version", "model"):
        fields[key] = require_string(
            run, key, errors, path, pattern=safe_identifier if key in {"task_id", "config_id"} else None,
        )
    sample_index = run.get("sample_index", MISSING)
    if not nonnegative_int(sample_index):
        add_error(errors, "shape", path_key(path, "sample_index"), "must be a non-negative integer")
    status = run.get("status", MISSING)
    if status not in RUN_STATUSES:
        add_error(errors, "shape", path_key(path, "status"), f"must be one of {sorted(RUN_STATUSES)}")
    grade = run.get("grade", MISSING)
    if grade is MISSING:
        add_error(errors, "shape", path_key(path, "grade"), "required; use null when ungraded")
        grade = None
    validate_grade(grade, selector, errors, path_key(path, "grade"))
    if grade is not None and status != "completed":
        add_error(errors, "lineage", path, "only completed Runs may carry a Grade")
    fields.update({"sample_index": sample_index, "status": status, "grade": grade})
    return fields


def wilson_interval(successes, trials):
    if trials == 0:
        return None
    z = 1.959963984540054
    proportion = successes / trials
    denominator = 1 + (z * z) / trials
    center = (proportion + (z * z) / (2 * trials)) / denominator
    margin = (z / denominator) * math.sqrt(
        (proportion * (1 - proportion)) / trials + (z * z) / (4 * trials * trials)
    )
    return {
        "lower": max(0, center - margin),
        "upper": min(1, center + margin),
        "confidence_level": 0.95,
    }


def close_number(actual, expected):
    return finite_number(actual) and math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-9)


def validate_nullable_number(value, errors, path, *, minimum=None, maximum=None):
    if value is None:
        return
    if not finite_number(value):
        add_error(errors, "arithmetic", path, "must be a finite number or null")
        return
    if minimum is not None and value < minimum:
        add_error(errors, "arithmetic", path, f"must be >= {minimum}")
    if maximum is not None and value > maximum:
        add_error(errors, "arithmetic", path, f"must be <= {maximum}")


def validate_cell(cell, selector, grouped, errors, path):
    if not require_mapping(cell, errors, path):
        return None
    identity_keys = ("task_id", "task_version", "config_id", "config_version", "model")
    identity = {}
    for key in identity_keys:
        identity[key] = require_string(
            cell, key, errors, path, pattern=safe_identifier if key in {"task_id", "config_id"} else None,
        )
    if selector:
        for key in ("grader_id", "grader_version", "grader_snapshot_sha256"):
            value = require_string(cell, key, errors, path)
            if value is not None and value != selector.get(key):
                add_error(errors, "identity", path_key(path, key), "does not match report grader")
    else:
        for key in ("grader_id", "grader_version", "grader_snapshot_sha256"):
            require_string(cell, key, errors, path)

    counts = {}
    for key in (
        "attempted_runs",
        "completed_runs",
        "active_runs",
        "harness_failure_count",
        "graded_runs",
        "ungraded_completed_runs",
        "pass_count",
        "fail_count",
    ):
        counts[key] = require_count(cell, key, errors, path)

    key = tuple(identity.get(item) for item in identity_keys)
    expected = grouped.get(key, {name: 0 for name in (
        "attempted_runs", "completed_runs", "active_runs", "harness_failure_count",
        "graded_runs", "ungraded_completed_runs", "pass_count", "fail_count",
    )})
    for name, actual in counts.items():
        if actual is not None and actual != expected[name]:
            add_error(errors, "arithmetic", path_key(path, name), f"reports {actual}, expected {expected[name]}")

    pass_rate = cell.get("pass_rate", MISSING)
    if pass_rate is MISSING:
        add_error(errors, "shape", path_key(path, "pass_rate"), "required")
    else:
        validate_nullable_number(pass_rate, errors, path_key(path, "pass_rate"), minimum=0, maximum=1)
        if counts["graded_runs"] is not None:
            expected_rate = None if counts["graded_runs"] == 0 else counts["pass_count"] / counts["graded_runs"]
            if (pass_rate is None) != (expected_rate is None) or (
                expected_rate is not None and not close_number(pass_rate, expected_rate)
            ):
                add_error(errors, "arithmetic", path_key(path, "pass_rate"), "does not match pass/graded counts")

    standard_error = cell.get("standard_error", MISSING)
    if standard_error is MISSING:
        add_error(errors, "shape", path_key(path, "standard_error"), "required")
    else:
        validate_nullable_number(standard_error, errors, path_key(path, "standard_error"), minimum=0)
        if counts["graded_runs"] is not None:
            expected_se = None
            if counts["graded_runs"]:
                rate = counts["pass_count"] / counts["graded_runs"]
                expected_se = math.sqrt((rate * (1 - rate)) / counts["graded_runs"])
            if (standard_error is None) != (expected_se is None) or (
                expected_se is not None and not close_number(standard_error, expected_se)
            ):
                add_error(
                    errors, "arithmetic", path_key(path, "standard_error"),
                    "does not match pass-rate standard error",
                )

    interval = cell.get("confidence_interval_95", MISSING)
    if interval is MISSING:
        add_error(errors, "shape", path_key(path, "confidence_interval_95"), "required")
    elif interval is not None:
        if not require_mapping(interval, errors, path_key(path, "confidence_interval_95")):
            interval = None
        else:
            for bound in ("lower", "upper"):
                validate_nullable_number(
                    interval.get(bound, MISSING), errors, path_key(path, "confidence_interval_95", bound),
                    minimum=0, maximum=1,
                )
            if interval.get("confidence_level") != 0.95:
                add_error(
                    errors, "arithmetic", path_key(path, "confidence_interval_95", "confidence_level"),
                    "must be 0.95",
                )
            expected_interval = (
                wilson_interval(counts["pass_count"], counts["graded_runs"])
                if counts["pass_count"] is not None and counts["graded_runs"] is not None
                else None
            )
            if expected_interval is not None:
                for bound in ("lower", "upper"):
                    if not close_number(interval.get(bound), expected_interval[bound]):
                        add_error(
                            errors, "arithmetic", path_key(path, "confidence_interval_95", bound),
                            "does not match Wilson interval",
                        )
            elif counts["graded_runs"] == 0:
                add_error(
                    errors, "arithmetic", path_key(path, "confidence_interval_95"),
                    "must be null when no Runs are graded",
                )
    elif counts["graded_runs"] not in (None, 0):
        add_error(errors, "arithmetic", path_key(path, "confidence_interval_95"), "cannot be null when Runs are graded")

    score_values = [
        run["grade"]["score"]
        for run in grouped.get(key, {}).get("runs", [])
        if is_mapping(run.get("grade")) and finite_number(run["grade"].get("score"))
    ]
    mean_score = cell.get("mean_score", MISSING)
    score_se = cell.get("score_standard_error", MISSING)
    if mean_score is MISSING or score_se is MISSING:
        add_error(errors, "shape", path, "mean_score and score_standard_error are required")
    else:
        validate_nullable_number(mean_score, errors, path_key(path, "mean_score"))
        validate_nullable_number(score_se, errors, path_key(path, "score_standard_error"), minimum=0)
        expected_mean = None if not score_values else sum(score_values) / len(score_values)
        if len(score_values) <= 1:
            expected_score_se = None if not score_values else 0
        else:
            avg = expected_mean
            variance = sum((score - avg) ** 2 for score in score_values) / (len(score_values) - 1)
            expected_score_se = math.sqrt(variance / len(score_values))
        if (mean_score is None) != (expected_mean is None) or (
            expected_mean is not None and not close_number(mean_score, expected_mean)
        ):
            add_error(errors, "arithmetic", path_key(path, "mean_score"), "does not match Grade scores")
        if (score_se is None) != (expected_score_se is None) or (
            expected_score_se is not None and not close_number(score_se, expected_score_se)
        ):
            add_error(errors, "arithmetic", path_key(path, "score_standard_error"), "does not match Grade scores")

    return key


def validate_unified(report, errors):
    if not require_mapping(report, errors, "report"):
        return None
    if report.get("schema") != "j-rig/unified-report/v1":
        add_error(errors, "schema", "report.schema", "must be j-rig/unified-report/v1")
    if not nonempty_string(report.get("generated_at")):
        add_error(errors, "shape", "report.generated_at", "must be a non-empty string")
    selector = validate_selector(report.get("grader", MISSING), errors)
    summary = report.get("summary", MISSING)
    if not require_mapping(summary, errors, "report.summary"):
        summary = {}
    runs = report.get("runs", MISSING)
    if not isinstance(runs, list):
        add_error(errors, "shape", "report.runs", "must be an array")
        runs = []
    cells = report.get("cells", MISSING)
    if not isinstance(cells, list):
        add_error(errors, "shape", "report.cells", "must be an array")
        cells = []

    parsed_runs = []
    seen_ids = set()
    for index, run in enumerate(runs):
        parsed = validate_run(run, selector, errors, path_key("report", "runs", index))
        if parsed is None:
            continue
        # Keep the source-array position for deterministic diagnostics without
        # making callers depend on a second, synthetic Run identity.
        parsed["_report_index"] = index
        raw_id = parsed.get("raw_run_id")
        if raw_id in seen_ids:
            add_error(errors, "lineage", path_key("report", "runs", index, "raw_run_id"), "duplicate Raw Run id")
        seen_ids.add(raw_id)
        parsed_runs.append(parsed)

    sample_slots = {}
    duplicate_sample_indexes = 0
    for run in parsed_runs:
        sample_index = run.get("sample_index")
        if not nonnegative_int(sample_index):
            continue
        cell_key = tuple(run.get(item) for item in ("task_id", "task_version", "config_id", "config_version", "model"))
        slots = sample_slots.setdefault(cell_key, {})
        previous_index = slots.get(sample_index)
        if previous_index is not None:
            duplicate_sample_indexes += 1
            add_error(
                errors,
                "lineage",
                path_key("report", "runs", run["_report_index"], "sample_index"),
                f"duplicate sample_index {sample_index} in sampling cell; first seen at "
                f"report.runs.{previous_index}.sample_index",
            )
        else:
            slots[sample_index] = run["_report_index"]

    grouped = {}
    for run in parsed_runs:
        key = tuple(run.get(item) for item in ("task_id", "task_version", "config_id", "config_version", "model"))
        bucket = grouped.setdefault(key, {
            "runs": [], "attempted_runs": 0, "completed_runs": 0, "active_runs": 0,
            "harness_failure_count": 0, "graded_runs": 0, "ungraded_completed_runs": 0,
            "pass_count": 0, "fail_count": 0,
        })
        bucket["runs"].append(run)
        bucket["attempted_runs"] += 1
        if run.get("status") == "completed":
            bucket["completed_runs"] += 1
            if run.get("grade") is None:
                bucket["ungraded_completed_runs"] += 1
        if run.get("status") in {"pending", "running"}:
            bucket["active_runs"] += 1
        if run.get("status") in {"runner_error", "timed_out"}:
            bucket["harness_failure_count"] += 1
        grade = run.get("grade")
        if grade is not None:
            bucket["graded_runs"] += 1
            if grade.get("verdict") == "pass":
                bucket["pass_count"] += 1
            elif grade.get("verdict") == "fail":
                bucket["fail_count"] += 1

    summary_expected = {
        "cell_count": len(grouped),
        "attempted_runs": len(parsed_runs),
        "completed_runs": sum(bucket["completed_runs"] for bucket in grouped.values()),
        "active_runs": sum(bucket["active_runs"] for bucket in grouped.values()),
        "harness_failure_count": sum(bucket["harness_failure_count"] for bucket in grouped.values()),
        "graded_runs": sum(bucket["graded_runs"] for bucket in grouped.values()),
        "ungraded_completed_runs": sum(bucket["ungraded_completed_runs"] for bucket in grouped.values()),
        "pass_count": sum(bucket["pass_count"] for bucket in grouped.values()),
        "fail_count": sum(bucket["fail_count"] for bucket in grouped.values()),
    }
    for key, expected in summary_expected.items():
        actual = require_count(summary, key, errors, "report.summary")
        if actual is not None and actual != expected:
            add_error(
                errors, "arithmetic", path_key("report", "summary", key),
                f"reports {actual}, expected {expected}",
            )

    seen_cells = set()
    for index, cell in enumerate(cells):
        key = validate_cell(cell, selector, grouped, errors, path_key("report", "cells", index))
        if key in seen_cells:
            add_error(errors, "lineage", path_key("report", "cells", index), "duplicate cell identity")
        seen_cells.add(key)
    if len(cells) != len(grouped):
        add_error(errors, "arithmetic", "report.cells", f"contains {len(cells)} cells, expected {len(grouped)}")

    return {
        "schema": "j-rig/unified-report/v1",
        "selector": selector,
        "runs": parsed_runs,
        "run_ids": [run.get("raw_run_id") for run in parsed_runs],
        "run_counts": summary_expected,
        "sample_balance": {
            "sampling_cell_count": len(sample_slots),
            "unique_sample_slot_count": sum(len(slots) for slots in sample_slots.values()),
            "duplicate_sample_index_count": duplicate_sample_indexes,
            "target_n_verified": False,
        },
    }


def validate_source_manifest(source, errors):
    if not require_mapping(source, errors, "audit_manifest"):
        return None
    if source.get("schema") != "j-rig/eval-suite/v1":
        add_error(errors, "schema", "audit_manifest.schema", "must be j-rig/eval-suite/v1")
    require_string(source, "suite_id", errors, "audit_manifest", pattern=safe_identifier)
    for key in ("suite_version", "manifest_path"):
        require_string(source, key, errors, "audit_manifest")
    jobs = source.get("jobs", MISSING)
    if not isinstance(jobs, list):
        add_error(errors, "shape", "audit_manifest.jobs", "must be an array")
        jobs = []
    parsed = {}
    for index, job in enumerate(jobs):
        path = path_key("audit_manifest", "jobs", index)
        if not require_mapping(job, errors, path):
            continue
        raw_id = require_string(job, "raw_run_id", errors, path)
        status = job.get("status", MISSING)
        if status not in SOURCE_STATUSES:
            add_error(errors, "shape", path_key(path, "status"), f"must be one of {sorted(SOURCE_STATUSES)}")
        if raw_id is None:
            continue
        for key in ("task_id", "task_version", "config_id", "config_version", "model"):
            require_string(
                job, key, errors, path, pattern=safe_identifier if key in {"task_id", "config_id"} else None,
            )
        if raw_id in parsed:
            add_error(errors, "lineage", path_key(path, "raw_run_id"), "duplicate source Raw Run id")
        parsed[raw_id] = job
    report_meta = source.get("report")
    if report_meta is not None and require_mapping(report_meta, errors, "audit_manifest.report"):
        raw_count = report_meta.get("raw_run_count", MISSING)
        if raw_count is not MISSING and not nonnegative_int(raw_count):
            add_error(errors, "arithmetic", "audit_manifest.report.raw_run_count", "must be a non-negative integer")
        if raw_count is not MISSING and raw_count != len(parsed):
            add_error(
                errors, "arithmetic", "audit_manifest.report.raw_run_count",
                f"reports {raw_count}, expected {len(parsed)}",
            )
    return parsed


def compare_source(unified, source_jobs, errors):
    if source_jobs is None:
        return
    report_ids = set(unified.get("run_ids", []))
    source_ids = set(source_jobs)
    if report_ids != source_ids:
        missing = sorted(source_ids - report_ids)
        extra = sorted(report_ids - source_ids)
        add_error(errors, "lineage", "audit_manifest.jobs", f"Raw Run set differs (missing={missing}, extra={extra})")
    by_id = {run.get("raw_run_id"): run for run in unified.get("runs", [])}
    for raw_id, job in source_jobs.items():
        run = by_id.get(raw_id)
        if run is None:
            continue
        for key in ("task_id", "task_version", "config_id", "config_version", "model"):
            if key in job and job.get(key) != run.get(key):
                add_error(
                    errors, "identity", path_key("audit_manifest", "jobs", raw_id, key),
                    "does not match report Run",
                )
        source_status = job.get("status")
        if source_status in {"completed", "runner_error", "timed_out"} and source_status != run.get("status"):
            add_error(
                errors, "lineage", path_key("audit_manifest", "jobs", raw_id, "status"),
                f"reports {source_status}, report Run is {run.get('status')}",
            )
        if source_status in {"planned", "running", "failed"}:
            add_error(
                errors, "lineage", path_key("audit_manifest", "jobs", raw_id, "status"),
                f"source status {source_status} is not a sealed Raw Run",
            )
        source_grade = job.get("grade")
        report_grade = run.get("grade")
        if source_grade is None and report_grade is not None:
            add_error(
                errors, "identity", path_key("audit_manifest", "jobs", raw_id, "grade"),
                "source has no Grade but report carries one",
            )
        if source_grade is not None:
            if not is_mapping(source_grade):
                add_error(errors, "shape", path_key("audit_manifest", "jobs", raw_id, "grade"), "must be an object")
            elif report_grade is None:
                add_error(
                    errors, "lineage", path_key("audit_manifest", "jobs", raw_id, "grade"),
                    "source Grade is missing from report",
                )
            else:
                for key in ("grader_id", "grader_version", "grader_snapshot_sha256", "verdict", "score"):
                    if source_grade.get(key) != report_grade.get(key):
                        add_error(
                            errors, "identity", path_key("audit_manifest", "jobs", raw_id, "grade", key),
                            "does not match report Grade",
                        )


def git_commit(path):
    try:
        out = subprocess.run(
            ["git", "-C", os.path.dirname(os.path.abspath(path)), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, check=True, timeout=2,
        )
        return out.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def version():
    try:
        with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as handle:
            return json.load(handle).get("version", "unknown")
    except Exception:
        return "unknown"


def build_row(
    result,
    errors,
    report_path,
    source_path,
    report_schema,
    input_hash,
    commit_sha,
    selected_grader=None,
    run_counts=None,
    sample_balance=None,
):
    def display_path(path):
        if not path:
            return None
        try:
            return os.path.relpath(os.path.abspath(path), os.getcwd())
        except Exception:
            return os.path.normpath(path)

    row = {
        "gate_id": GATE_ID,
        "result": result,
        "policy_hash": sha256_text(POLICY),
        "input_hash": input_hash,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runner": f"audit-harness@{version()}",
        "commit_sha": commit_sha,
        "metadata": {
            "validator": "audit-harness-report-lineage-v1",
            "report_path": display_path(report_path),
            "report_schema": report_schema,
            "source_manifest_path": display_path(source_path),
            "source_verified": source_path is not None,
            "errors": errors[:20],
        },
    }
    if selected_grader is not None:
        row["metadata"]["selected_grader"] = selected_grader
    if run_counts is not None:
        row["metadata"]["run_counts"] = run_counts
    if sample_balance is not None:
        row["metadata"]["sample_balance"] = sample_balance
    if errors:
        row["advisory_severity"] = "error"
        row["failure_mode"] = "report-lineage:unverifiable"
    return row


def main():
    parser = argparse.ArgumentParser(description="Read-only Run/Grade/report lineage gate")
    parser.add_argument("--report", required=True, help="Unified or suite report JSON path")
    parser.add_argument("--audit-manifest", default=None, help="J-Rig suite audit manifest JSON path")
    parser.add_argument("--json", action="store_true", help="Emit one gate-result/v1 row as JSON")
    parser.add_argument("--strict", action="store_true", help="Turn advisory findings into FAIL/exit 1")
    args = parser.parse_args()

    report, report_error, report_raw = read_json(args.report)
    errors = []
    report_schema = report.get("schema") if is_mapping(report) else None
    unified = None
    source_raw = b""
    source_jobs = None
    if report_error:
        add_error(errors, "parse", "report", f"cannot read JSON: {report_error}")
    elif report_schema == "j-rig/unified-report/v1":
        unified = validate_unified(report, errors)
    elif report_schema == "j-rig/suite-report/v1":
        if not require_mapping(report, errors, "report"):
            unified = None
        else:
            require_string(report, "suite_id", errors, "report", pattern=safe_identifier)
            for key in ("suite_version", "manifest_path", "generated_at"):
                require_string(report, key, errors, "report")
            nested = report.get("report", MISSING)
            if not require_mapping(nested, errors, "report.report"):
                unified = None
            else:
                unified = validate_unified(nested, errors)
                raw_ids = report.get("raw_run_ids", MISSING)
                if not isinstance(raw_ids, list) or any(not nonempty_string(item) for item in raw_ids):
                    add_error(errors, "shape", "report.raw_run_ids", "must be an array of non-empty strings")
                    raw_ids = []
                if len(raw_ids) != len(set(raw_ids)):
                    add_error(errors, "lineage", "report.raw_run_ids", "contains duplicate Raw Run ids")
                if unified is not None and set(raw_ids) != set(unified.get("run_ids", [])):
                    add_error(errors, "lineage", "report.raw_run_ids", "does not match nested report runs")
        if args.audit_manifest is None:
            add_error(errors, "source", "audit_manifest", "required for j-rig/suite-report/v1 verification")
    else:
        if is_mapping(report):
            add_error(errors, "schema", "report.schema", f"must be one of {sorted(REPORT_SCHEMAS)}")
        else:
            add_error(errors, "shape", "report", "must be a JSON object")

    if args.audit_manifest:
        source, source_error, source_raw = read_json(args.audit_manifest)
        if source_error:
            add_error(errors, "parse", "audit_manifest", f"cannot read JSON: {source_error}")
        else:
            source_jobs = validate_source_manifest(source, errors)
            if unified is not None:
                compare_source(unified, source_jobs, errors)

    input_bytes = report_raw
    if args.audit_manifest:
        input_bytes += b"\0" + source_raw
    input_hash = sha256_bytes(input_bytes)
    result = "PASS" if not errors else ("FAIL" if args.strict else "ADVISORY")
    selected_grader = unified.get("selector") if unified is not None else None
    run_counts = unified.get("run_counts") if unified is not None else None
    sample_balance = unified.get("sample_balance") if unified is not None else None
    row = build_row(
        result,
        errors,
        args.report,
        args.audit_manifest,
        report_schema,
        input_hash,
        git_commit(args.report),
        selected_grader,
        run_counts,
        sample_balance,
    )

    if args.json:
        print(json.dumps(row, indent=2, sort_keys=True))
    elif errors:
        print(f"report-lineage: {result} — {len(errors)} finding(s)")
        for error in errors[:20]:
            print(f"  - {error}")
    else:
        print(f"report-lineage: PASS — {report_schema} lineage and arithmetic verified")
    return 1 if result == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main())
