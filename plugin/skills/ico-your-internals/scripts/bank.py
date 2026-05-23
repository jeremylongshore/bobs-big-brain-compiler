#!/usr/bin/env python3
"""
bank.py — question-bank schema parser.

Loads both v1 (one `question:` per entry) and v2 (one `intent:` per entry
with a `paraphrases:` list-of-dicts) banks. Emits a uniform iteration
surface — (intent_id, paraphrase_idx, text, style, primary, ground-truth
fields) tuples — so downstream consumers (run.sh's ask loop, the verify
pipeline, render-summary) never have to branch on schema shape.

See:
- ADR-029 (000-docs/029-AT-DECR-schema-primitive-2026-05-22.md) for the
  schema rationale.
- ADR-032 (000-docs/032-AT-DECR-paraphrase-runtime-mode-flag-2026-05-22.md)
  for the `mode='primary'|'all'` semantics consumed here.

Public API:
    load_bank(path: str) -> dict       # parsed + validated bank
    iter_prompts(bank, mode='all')     # yields prompt dicts
    BankSchemaError                    # raised on invalid banks

Prompt dict shape (single source of truth for downstream consumers):

    {
      "intent_id":          "Q01",          # stable id from the bank
      "paraphrase_idx":     0,              # positional, 0-based, stable
      "text":               "<question>",   # what to actually ask ICO
      "style":              "direct",       # paraphrase style label
      "primary":            True,           # whether this is the primary
      "expected_substrings": [...],         # per-intent ground truth
      "expected_sources":   [...],          # per-intent ground truth
      "verification_mode":  "strong",       # per-intent
      "recall_floor":       0.6,            # optional, per-intent (or None)
      "notes":              "...",          # optional, per-intent
    }
"""
from __future__ import annotations

import pathlib
from typing import Any, Iterator

import yaml


class BankSchemaError(ValueError):
    """Raised when a bank file's shape violates the schema contract."""


_VALID_MODES = {"primary", "all"}


def load_bank(path: str) -> dict[str, Any]:
    """Load + validate a bank file. Returns the canonicalized bank dict.

    The returned dict has a `_canonical_entries` field — a list of fully
    normalized intent records where each entry carries its paraphrases as a
    list-of-dicts regardless of whether the source file was v1 or v2.
    Downstream code consumes `_canonical_entries` and is shape-agnostic.

    Raises BankSchemaError on any validation failure with a message that
    names the offending intent so authors can fix it.
    """
    raw = yaml.safe_load(pathlib.Path(path).read_text())
    if not isinstance(raw, dict):
        raise BankSchemaError(f"{path}: top-level YAML must be a mapping")

    entries = raw.get("questions") or []
    if not isinstance(entries, list) or not entries:
        raise BankSchemaError(f"{path}: 'questions' must be a non-empty list")

    # Classify each entry as v1 (has `question:`) or v2 (has `paraphrases:`).
    # Mixed banks are rejected — see ADR-029 § Decision.
    shapes = {
        _classify_entry(e, idx, path) for idx, e in enumerate(entries)
    }
    if len(shapes) > 1:
        raise BankSchemaError(
            f"{path}: mixed v1/v2 question shapes detected — every entry must "
            f"use the same shape. Found shapes: {sorted(shapes)}. Half-migrated "
            f"banks are inconsistent and corrupt the trend metric."
        )

    canonical: list[dict[str, Any]] = []
    for idx, entry in enumerate(entries):
        canonical.append(_canonicalize(entry, idx, path))

    raw["_canonical_entries"] = canonical
    raw["_schema_shape"] = next(iter(shapes))  # 'v1' or 'v2'
    return raw


def iter_prompts(
    bank: dict[str, Any], mode: str = "all"
) -> Iterator[dict[str, Any]]:
    """Yield one prompt dict per (intent, paraphrase) pair to ask ICO.

    mode='all'     — every declared paraphrase.
    mode='primary' — only the paraphrase flagged primary per intent.

    On v1 banks both modes yield identical output (each intent has exactly
    one synthetic primary paraphrase).
    """
    if mode not in _VALID_MODES:
        raise ValueError(
            f"unknown paraphrase mode: {mode!r} (expected one of {sorted(_VALID_MODES)})"
        )

    for entry in bank.get("_canonical_entries", []):
        for p in entry["paraphrases"]:
            if mode == "primary" and not p["primary"]:
                continue
            yield {
                "intent_id": entry["intent_id"],
                "paraphrase_idx": p["paraphrase_idx"],
                "text": p["text"],
                "style": p["style"],
                "primary": p["primary"],
                "expected_substrings": entry["expected_substrings"],
                "expected_sources": entry["expected_sources"],
                "verification_mode": entry["verification_mode"],
                "recall_floor": entry["recall_floor"],
                "notes": entry["notes"],
            }


# ---------- internal helpers ----------


def _classify_entry(entry: Any, idx: int, path: str) -> str:
    if not isinstance(entry, dict):
        raise BankSchemaError(
            f"{path}: entry #{idx} is not a mapping (got {type(entry).__name__})"
        )
    has_question = "question" in entry
    has_paraphrases = "paraphrases" in entry
    if has_paraphrases and not has_question:
        return "v2"
    if has_question and not has_paraphrases:
        return "v1"
    if has_question and has_paraphrases:
        raise BankSchemaError(
            f"{path}: entry id={entry.get('id', '?')!r} declares BOTH "
            f"`question:` (v1) AND `paraphrases:` (v2) — pick one shape"
        )
    raise BankSchemaError(
        f"{path}: entry id={entry.get('id', '?')!r} has neither "
        f"`question:` (v1) nor `paraphrases:` (v2)"
    )


def _canonicalize(entry: dict[str, Any], idx: int, path: str) -> dict[str, Any]:
    """Normalize a v1 or v2 entry into the canonical {intent_id, paraphrases:[…]} shape."""
    intent_id = entry.get("id")
    if not isinstance(intent_id, str) or not intent_id:
        raise BankSchemaError(f"{path}: entry #{idx} missing required `id`")

    if "paraphrases" in entry:
        paraphrases = _canonicalize_paraphrases(entry["paraphrases"], intent_id, path)
        # ADR-029: exactly one primary per intent.
        primary_count = sum(1 for p in paraphrases if p["primary"])
        if primary_count != 1:
            raise BankSchemaError(
                f"{path}: intent {intent_id!r} has {primary_count} paraphrases "
                f"flagged `primary: true` — exactly one is required"
            )
    else:
        # v1 shape: synthesize a single primary paraphrase from `question:`.
        text = entry.get("question")
        if not isinstance(text, str) or not text.strip():
            raise BankSchemaError(
                f"{path}: v1 entry {intent_id!r} missing/empty `question:` field"
            )
        paraphrases = [
            {
                "paraphrase_idx": 0,
                "text": text.strip(),
                "style": "legacy",
                "primary": True,
            }
        ]

    return {
        "intent_id": intent_id,
        "paraphrases": paraphrases,
        "expected_substrings": entry.get("expected_substrings") or [],
        "expected_sources": entry.get("expected_sources") or [],
        "verification_mode": entry.get("verification_mode") or "strong",
        "recall_floor": entry.get("recall_floor"),
        "notes": entry.get("notes"),
    }


def _canonicalize_paraphrases(
    raw: Any, intent_id: str, path: str
) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise BankSchemaError(
            f"{path}: intent {intent_id!r} `paraphrases` must be a non-empty list"
        )
    canonical: list[dict[str, Any]] = []
    for idx, p in enumerate(raw):
        if not isinstance(p, dict):
            raise BankSchemaError(
                f"{path}: intent {intent_id!r} paraphrase #{idx} is not a mapping"
            )
        text = p.get("text")
        style = p.get("style")
        primary = p.get("primary")
        if not isinstance(text, str) or not text.strip():
            raise BankSchemaError(
                f"{path}: intent {intent_id!r} paraphrase #{idx} missing/empty `text`"
            )
        if not isinstance(style, str) or not style.strip():
            raise BankSchemaError(
                f"{path}: intent {intent_id!r} paraphrase #{idx} missing/empty `style`"
            )
        if not isinstance(primary, bool):
            raise BankSchemaError(
                f"{path}: intent {intent_id!r} paraphrase #{idx} `primary` "
                f"must be a literal boolean (got {type(primary).__name__})"
            )
        canonical.append(
            {
                "paraphrase_idx": idx,
                "text": text.strip(),
                "style": style.strip(),
                "primary": primary,
            }
        )
    return canonical
