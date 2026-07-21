-- PostgreSQL exposes jsonb_array_length but has no jsonb_object_length helper.
-- Migration 080 uses the latter in immutable snapshot validation, so define
-- the compatibility function before finalize runs.

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

-- Down (only after removing every dependent constraint/function):
-- DROP FUNCTION IF EXISTS jsonb_object_length(JSONB);
