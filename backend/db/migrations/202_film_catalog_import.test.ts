import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('202 film catalog import migration', () => {
  const sql = readFileSync(new URL('./202_film_catalog_import.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('adds catalog fields and tables without changing existing data', () => {
    for (const column of ['canonical_film_id', 'nomenclature_type', 'nomenclature_category', 'catalog_key']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const table of ['catalog_import_batches', 'catalog_import_rows', 'catalog_import_matches',
      'vendor_import_aliases', 'film_name_history']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    expect(sql).not.toMatch(/^\s*UPDATE\s+public\./im);
    expect(sql.match(/^\s*INSERT INTO public\./gim) ?? []).toHaveLength(1);
    expect(sql).toMatch(/INSERT INTO public\.film_name_history/);
  });

  it('protects canonical ownership, merge shape, and catalog identity', () => {
    for (const name of ['chk_films_canonical_not_self', 'chk_films_merged_inactive',
      'chk_films_merged_no_keys', 'chk_films_catalog_key_format']) {
      expect(sql).toContain(name);
    }
    expect(sql).toContain("USING ERRCODE = '42501'");
    expect(sql).toContain("USING ERRCODE = '23514'");
    expect(sql).toContain("current_setting('erp.film_catalog', true)");
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('uq_films_name_vendor_canonical');
    expect(sql).toContain('uq_films_catalog_key');
    expect(sql).toContain('idx_films_canonical');
  });

  it('keeps import staging constraints and records safe rename provenance', () => {
    expect(sql).toContain("source_kind IN ('file', 'onec_mirror')");
    expect(sql).toContain("row_status = 'ok'");
    expect(sql).toContain("fingerprint ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('gin_trgm_ops');
    expect(sql).toContain("current_setting('erp.film_change_actor', true)");
    expect(sql).toContain("current_setting('hasura.user', true)");
    expect(sql).toContain("current_setting('app.user_id', true)");
    expect(sql).not.toContain('NEW.edited_by');
    expect(sql).toContain('EXCEPTION WHEN OTHERS');
  });

  it('probes all new objects before the migration runner records the ledger', () => {
    expect(runner).toContain('202_film_catalog_import*) probe_all');
    for (const table of ['catalog_import_batches', 'catalog_import_rows', 'catalog_import_matches',
      'vendor_import_aliases', 'film_name_history']) {
      expect(runner).toContain(`q_tbl ${table}`);
    }
    for (const object of ['chk_films_canonical_not_self', 'chk_films_merged_inactive', 'chk_films_merged_no_keys',
      'chk_films_catalog_key_format', 'chk_catalog_import_batches_source_kind', 'chk_catalog_import_batches_source',
      'chk_catalog_import_rows_status', 'chk_catalog_import_matches_fingerprint', 'chk_vendor_import_aliases_source_norm',
      'chk_film_name_history_source']) {
      expect(runner).toContain(object);
    }
    for (const index of ['uq_films_name_vendor_canonical', 'uq_films_catalog_key', 'idx_films_canonical',
      'uq_catalog_import_rows_key', 'idx_catalog_import_matches_batch_row', 'idx_film_name_history_film',
      'idx_film_name_history_old_trgm']) {
      expect(runner).toContain(`q_idx ${index}`);
    }
    for (const trigger of ['trg_films_canonical_integrity', 'trg_films_guard_backend_columns', 'trg_films_name_history']) {
      expect(runner).toContain(`q_trg ${trigger}`);
    }
    expect(runner).toMatch(/202_film_catalog_import\*\)\s+probe_file "\$f" \|\| die/);
  });

  it('uses the runner effect gate', () => {
    expectMigrationEffectGate(runner, '202_film_catalog_import.sql');
  });
});
