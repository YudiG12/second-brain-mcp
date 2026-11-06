-- What is in the semantic index (ADR 010). Written only by the Queue consumer.
CREATE TABLE manifest (
  path       TEXT PRIMARY KEY,
  sha        TEXT NOT NULL,     -- Git blob sha of the indexed version
  chunks     INTEGER NOT NULL,
  indexed_at TEXT NOT NULL      -- ISO 8601, UTC
);

-- Messages that exhausted their retries, and anything else that needs a human (spec v2 §4.4).
CREATE TABLE alerts (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,    -- dlq | reconcile
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
