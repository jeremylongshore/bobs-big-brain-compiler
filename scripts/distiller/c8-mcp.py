#!/usr/bin/env python3
"""Apply the existing C8 policy to nightly capture before the native MCP sees it.

Protocol and diagnostics stay on separate streams. Policy receipts contain no corpus
text. The native server remains the owner of dedupe, promotion and its audit chain.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading


ALLOWED_TOOLS = {
    "brain_search", "brain_status", "brain_audit_verify", "brain_capture", "brain_govern"
}


def native_config(path):
    config = json.loads(Path(path).read_text())["mcpServers"]["governed-brain"]
    command = [config["command"], *config.get("args", [])]
    if not all(isinstance(value, str) and value for value in command):
        raise ValueError("invalid native MCP command")
    env = os.environ.copy()
    env.update({key: os.path.expandvars(str(value)) for key, value in config.get("env", {}).items()})
    # This job owns the local brain, never an inherited remote/team-mode writer.
    env.pop("TEAMKB_API_URL", None)
    env.pop("TEAMKB_API_TOKEN", None)
    return [os.path.expandvars(value) for value in command], env


def authorize_capture(arguments, gate, receipts):
    if not isinstance(arguments, dict):
        return False, "invalid-capture"
    candidate = {"text": json.dumps(arguments, sort_keys=True, ensure_ascii=False)}
    try:
        receipt_path = Path(receipts)
        previous_size = receipt_path.stat().st_size if receipt_path.exists() else 0
        result = subprocess.run(
            ["bash", gate, "--receipts", receipts], input=json.dumps(candidate) + "\n",
            text=True, capture_output=True, timeout=20, check=False,
        )
        accepted = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return False, "policy-unavailable"
    if result.returncode != 0:
        return False, "policy-unavailable"
    if len(accepted) != 1 or accepted[0].get("text") != candidate["text"]:
        return False, "policy-rejected"
    try:
        with receipt_path.open("rb") as stream:
            stream.seek(previous_size)
            decisions = [json.loads(line) for line in stream if line.strip()]
        digest = hashlib.sha256(candidate["text"].encode()).hexdigest()
        if not any(row.get("decision") == "pass" and row.get("sink") == "brain-ingest" and
                   row.get("content_sha256") == digest for row in decisions):
            return False, "policy-receipt-unavailable"
    except (OSError, ValueError, AttributeError):
        return False, "policy-receipt-unavailable"
    return True, "accepted"


def proxy(config, gate, receipts):
    command, env = native_config(config)
    child = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    output_lock = threading.Lock()

    def emit(message):
        with output_lock:
            sys.stdout.write(json.dumps(message) + "\n")
            sys.stdout.flush()

    def downstream():
        for line in child.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                print("c8-mcp: invalid native protocol", file=sys.stderr)
                child.terminate()
                return
            result = message.get("result")
            if isinstance(result, dict) and isinstance(result.get("tools"), list):
                result["tools"] = [tool for tool in result["tools"] if tool.get("name") in ALLOWED_TOOLS]
            emit(message)

    reader = threading.Thread(target=downstream, daemon=True)
    reader.start()
    try:
        for line in sys.stdin:
            message = json.loads(line)
            if message.get("method") == "tools/call":
                params = message.get("params", {})
                name = params.get("name")
                accepted, category = name in ALLOWED_TOOLS, "tool-not-allowed"
                if name == "brain_capture":
                    accepted, category = authorize_capture(params.get("arguments"), gate, receipts)
                    print(f"c8-mcp: capture {category}", file=sys.stderr)
                if not accepted:
                    emit({"jsonrpc": "2.0", "id": message.get("id"), "result": {
                        "isError": True, "content": [{"type": "text", "text": f"Nightly governance refused: {category}"}],
                    }})
                    continue
            child.stdin.write(json.dumps(message) + "\n")
            child.stdin.flush()
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        reader.join(timeout=1)
    return child.returncode


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--gate", required=True)
    parser.add_argument("--receipts", required=True)
    args = parser.parse_args()
    try:
        return proxy(args.config, args.gate, args.receipts)
    except (OSError, ValueError, KeyError, TypeError):
        print("c8-mcp: configuration or protocol failure", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
