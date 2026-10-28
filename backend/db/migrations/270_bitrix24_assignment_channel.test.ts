import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '270_bitrix24_assignment_channel.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 270: Bitrix24 assignment channel', () => {
  it('is one bounded additive transaction, re-runnable', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).not.toMatch(/\bALTER TABLE\b/);
    expect(sql).not.toMatch(/\bDELETE FROM\b/);
    expect(sql.match(/\bDROP\b/g)?.length).toBe(sql.match(/DROP TRIGGER IF EXISTS/g)?.length);
    for (const table of ['settings', 'entity', 'remote', 'cause', 'change', 'fanout']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.bitrix24_assignment_${table}`);
    }
  });

  it('refuses duplicate active user mappings before the unique index', () => {
    const guard = sql.indexOf('several active Bitrix24 user mappings');
    const index = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_bitrix24_user_mapping_active_erp_user');
    expect(guard).toBeGreaterThan(0);
    expect(index).toBeGreaterThan(guard);
    expect(sql).toMatch(/uq_bitrix24_user_mapping_active_erp_user[\s\S]*WHERE is_active = true/);
  });

  it('starts off: every trigger and touch function returns at once while the mode is off', () => {
    expect(sql).toContain("mode                     text NOT NULL DEFAULT 'off'");
    expect(sql).toContain("SELECT EXISTS (SELECT 1 FROM public.bitrix24_assignment_settings WHERE mode <> 'off')");
    const guards = sql.match(/IF NOT public\.bitrix24_assignment_active\(\) THEN/g) ?? [];
    // touch, touch_remote, enqueue_fanout and the four trigger functions.
    expect(guards.length).toBe(7);
  });

  it('invalidates by appending causes only: business transactions never lock a shared channel row', () => {
    const touch = sql.slice(sql.indexOf('FUNCTION public.bitrix24_assignment_touch('), sql.indexOf('FUNCTION public.bitrix24_assignment_touch_remote('));
    expect(touch).toContain('INSERT INTO public.bitrix24_assignment_cause');
    expect(touch).not.toMatch(/bitrix24_assignment_entity|ON CONFLICT|UPDATE /);
    expect(sql).toContain('xact_id                  bigint NOT NULL DEFAULT txid_current()');
    expect(sql).toMatch(/idx_bitrix24_assignment_cause_open[\s\S]*WHERE NOT processed/);
  });

  it('re-checks the records of an ERP user who is deactivated or made a service account', () => {
    expect(sql).toContain('AFTER UPDATE OF is_active, is_service_account ON public.users');
    expect(sql).toMatch(/bitrix24_assignment_user_changed[\s\S]*bitrix24_assignment_enqueue_fanout/);
  });

  it('never fails a business statement on a malformed session user', () => {
    expect(sql).toContain("current_setting('app.user_id', true) ~ '^[1-9][0-9]{0,17}$'");
    expect(sql).not.toContain("NULLIF(current_setting('app.user_id', true), '')::bigint");
  });

  it('watches the columns the rules read and the CRM mapping that wakes a waiting entity', () => {
    expect(sql).toContain('AFTER UPDATE OF manager_id, created_by, client_id, delete_flag, order_date, order_kind ON public.orders');
    expect(sql).toContain('AFTER INSERT OR DELETE ON public.orders');
    expect(sql).toContain('AFTER UPDATE OF created_by ON public.clients');
    expect(sql).toContain('AFTER UPDATE OF status, bitrix_id, bitrix_object ON public.crm_sync_mapping');
    expect(sql).toContain('AFTER INSERT ON public.crm_sync_mapping');
  });

  it('keeps an in-flight write consistent and the change journal unique per operation', () => {
    expect(sql).toContain('CHECK ((op_id IS NULL) = (op_target IS NULL AND op_entity_version IS NULL AND op_purpose IS NULL))');
    expect(sql).toContain('op_before                text,');
    expect(sql).toContain('op_id                    uuid NOT NULL UNIQUE');
    expect(sql).toContain("restore_outcome IN (\n                             'pending', 'restored', 'missing', 'conflict_preserved', 'kept')");
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('270_bitrix24_assignment_channel*) probe_all');
    expect(runner).toMatch(/\|270_bitrix24_assignment_channel\*[|)]/);
  });
});
