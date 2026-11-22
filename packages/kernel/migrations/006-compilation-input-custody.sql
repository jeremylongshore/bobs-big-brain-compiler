-- Migration: 006-compilation-input-custody
-- Description: Exact output commitments and complete deterministic input closures.
-- No backfill: historical attribution is not complete input custody.
-- === UP ===
CREATE TABLE compilation_input_custody (
    output_path TEXT PRIMARY KEY,
    output_hash TEXT NOT NULL,
    roots_json TEXT NOT NULL,
    record_hash TEXT NOT NULL
);
-- === DOWN ===
DROP TABLE IF EXISTS compilation_input_custody;
