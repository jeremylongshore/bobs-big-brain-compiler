-- Migration: 005-add-spool-emissions
-- Description: Track the last successful spool emission for each compiled page
-- Date: 2026-08-02

-- === UP ===

CREATE TABLE spool_emissions (
    page_path    TEXT    PRIMARY KEY,
    body_sha256  TEXT    NOT NULL,
    tenant_id    TEXT    NOT NULL,
    bulk_import  INTEGER NOT NULL DEFAULT 0 CHECK (bulk_import IN (0, 1)),
    scope        TEXT    NOT NULL CHECK (scope IN ('wiki', 'outputs', 'all')),
    emitted_at   TEXT    NOT NULL,
    spool_file   TEXT    NOT NULL
);

CREATE INDEX idx_spool_emissions_body_sha256 ON spool_emissions(body_sha256);

-- === DOWN ===

DROP INDEX IF EXISTS idx_spool_emissions_body_sha256;
DROP TABLE IF EXISTS spool_emissions;
