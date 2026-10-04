import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('204 procurement workspace migration', () => {
  const sql = readFileSync(new URL('./204_procurement_workspace.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('adds the settings singleton, the append-only supplier registry and the saved-views column', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.procurement_settings');
    expect(sql).toContain('CHECK (config_id = 1)');
    expect(sql).toMatch(/INSERT INTO public\.procurement_settings \(config_id\) VALUES \(1\)\s+ON CONFLICT \(config_id\) DO NOTHING/);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.resource_suppliers');
    expect(sql).toMatch(/uq_resource_suppliers_sheet_material[\s\S]*WHERE resource_kind = 'sheet_material'/);
    expect(sql).toMatch(/uq_resource_suppliers_film[\s\S]*WHERE resource_kind = 'film'/);
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS procurement_saved_views JSONB NOT NULL DEFAULT');
    expect(sql).toContain('jsonb_array_length(procurement_saved_views) <= 20');
  });

  it('never overwrites a recorded supplier and never drops anything', () => {
    expect(sql).not.toMatch(/\bUPDATE\s+public\.resource_suppliers/i);
    expect(sql).not.toMatch(/ON CONFLICT[^;]*DO UPDATE/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/i);
  });

  it('re-classifies origin only by the audit event that set the current mark (R7-1)', () => {
    const update = sql.slice(sql.indexOf('UPDATE public.order_resource_procurement'));
    expect(update).toContain("SET origin = 'onec'");
    expect(update).toContain("orp.origin = 'manual'");
    expect(update).toContain("ev.before_json IS NULL OR ev.before_json->>'purchased' = 'false'");
    expect(update).toContain("ev.metadata_json->>'commandSource' IN ('erp_ui', 'erp_bulk')");
    expect(update).toContain("ev.metadata_json->>'procurementId' = orp.order_resource_procurement_id::text");
    expect(update).toContain("ev.metadata_json->>'role' = 'receipt'");
    expect(update).toContain('ev.created_at <= orp.marked_at');
    expect(update).toContain('ORDER BY ev.created_at DESC, ev.audit_id DESC');
  });

  it('probes every new object before recording the ledger', () => {
    expect(runner).toContain('204_procurement_workspace*) probe_all');
    for (const name of ['chk_procurement_settings_singleton', 'chk_procurement_settings_lead_days', 'chk_procurement_settings_urgency',
      'chk_procurement_settings_waste', 'chk_procurement_settings_unallocated', 'chk_procurement_settings_overdue_window', 'chk_procurement_settings_version']) {
      expect(runner).toContain(`q_con_on procurement_settings ${name}`);
    }
    for (const name of ['chk_resource_suppliers_kind', 'chk_resource_suppliers_one_ref', 'chk_resource_suppliers_key', 'chk_resource_suppliers_source']) {
      expect(runner).toContain(`q_con_on resource_suppliers ${name}`);
    }
    expect(runner).toContain('q_idx uq_resource_suppliers_sheet_material');
    expect(runner).toContain('q_idx uq_resource_suppliers_film');
    expect(runner).toContain('q_col user_preferences procurement_saved_views');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/204_procurement_workspace\*\)\s+probe_file "\$f" \|\| die/);
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '204_procurement_workspace.sql');
  });
});
