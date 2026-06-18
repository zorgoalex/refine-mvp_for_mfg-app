-- Migration 024: add optimistic-concurrency version to sheet_material_types (additive)
-- Slice 2's /configuration cut-config CRUD does optimistic-version reads/writes on
-- sheet_material_types (mapSheet reads `version`; upsert does `version = version + 1`),
-- but migration 021 created the table without a `version` column. This adds it so the
-- backend cut-config admin works against a 021-built schema. Additive + idempotent.
-- Plan: spec_erp/plans/2026-06-18-freecut-cut-jobs-and-svg-render-plan.md §4a
BEGIN;

ALTER TABLE sheet_material_types
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

COMMIT;
