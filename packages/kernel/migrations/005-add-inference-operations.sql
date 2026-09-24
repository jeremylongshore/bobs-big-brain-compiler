-- Migration: 005-add-inference-operations
-- Description: Record provider usage once per successful API operation.
-- Date: 2026-08-16

-- === UP ===

CREATE TABLE inference_operations (
    id                 TEXT    PRIMARY KEY,
    run_id             TEXT    NOT NULL,
    operation_sequence INTEGER NOT NULL,
    operation_type     TEXT    NOT NULL,
    occurred_at        TEXT    NOT NULL,
    model              TEXT    NOT NULL,
    input_tokens       INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens      INTEGER NOT NULL CHECK (output_tokens >= 0),
    UNIQUE (run_id, operation_sequence)
);

CREATE INDEX idx_inference_operations_occurred_at
    ON inference_operations(occurred_at);
CREATE INDEX idx_inference_operations_type
    ON inference_operations(operation_type);

-- === DOWN ===

DROP INDEX IF EXISTS idx_inference_operations_type;
DROP INDEX IF EXISTS idx_inference_operations_occurred_at;
DROP TABLE IF EXISTS inference_operations;
