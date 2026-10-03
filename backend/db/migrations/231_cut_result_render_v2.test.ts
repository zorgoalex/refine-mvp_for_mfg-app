import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('231 cut result render contract v2 migration', () => {
  const sql = readFileSync(resolve(__dirname, '231_cut_result_render_v2.sql'), 'utf8');
  const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

  it('adds the per-sheet rule for both contracts', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.cut_sheet_render_is_complete\(p_sheet jsonb\)/);
    expect(sql).toMatch(/render ->> 'contractVersion' = 'cut_sheet_render_v1' THEN\s+RETURN \(SELECT count\(\*\) FROM jsonb_object_keys\(render -> 'views'\)\) = 12;/);
    expect(sql).toContain("render ->> 'contractVersion' IS DISTINCT FROM 'cut_sheet_render_v2'");
    expect(sql).toContain("NOT (render -> 'views') ? 'r0:raw:top-left:labels-off'");
    expect(sql).toContain("NOT model ?& ARRAY['renderStyle', 'showBathMeterGuides', 'pieces']");
    expect(sql).toContain("NOT piece ?& ARRAY['itemId', 'instance', 'label', 'fill', 'bath']");
    expect(sql).toContain("NOT bath ?& ARRAY['edgeTypeName', 'millingTypeName', 'doweling']");
    expect(sql).toMatch(/OR model_keys IS DISTINCT FROM sheet_keys/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.cut_render_style_is_complete\(p_style jsonb\)/);
    expect(sql).toContain('IF public.cut_render_style_is_complete(style) IS NOT TRUE THEN');
  });

  it('replaces only the render part of the snapshot check, for auto and manual sheets', () => {
    const check = sql.slice(sql.indexOf('FUNCTION public.cut_result_snapshot_is_complete'), sql.indexOf('FUNCTION public.cut_result_expected_manifest'));
    expect(check.match(/OR NOT public\.cut_sheet_render_is_complete\(sheet_json\)/g)).toHaveLength(2);
    expect(check).not.toContain("'{renderSnapshot,views}'");
    expect(check).toContain('p_digest <> cut_result_snapshot_digest(p_snapshot)');
    expect(check).toContain('IF p_manifest IS DISTINCT FROM cut_result_expected_manifest(p_snapshot) THEN');
    expect(check).toContain('EXCEPTION WHEN OTHERS THEN');
  });

  it('derives the manifest contract from the first auto sheet, as the backend does', () => {
    const manifest = sql.slice(sql.indexOf('FUNCTION public.cut_result_expected_manifest'));
    expect(manifest).toContain(
      "'renderContract', COALESCE(group_item.group_json #>> '{sheets,0,renderSnapshot,contractVersion}', 'cut_sheet_render_v1'),",
    );
    expect(manifest).not.toContain("'renderContract', 'cut_sheet_render_v1',");
  });

  it('is one transaction and has an end-state probe in the runner', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(runner).toMatch(/231_cut_result_render_v2\*\) probe_all/);
    expect(runner).toContain("to_regprocedure('public.cut_sheet_render_is_complete(jsonb)') IS NOT NULL");
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '231_cut_result_render_v2.sql');
  });
});
