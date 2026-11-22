-- Migration: 007-source-capture-custody
-- No backfill: legacy registrations do not establish authenticated capture.
-- === UP ===
CREATE TABLE source_capture_custody (
    source_id TEXT PRIMARY KEY REFERENCES sources(id),
    content_hash TEXT NOT NULL,
    unknown_origin INTEGER NOT NULL CHECK (unknown_origin IN (0, 1)),
    bindings_json TEXT NOT NULL,
    record_hash TEXT NOT NULL
);
-- === DOWN ===
DROP TABLE IF EXISTS source_capture_custody;
