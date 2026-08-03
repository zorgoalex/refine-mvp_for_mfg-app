-- Order-card SSE invalidation foundation.
-- Internal commit_sequence is never exposed to clients; public cursors contain
-- only independently incremented, permission-visible domain revisions.

BEGIN;

CREATE TABLE IF NOT EXISTS order_realtime_stream (
  order_id BIGINT PRIMARY KEY REFERENCES orders(order_id) ON DELETE CASCADE,
  commit_sequence BIGINT NOT NULL DEFAULT 0,
  detail_status_revision BIGINT NOT NULL DEFAULT 0,
  cut_refs_revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_order_realtime_stream_commit_sequence
    CHECK (commit_sequence >= 0),
  CONSTRAINT chk_order_realtime_stream_detail_status_revision
    CHECK (detail_status_revision >= 0),
  CONSTRAINT chk_order_realtime_stream_cut_refs_revision
    CHECK (cut_refs_revision >= 0)
);

INSERT INTO order_realtime_stream (order_id)
SELECT order_id
FROM orders
ON CONFLICT (order_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS realtime_event_log (
  order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  commit_sequence BIGINT NOT NULL,
  detail_status_revision BIGINT,
  cut_refs_revision BIGINT,
  domains TEXT[] NOT NULL,
  detail_ids BIGINT[],
  schema_version SMALLINT NOT NULL DEFAULT 1,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_realtime_event_log PRIMARY KEY (order_id, commit_sequence),
  CONSTRAINT uq_realtime_event_log_source UNIQUE (order_id, source_key),
  CONSTRAINT chk_realtime_event_log_commit_sequence CHECK (commit_sequence > 0),
  CONSTRAINT chk_realtime_event_log_schema_version CHECK (schema_version = 1),
  CONSTRAINT chk_realtime_event_log_domains CHECK (
    cardinality(domains) BETWEEN 1 AND 2
    AND domains <@ ARRAY['detail_status', 'cut_refs']::TEXT[]
  ),
  CONSTRAINT chk_realtime_event_log_domain_revisions CHECK (
    (detail_status_revision IS NOT NULL) = ('detail_status' = ANY(domains))
    AND (cut_refs_revision IS NOT NULL) = ('cut_refs' = ANY(domains))
  )
);

CREATE INDEX IF NOT EXISTS idx_realtime_event_log_created_at
  ON realtime_event_log(created_at);

CREATE INDEX IF NOT EXISTS idx_realtime_event_log_detail_status_replay
  ON realtime_event_log(order_id, detail_status_revision, commit_sequence)
  WHERE detail_status_revision IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_realtime_event_log_cut_refs_replay
  ON realtime_event_log(order_id, cut_refs_revision, commit_sequence)
  WHERE cut_refs_revision IS NOT NULL;

COMMIT;
