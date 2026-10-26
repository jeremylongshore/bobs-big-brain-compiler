#!/usr/bin/env python3
"""
audit-harness scan — read-only security / hygiene / skill-quality gate-runner
(PP-PLAN-040 Phase 4 / E6).

For every `dimension: security | hygiene | skill-quality` gate in a repo's
audit-profile/v1, scan runs the right external tool with the repo present and wraps
its exit code into a `gate-result/v1` row (JSON array, stdout). Advisory-first by
default. `--fail-closed` makes dependency measurement mandatory when a supported
lockfile/manifest exists and enforces the configured OSV severity threshold. It
NEVER fixes anything and NEVER reimplements a scanner.

Strategies:
  - local      hygiene-readme: deterministic README presence check (no tool).
  - dependency osv-scanner v2 receives a deterministic recursive source scan.
               No supported input -> NOT_APPLICABLE. Its JSON distinguishes
               findings from scanner failures and records inputs, tool version,
               dependency exposure, severity, and summary counts.
  - shell-out  every other gate carrying a `tool` (gitleaks, semgrep, syft,
               markdownlint, lychee, ...): run it if on PATH; clean exit -> PASS;
               findings -> ADVISORY(error) (or FAIL under --strict / blocking);
               tool absent -> ADVISORY indeterminate.
  - consume    skill-quality skill-behavioral (tool j-rig): CONSUME a j-rig
               Evidence Bundle verdict row (--jrig-verdict PATH or a default
               location). The harness does NOT run behavioral judgment itself —
               it ingests j-rig's verdict. No verdict -> ADVISORY indeterminate.

Stdlib only. No network beyond whatever the shelled-out tool does. No filesystem
mutation.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import classify as C  # noqa: E402

EMPTY_SHA = "sha256:" + hashlib.sha256(b"").hexdigest()
SCAN_DIMENSIONS = {"security", "hygiene", "skill-quality"}

# OSV-Scanner v2 source inputs documented at
# https://google.github.io/osv-scanner/supported-languages-and-lockfiles/.
# A few v2.5 additions (.csproj, Package.resolved) are included even while the
# public compatibility table catches up. Detection is deliberately static so a
# missing scanner cannot turn an applicable dependency gate into a fake pass.
OSV_INPUT_NAMES = {
    "Cargo.lock", "Gemfile.lock", "Pipfile.lock", "Package.resolved",
    "buildscript-gradle.lockfile", "bun.lock", "cabal.project.freeze",
    "composer.lock", "conan.lock",
    "deps.json", "gems.locked", "go.mod", "gradle.lockfile", "mix.lock",
    "osv-scanner.json", "package-lock.json", "packages.config",
    "packages.lock.json", "pdm.lock", "pnpm-lock.yaml", "poetry.lock",
    "pom.xml", "pubspec.lock", "pylock.toml", "renv.lock",
    "stack.yaml.lock", "uv.lock", "yarn.lock",
}
OSV_SKIP_DIRS = {
    ".cache", ".git", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".tox", ".venv", "build", "dist", "node_modules", "target", "venv",
    "vendor",
}
OSV_CMD = [
    "osv-scanner", "scan", "source", "--format=json", "--verbosity=error",
    "--recursive", ".",
]
OSV_DEV_GROUPS = {
    "conancenter": {"build-requires"},
    "maven": {"test"},
    "npm": {"dev"},
    "packagist": {"dev"},
    "pub": {"dev"},
    "pypi": {"dev"},
}
OSV_SEVERITY_FLOORS = {"LOW": 0.1, "MEDIUM": 4.0, "HIGH": 7.0, "CRITICAL": 9.0}
OSV_FINDING_LIMIT = 500

# tool -> argv (run with cwd=repo). "generation" tools (syft) are PASS on exit 0,
# INDETERMINATE on failure (they produce an artifact, they don't pass/fail policy).
TOOL_CMD = {
    "gitleaks": (["gitleaks", "detect", "--no-banner"], "scan"),
    "semgrep": (["semgrep", "scan", "--error", "--quiet"], "scan"),
    "syft": (["syft", "."], "generation"),
    "markdownlint": (["markdownlint", "."], "scan"),
    "lychee": (["lychee", "--offline", "--no-progress", "."], "scan"),
}


def sha256_str(s):
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()


def sha256_paths(repo, paths, prefix=""):
    """Hash path names + bytes so nested lockfiles cannot collide."""
    h = hashlib.sha256(prefix.encode("utf-8"))
    for path in paths:
        rel = os.path.relpath(path, repo).replace(os.sep, "/")
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        h.update(b"\0")
    return "sha256:" + h.hexdigest()


def make_row(gate_id, result, *, policy_hash, input_hash, commit_sha, runner,
             metadata=None, failure_mode=None, advisory_severity=None):
    row = {
        "gate_id": gate_id, "result": result, "policy_hash": policy_hash,
        "input_hash": input_hash,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runner": runner, "commit_sha": commit_sha,
    }
    if metadata:
        row["metadata"] = metadata
    if failure_mode is not None:
        row["failure_mode"] = failure_mode
    if advisory_severity is not None:
        row["advisory_severity"] = advisory_severity
    return row


def gate_suffix(gate_id):
    return gate_id.rsplit(":", 1)[-1]


def indeterminate(gate, commit_sha, runner, reason, policy):
    return make_row(gate["gate_id"], "ADVISORY", policy_hash=sha256_str(policy),
                    input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                    advisory_severity="warn",
                    metadata={"indeterminate": True, "reason": reason})


def find_files(repo, predicate):
    found = []
    for root, dirs, files in os.walk(repo, followlinks=False):
        dirs[:] = sorted(
            d for d in dirs
            if d not in OSV_SKIP_DIRS and not os.path.islink(os.path.join(root, d))
        )
        for name in sorted(files):
            path = os.path.join(root, name)
            if predicate(name, path) and not os.path.islink(path):
                found.append(path)
    return found


def is_osv_input(name, _path):
    if name in OSV_INPUT_NAMES or name.endswith(".csproj"):
        return True
    if name == "verification-metadata.xml":
        return True
    return name == "requirements.txt" or (
        name.startswith("requirements-") and name.endswith(".txt")
    )


def declares_dependencies(name, path):
    """Conservative signal that a dependency graph exists but lacks a scan input."""
    try:
        if name in ("package.json", "composer.json"):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            keys = ("dependencies", "devDependencies", "optionalDependencies",
                    "peerDependencies") if name == "package.json" else ("require", "require-dev")
            return isinstance(data, dict) and any(isinstance(data.get(k), dict) and data[k] for k in keys)
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if name == "Cargo.toml":
        return bool(re.search(r"(?m)^\s*\[(?:dev-|build-)?dependencies(?:\.[^]]+)?\]\s*$", text))
    if name == "pyproject.toml":
        return bool(re.search(r"(?m)^\s*(?:dependencies|requires)\s*=\s*\[", text)
                    or re.search(r"(?m)^\s*\[tool\.poetry\.(?:group\.[^.]+\.)?dependencies\]\s*$", text))
    if name == "Gemfile":
        return bool(re.search(r"(?m)^\s*gem\s+['\"]", text))
    if name in ("build.gradle", "build.gradle.kts"):
        return bool(re.search(r"(?m)^\s*dependencies\s*\{", text))
    return False


def find_dependency_declarations(repo):
    names = {
        "Cargo.toml", "Gemfile", "build.gradle", "build.gradle.kts",
        "composer.json", "package.json", "pyproject.toml",
    }
    return find_files(repo, lambda name, path: name in names and declares_dependencies(name, path))


def safe_source_path(repo, source):
    if not isinstance(source, str) or not source:
        return "unknown"
    if os.path.isabs(source):
        try:
            rel = os.path.relpath(source, repo)
            if rel != ".." and not rel.startswith(".." + os.sep):
                return rel.replace(os.sep, "/")
        except ValueError:
            pass
        return os.path.basename(source)
    return source.replace(os.sep, "/")


def parse_score(value):
    try:
        score = float(value)
        return score if 0 <= score <= 10 else None
    except (TypeError, ValueError):
        return None


def osv_exposure(ecosystem, dependency_groups):
    groups = {str(g).lower() for g in dependency_groups if isinstance(g, str)}
    dev_groups = OSV_DEV_GROUPS.get(str(ecosystem).lower())
    if dev_groups is None:
        return "unknown"
    return "development" if groups & dev_groups else "production"


def parse_osv_findings(payload, repo):
    findings = []
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list):
        raise ValueError("JSON result has no results array")
    for result in results:
        if not isinstance(result, dict):
            continue
        source_obj = result.get("source") if isinstance(result.get("source"), dict) else {}
        source = safe_source_path(repo, source_obj.get("path"))
        packages = result.get("packages") if isinstance(result.get("packages"), list) else []
        for package_result in packages:
            if not isinstance(package_result, dict):
                continue
            package = package_result.get("package")
            package = package if isinstance(package, dict) else {}
            ecosystem = str(package.get("ecosystem") or "unknown")
            dep_groups = package_result.get("dependency_groups")
            dep_groups = dep_groups if isinstance(dep_groups, list) else []
            exposure = osv_exposure(ecosystem, dep_groups)
            groups = package_result.get("groups")
            groups = groups if isinstance(groups, list) else []
            if not groups:
                vulns = package_result.get("vulnerabilities")
                vulns = vulns if isinstance(vulns, list) else []
                groups = [{"ids": [v.get("id")], "max_severity": None}
                          for v in vulns if isinstance(v, dict) and v.get("id")]
            for group in groups:
                if not isinstance(group, dict):
                    continue
                ids = sorted({str(v) for v in group.get("ids", []) if v})
                if not ids:
                    continue
                findings.append({
                    "ids": ids,
                    "package": str(package.get("name") or "unknown"),
                    "version": str(package.get("version") or "unknown"),
                    "ecosystem": ecosystem,
                    "dependency_groups": sorted(str(g) for g in dep_groups),
                    "exposure": exposure,
                    "max_severity": parse_score(group.get("max_severity")),
                    "source": source,
                })
    return findings


def osv_operational_row(gate, commit_sha, runner, *, reason, failure_mode,
                        fail_closed, policy_hash, input_hash, metadata):
    metadata = dict(metadata)
    metadata.update({"indeterminate": True, "reason": reason})
    if fail_closed:
        return make_row(
            gate["gate_id"], "FAIL", policy_hash=policy_hash,
            input_hash=input_hash, commit_sha=commit_sha, runner=runner,
            failure_mode=failure_mode, metadata=metadata,
        )
    return make_row(
        gate["gate_id"], "ADVISORY", policy_hash=policy_hash,
        input_hash=input_hash, commit_sha=commit_sha, runner=runner,
        advisory_severity="warn", metadata=metadata,
    )


def run_osv(repo, gate, commit_sha, runner, strict, fail_closed, severity_threshold):
    inputs = find_files(repo, is_osv_input)
    declarations = find_dependency_declarations(repo)
    configs = find_files(repo, lambda name, _path: name == "osv-scanner.toml")
    rel_inputs = [os.path.relpath(p, repo).replace(os.sep, "/") for p in inputs]
    rel_declarations = [os.path.relpath(p, repo).replace(os.sep, "/") for p in declarations]
    rel_configs = [os.path.relpath(p, repo).replace(os.sep, "/") for p in configs]
    policy = (
        "osv-scanner-v2:source-recursive;"
        f"production-threshold={severity_threshold};"
        "development=advisory;unknown-exposure=production;unknown-severity=blocking"
    )
    policy_hash = sha256_paths(repo, configs, prefix=policy)
    if not inputs:
        if declarations:
            try:
                declaration_hash = sha256_paths(repo, declarations)
            except OSError:
                declaration_hash = EMPTY_SHA
            return osv_operational_row(
                gate, commit_sha, runner,
                reason="dependencies are declared but no supported lockfile or manifest was found",
                failure_mode="scan:osv-lockfile-missing", fail_closed=fail_closed,
                policy_hash=policy_hash, input_hash=declaration_hash,
                metadata={
                    "method": "osv-scanner-v2", "tool": "osv-scanner",
                    "dependency_declarations": rel_declarations,
                    "supported_input_count": 0, "policy_configs": rel_configs,
                },
            )
        return make_row(
            gate["gate_id"], "NOT_APPLICABLE", policy_hash=policy_hash,
            input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
            metadata={
                "method": "osv-scanner-v2", "tool": "osv-scanner",
                "reason": "no supported dependency lockfile or manifest found",
                "dependency_declarations": [], "supported_input_count": 0,
                "policy_configs": rel_configs,
            },
        )

    try:
        input_hash = sha256_paths(repo, inputs)
    except OSError as exc:
        return osv_operational_row(
            gate, commit_sha, runner, reason=f"dependency input could not be hashed: {exc}",
            failure_mode="scan:osv-input-unreadable", fail_closed=fail_closed,
            policy_hash=policy_hash, input_hash=EMPTY_SHA,
            metadata={"method": "osv-scanner-v2", "supported_inputs": rel_inputs},
        )

    base_metadata = {
        "method": "osv-scanner-v2", "tool": "osv-scanner", "command": OSV_CMD,
        "supported_inputs": rel_inputs, "supported_input_count": len(inputs),
        "dependency_declarations": rel_declarations, "policy_configs": rel_configs,
        "severity_threshold": severity_threshold,
    }
    if shutil.which("osv-scanner") is None:
        return osv_operational_row(
            gate, commit_sha, runner,
            reason="osv-scanner not on PATH while dependency inputs exist",
            failure_mode="scan:osv-scanner-unavailable", fail_closed=fail_closed,
            policy_hash=policy_hash, input_hash=input_hash, metadata=base_metadata,
        )

    try:
        version_proc = subprocess.run(
            ["osv-scanner", "--version"], cwd=repo, capture_output=True,
            text=True, timeout=15,
        )
    except Exception as exc:
        return osv_operational_row(
            gate, commit_sha, runner, reason=f"osv-scanner version check failed: {exc}",
            failure_mode="scan:osv-scanner-version-error", fail_closed=fail_closed,
            policy_hash=policy_hash, input_hash=input_hash, metadata=base_metadata,
        )
    version = (version_proc.stdout or version_proc.stderr).strip()[:200]
    base_metadata["tool_version"] = version or "unknown"
    if version_proc.returncode != 0 or not version:
        return osv_operational_row(
            gate, commit_sha, runner,
            reason=f"osv-scanner version check returned exit {version_proc.returncode}",
            failure_mode="scan:osv-scanner-version-error", fail_closed=fail_closed,
            policy_hash=policy_hash, input_hash=input_hash, metadata=base_metadata,
        )

    try:
        proc = subprocess.run(
            OSV_CMD, cwd=repo, capture_output=True, text=True, timeout=300,
        )
    except Exception as exc:
        return osv_operational_row(
            gate, commit_sha, runner, reason=f"osv-scanner failed to run: {exc}",
            failure_mode="scan:osv-scanner-execution-error", fail_closed=fail_closed,
            policy_hash=policy_hash, input_hash=input_hash, metadata=base_metadata,
        )

    base_metadata["scanner_exit_code"] = proc.returncode
    if proc.returncode not in (0, 1):
        detail = (proc.stderr or proc.stdout).strip()[:2000]
        if detail:
            base_metadata["detail"] = detail
        return osv_operational_row(
            gate, commit_sha, runner,
            reason=f"osv-scanner returned operational exit {proc.returncode}",
            failure_mode=("scan:osv-scanner-no-packages" if proc.returncode == 128
                          else "scan:osv-scanner-error"),
            fail_closed=fail_closed, policy_hash=policy_hash,
            input_hash=input_hash, metadata=base_metadata,
        )

    try:
        payload = json.loads(proc.stdout)
        findings = parse_osv_findings(payload, repo)
    except (json.JSONDecodeError, ValueError) as exc:
        return osv_operational_row(
            gate, commit_sha, runner, reason=f"invalid osv-scanner JSON: {exc}",
            failure_mode="scan:osv-scanner-invalid-json", fail_closed=fail_closed,
            policy_hash=policy_hash, input_hash=input_hash, metadata=base_metadata,
        )

    if proc.returncode == 1 and not findings:
        return osv_operational_row(
            gate, commit_sha, runner,
            reason="osv-scanner exit 1 contained no machine-readable vulnerability findings",
            failure_mode="scan:osv-scanner-result-error", fail_closed=fail_closed,
            policy_hash=policy_hash, input_hash=input_hash, metadata=base_metadata,
        )

    floor = OSV_SEVERITY_FLOORS[severity_threshold]
    blocking = [f for f in findings if f["exposure"] != "development"
                and (f["max_severity"] is None or f["max_severity"] >= floor)]
    development = [f for f in findings if f["exposure"] == "development"]
    production = [f for f in findings if f["exposure"] == "production"]
    unknown = [f for f in findings if f["exposure"] == "unknown"]
    metadata = dict(base_metadata)
    metadata.update({
        "finding_count": len(findings),
        "blocking_finding_count": len(blocking),
        "production_finding_count": len(production),
        "development_finding_count": len(development),
        "unknown_exposure_finding_count": len(unknown),
        "unknown_severity_finding_count": sum(f["max_severity"] is None for f in findings),
        "findings": findings[:OSV_FINDING_LIMIT],
        "findings_truncated": len(findings) > OSV_FINDING_LIMIT,
    })
    if not findings:
        return make_row(
            gate["gate_id"], "PASS", policy_hash=policy_hash,
            input_hash=input_hash, commit_sha=commit_sha, runner=runner,
            metadata=metadata,
        )

    enforcement = gate.get("enforcement", "advisory")
    should_fail = strict or enforcement == "blocking" or (fail_closed and bool(blocking))
    if should_fail:
        reason = "findings" if strict or enforcement == "blocking" else "policy-findings"
        return make_row(
            gate["gate_id"], "FAIL", policy_hash=policy_hash,
            input_hash=input_hash, commit_sha=commit_sha, runner=runner,
            failure_mode=f"scan:osv-scanner-{reason}", metadata=metadata,
        )
    material_severity = any(
        f["max_severity"] is None or f["max_severity"] >= floor for f in findings
    )
    return make_row(
        gate["gate_id"], "ADVISORY", policy_hash=policy_hash,
        input_hash=input_hash, commit_sha=commit_sha, runner=runner,
        advisory_severity="error" if material_severity else "warn", metadata=metadata,
    )


def run_readme(repo, gate, commit_sha, runner, strict):
    enforcement = gate.get("enforcement", "advisory")
    present = any(os.path.isfile(os.path.join(repo, n))
                 for n in ("README.md", "README.rst", "README.txt", "README"))
    if present:
        return make_row(gate["gate_id"], "PASS", policy_hash=sha256_str("hygiene:readme"),
                        input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                        metadata={"method": "local-presence", "signal": "README present"})
    result, fm, sev = ("FAIL", "hygiene:readme-missing", None) if (strict or enforcement == "blocking") \
        else ("ADVISORY", None, "warn")
    return make_row(gate["gate_id"], result, policy_hash=sha256_str("hygiene:readme"),
                    input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                    failure_mode=fm, advisory_severity=sev,
                    metadata={"method": "local-presence", "reason": "no README found"})


def run_tool(tool, repo, gate, commit_sha, runner, strict):
    enforcement = gate.get("enforcement", "advisory")
    policy = f"tool:{tool}"
    if tool not in TOOL_CMD:
        return indeterminate(gate, commit_sha, runner,
                             f"no invocation wired for tool '{tool}'", policy)
    if shutil.which(tool) is None:
        return indeterminate(gate, commit_sha, runner,
                             f"{tool} not on PATH — {gate.get('dimension')} unmeasured", policy)
    argv, kind = TOOL_CMD[tool]
    try:
        proc = subprocess.run(argv, cwd=repo, capture_output=True, text=True, timeout=300)
    except Exception as e:
        return indeterminate(gate, commit_sha, runner, f"{tool} failed to run: {e}", policy)
    if proc.returncode == 0:
        return make_row(gate["gate_id"], "PASS", policy_hash=sha256_str(policy),
                        input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                        metadata={"method": "shell-out", "tool": tool})
    if kind == "generation":
        # syft etc. failing to generate is infra, not a policy violation
        return indeterminate(gate, commit_sha, runner,
                             f"{tool} could not generate artifact (exit {proc.returncode})", policy)
    detail = (proc.stdout or proc.stderr).strip()[:2000]
    result, fm, sev = ("FAIL", f"scan:{tool}-findings", None) if (strict or enforcement == "blocking") \
        else ("ADVISORY", None, "error")
    return make_row(gate["gate_id"], result, policy_hash=sha256_str(policy),
                    input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                    failure_mode=fm, advisory_severity=sev,
                    metadata={"method": "shell-out", "tool": tool, "detail": detail})


def consume_jrig(repo, gate, commit_sha, runner, strict, verdict_path):
    """Ingest a j-rig Evidence Bundle verdict row — never run judgment here."""
    policy = "consume:j-rig"
    candidates = [verdict_path] if verdict_path else []
    candidates += [os.path.join(repo, p) for p in
                   (".j-rig/verdict.json", ".jrig/verdict.json", "j-rig-verdict.json")]
    path = next((p for p in candidates if p and os.path.isfile(p)), None)
    if path is None:
        return indeterminate(gate, commit_sha, runner,
                             "no j-rig verdict available — run j-rig eval and pass --jrig-verdict",
                             policy)
    verdict = C.read_json(path)
    if not isinstance(verdict, dict):
        return indeterminate(gate, commit_sha, runner, f"unreadable j-rig verdict at {path}", policy)
    # Pass through j-rig's own result if present; otherwise interpret a boolean pass.
    enforcement = gate.get("enforcement", "advisory")
    jres = verdict.get("result") or ("PASS" if verdict.get("passed") else "FAIL")
    meta = {"method": "consume-j-rig", "source": os.path.relpath(path, repo),
            "jrig": {k: verdict.get(k) for k in ("result", "passed", "layers_passed", "baseline_delta")
                     if k in verdict}}
    if jres == "PASS":
        return make_row(gate["gate_id"], "PASS", policy_hash=sha256_str(policy),
                        input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner, metadata=meta)
    result, fm, sev = ("FAIL", "skill-quality:jrig-fail", None) if (strict or enforcement == "blocking") \
        else ("ADVISORY", None, "error")
    return make_row(gate["gate_id"], result, policy_hash=sha256_str(policy),
                    input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                    failure_mode=fm, advisory_severity=sev, metadata=meta)


def compute_profile(repo, registry_path, profile_arg):
    if profile_arg == "-":
        return json.load(sys.stdin)
    if profile_arg:
        with open(profile_arg, "r", encoding="utf-8") as f:
            return json.load(f)
    out = subprocess.run([sys.executable, os.path.join(HERE, "classify.py"), repo,
                          "--registry", registry_path], capture_output=True, text=True)
    if out.returncode != 0:
        sys.stderr.write(out.stderr)
        raise SystemExit(2)
    return json.loads(out.stdout)


def main():
    ap = argparse.ArgumentParser(description="Security/hygiene/skill-quality gate-runner -> gate-result/v1")
    ap.add_argument("repo", nargs="?", default=".")
    ap.add_argument("--strict", action="store_true", help="treat a finding/gap as FAIL (exit 1)")
    ap.add_argument(
        "--fail-closed", action="store_true",
        help=("require OSV measurement when a supported dependency input exists; "
              "FAIL on scanner errors and production/unknown findings at the severity threshold"),
    )
    ap.add_argument(
        "--osv-severity-threshold", choices=tuple(OSV_SEVERITY_FLOORS), default="HIGH",
        help="minimum production/unknown OSV severity blocked by --fail-closed (default: HIGH)",
    )
    ap.add_argument("--registry", default=C.DEFAULT_REGISTRY)
    ap.add_argument("--profile", default=None, help="pinned audit-profile/v1 (PATH or '-')")
    ap.add_argument("--jrig-verdict", default=None, help="path to a j-rig Evidence Bundle verdict to consume")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    runner = f"audit-harness@{C.harness_version()}"

    override_path = os.path.join(repo, ".audit-harness.yml")
    override = C.parse_override(override_path) if os.path.isfile(override_path) else {"disable": False}
    if override.get("disable") or os.environ.get("AUDIT_HARNESS_DISABLE") == "1":
        sys.stderr.write("audit-harness: KILL-SWITCH active — scan skipped (no rows emitted)\n")
        print("[]")
        sys.exit(0)

    profile = compute_profile(repo, os.path.abspath(args.registry), args.profile)
    commit_sha = profile.get("subject", {}).get("commit_sha") or C.git_short_sha(repo)

    gates = [g for g in profile.get("gates", [])
             if g.get("dimension") in SCAN_DIMENSIONS and g.get("enforcement") != "disabled"]

    rows = []
    for gate in gates:
        suffix = gate_suffix(gate["gate_id"])
        tool = gate.get("tool")
        if suffix == "hygiene-readme":
            rows.append(run_readme(repo, gate, commit_sha, runner, args.strict))
        elif tool == "j-rig":
            rows.append(consume_jrig(repo, gate, commit_sha, runner, args.strict, args.jrig_verdict))
        elif tool == "osv-scanner":
            rows.append(run_osv(
                repo, gate, commit_sha, runner, args.strict, args.fail_closed,
                args.osv_severity_threshold,
            ))
        elif tool:
            rows.append(run_tool(tool, repo, gate, commit_sha, runner, args.strict))
        else:
            rows.append(indeterminate(gate, commit_sha, runner,
                                      f"gate '{suffix}' has no tool wired in this harness version",
                                      f"scan:{suffix}"))

    print(json.dumps(rows, indent=2))
    n_fail = sum(1 for r in rows if r["result"] == "FAIL")
    n_adv = sum(1 for r in rows if r["result"] == "ADVISORY")
    n_pass = sum(1 for r in rows if r["result"] == "PASS")
    n_na = sum(1 for r in rows if r["result"] == "NOT_APPLICABLE")
    sys.stderr.write(
        f"audit-harness scan: {n_pass} PASS, {n_adv} ADVISORY, {n_fail} FAIL, "
        f"{n_na} NOT_APPLICABLE across {len(rows)} gate(s)\n"
    )
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
