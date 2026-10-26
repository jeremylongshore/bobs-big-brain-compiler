#!/usr/bin/env python3
"""bundle-append.py: append one gate-result/v1 Statement to an Evidence Bundle.

Invoked by `emit-evidence.sh --append-to BUNDLE` with the composed, unsigned
in-toto Statement on stdin. The bundle is the plain JSON array of Statements
that intent-rollout-gate's `bundle-path` consumes (kernel EvidenceBundlePayload).

Validation has two halves, and neither restates the kernel by hand:

* Predicate body: validated against the frozen kernel schema snapshot shipped
  at schemas/kernel-snapshot/gate-result-v1.schema.json (a byte copy of the
  regression suite's kernel fixture, hash-pinned in .harness-hash). The small
  validator below interprets that schema; it knows JSON Schema keywords, not
  gate-result rules, and REFUSES any keyword it does not implement so a kernel
  update can never be silently under-validated. To refresh after a kernel
  change: update tests/fixtures/gate-result-v1.schema.json, copy it byte for
  byte to the snapshot path, extend this validator if the suite reports an
  unsupported keyword or format, then re-pin with `audit-harness init`.
* Statement envelope: the Evidence Bundle SPEC rules the kernel schema leaves
  to the envelope (R8 subject name == gate_id, R9 subject digest ==
  input_hash, the in-toto _type, the gate-result predicateType).

A row whose id (subject name == gate_id) already exists is refused. The write
is atomic (temp file in the same directory, fsync, os.replace) under an
exclusive flock on BUNDLE.lock, so every refusal leaves the bundle unchanged.

Exit 0 = appended; exit 1 = refused (message on stderr). stdlib only; POSIX
only (fcntl), like the bash 4 emit-evidence.sh that invokes it.
"""

import json
import os
import re
import sys
import tempfile

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX Python
    fcntl = None

STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
PREDICATE_URI = "https://evals.intentsolutions.io/gate-result/v1"
SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "schemas",
                           "kernel-snapshot", "gate-result-v1.schema.json")

# Keywords the validator implements, plus annotation-only keywords it may ignore.
ANNOTATIONS = {"$schema", "$id", "$defs", "title", "description", "x-derived-from", "examples"}
IMPLEMENTED = {"type", "enum", "const", "pattern", "format", "minLength", "minimum", "required",
               "properties", "additionalProperties", "items", "minItems", "allOf", "if", "then",
               "$ref"}
RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
TYPES = {"object": dict, "array": list, "string": str, "boolean": bool}


class SchemaError(Exception):
    """The snapshot uses a construct this validator cannot interpret."""


def _type_ok(value, t):
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "null":
        return value is None
    if t not in TYPES:
        raise SchemaError(f"unsupported type {t!r}")
    return isinstance(value, TYPES[t]) and not (t != "boolean" and isinstance(value, bool))


def validate(inst, schema, root, path="$"):
    """Return violation strings for inst against schema ([] == valid)."""
    unknown = set(schema) - IMPLEMENTED - ANNOTATIONS
    if unknown:
        raise SchemaError(f"unsupported keyword(s) {sorted(unknown)} at {path}")
    if schema.get("format", "date-time") != "date-time":
        raise SchemaError(f"unsupported format {schema['format']!r} at {path}")
    errs = []
    if "$ref" in schema:  # applies alongside sibling keywords (draft 2020-12)
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise SchemaError(f"non-local $ref {ref!r}")
        target = root
        for part in ref[2:].split("/"):
            target = target[part]
        errs += validate(inst, target, root, path)
    t = schema.get("type")
    if t is not None and not any(_type_ok(inst, x) for x in (t if isinstance(t, list) else [t])):
        return errs + [f"{path}: expected {t}"]
    if "enum" in schema and inst not in schema["enum"]:
        errs.append(f"{path}: {inst!r} not in {schema['enum']}")
    if "const" in schema and inst != schema["const"]:
        errs.append(f"{path}: {inst!r} != {schema['const']!r}")
    if isinstance(inst, str):
        if len(inst) < schema.get("minLength", 0):
            errs.append(f"{path}: shorter than {schema['minLength']}")
        if "pattern" in schema and re.search(schema["pattern"], inst) is None:
            errs.append(f"{path}: {inst!r} does not match {schema['pattern']}")
        if schema.get("format") == "date-time" and not RFC3339.match(inst):
            errs.append(f"{path}: {inst!r} is not an RFC 3339 date-time")
    if isinstance(inst, (int, float)) and not isinstance(inst, bool) and "minimum" in schema:
        if inst < schema["minimum"]:
            errs.append(f"{path}: below minimum {schema['minimum']}")
    if isinstance(inst, list):
        if len(inst) < schema.get("minItems", 0):
            errs.append(f"{path}: fewer than {schema['minItems']} item(s)")
        if isinstance(schema.get("items"), dict):
            for i, el in enumerate(inst):
                errs += validate(el, schema["items"], root, f"{path}[{i}]")
    if isinstance(inst, dict):
        errs += [f"{path}: missing '{k}'" for k in schema.get("required", []) if k not in inst]
        props = schema.get("properties", {})
        for k, sub in props.items():
            if k in inst:
                errs += validate(inst[k], sub, root, f"{path}.{k}")
        ap = schema.get("additionalProperties", True)
        for k in inst:
            if k not in props:
                if ap is False:
                    errs.append(f"{path}: '{k}' is not allowed")
                elif isinstance(ap, dict):
                    errs += validate(inst[k], ap, root, f"{path}.{k}")
    for sub in schema.get("allOf", []):
        errs += validate(inst, sub, root, path)
    if "if" in schema and not validate(inst, schema["if"], root, path) and "then" in schema:
        errs += validate(inst, schema["then"], root, path)
    return errs


def row_errors(row, schema):
    if not isinstance(row, dict):
        return ["row is not a JSON object"]
    errs = []
    if row.get("_type") != STATEMENT_TYPE:
        errs.append(f"_type must be {STATEMENT_TYPE}")
    if row.get("predicateType") != PREDICATE_URI:
        errs.append(f"predicateType must be {PREDICATE_URI}")
    pred = row.get("predicate")
    if not isinstance(pred, dict):
        return errs + ["predicate must be an object"]
    errs += validate(pred, schema, schema, "predicate")
    subject = row.get("subject")
    if not (isinstance(subject, list) and len(subject) == 1 and isinstance(subject[0], dict)):
        return errs + ["subject must be a one-element array of objects"]
    if subject[0].get("name") != pred.get("gate_id"):
        errs.append("subject[0].name must equal predicate.gate_id (SPEC R8)")
    digest = subject[0].get("digest")
    sha = digest.get("sha256") if isinstance(digest, dict) else None
    if not isinstance(sha, str) or pred.get("input_hash") != f"sha256:{sha}":
        errs.append("subject[0].digest.sha256 must equal predicate.input_hash (SPEC R9)")
    return errs


def refuse(msg):
    sys.stderr.write(f"emit-evidence: --append-to refused: {msg}\n")
    sys.exit(1)


def main(argv):
    if len(argv) != 2:
        refuse("usage: bundle-append.py BUNDLE < statement.json")
    path = argv[1]
    if fcntl is None:
        refuse("requires POSIX file locking (this Python has no fcntl); "
               "emit-evidence already requires bash 4 on a POSIX host")
    try:
        with open(SCHEMA_PATH, encoding="utf-8") as fh:
            schema = json.load(fh)
        new_row = json.loads(sys.stdin.read())
    except (OSError, ValueError) as exc:
        refuse(f"cannot load the kernel snapshot or the new row ({exc})")
    try:
        errs = row_errors(new_row, schema)
        if errs:
            refuse("the new row is not a valid gate-result/v1 Statement: " + "; ".join(errs))
        directory = os.path.dirname(os.path.abspath(path))
        os.makedirs(directory, exist_ok=True)
        with open(path + ".lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            rows = []
            if os.path.exists(path):
                try:
                    with open(path, encoding="utf-8") as fh:
                        rows = json.load(fh)
                except (OSError, ValueError) as exc:
                    refuse(f"{path} is not readable JSON ({exc})")
                if not isinstance(rows, list):
                    refuse(f"{path} must be a JSON array of Statements "
                           "(the v1 container form is read-only)")
                for i, row in enumerate(rows):
                    row_errs = row_errors(row, schema)
                    if row_errs:
                        refuse(f"{path} row {i} is invalid: " + "; ".join(row_errs))
            row_id = new_row["predicate"]["gate_id"]
            if any(r["predicate"]["gate_id"] == row_id for r in rows):
                refuse(f"{path} already holds a row with id {row_id}")
            rows.append(new_row)
            fd, tmp = tempfile.mkstemp(prefix=".emit-evidence-", suffix=".json", dir=directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(rows, fh, indent=2)
                    fh.write("\n")
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, path)
            except BaseException:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise
    except SchemaError as exc:
        refuse(f"kernel snapshot uses a construct this validator does not implement ({exc}); "
               "update scripts/bundle-append.py with the snapshot")
    sys.stderr.write(f"emit-evidence: appended {row_id} to {path} ({len(rows)} row(s))\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
