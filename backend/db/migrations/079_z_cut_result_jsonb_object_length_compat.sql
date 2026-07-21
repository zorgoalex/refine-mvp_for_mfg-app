-- PostgreSQL exposes jsonb_array_length but has no jsonb_object_length helper.
-- Runtime preference updates use the latter to enforce a bounded JSON object,
-- so install the immutable compatibility helper before later migrations.

BEGIN;

CREATE OR REPLACE FUNCTION jsonb_object_length(p_value JSONB)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT count(*)::INTEGER FROM jsonb_object_keys(p_value)
$$;

COMMIT;

-- Down (only after removing every dependent query/function):
-- DROP FUNCTION IF EXISTS jsonb_object_length(JSONB);
