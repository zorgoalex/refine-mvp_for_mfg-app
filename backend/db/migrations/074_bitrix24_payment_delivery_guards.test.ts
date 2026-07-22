import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./074_bitrix24_payment_delivery_guards.sql', import.meta.url),
  'utf8',
);
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('migration 074 Bitrix24 payment delivery guards', () => {
  it('persists payment create snapshots and a cross-process writer lease', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS crm_sync_payment_create_guard');
    expect(sql).toContain('before_ids');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS crm_sync_writer_lock');
  });

  it('enqueues both the old and new order when a payment moves', () => {
    expect(sql).toContain('OLD.order_id IS DISTINCT FROM NEW.order_id');
    expect(sql).toContain('PERFORM crm_sync_enqueue_order_id(OLD.order_id)');
    expect(sql).toContain('PERFORM crm_sync_enqueue_order_id(NEW.order_id)');
  });

  it('installs an insert/update/delete trigger on payments', () => {
    expect(sql).toContain('CREATE TRIGGER trg_crm_sync_payments');
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON payments');
  });

  it('lets auto migration mode detect the complete end state', () => {
    expect(runner).toMatch(/074_\*\)\s*probe_all/);
    expect(runner).toContain("table_name='crm_sync_payment_create_guard'");
    expect(runner).toContain('q_con_def_on crm_sync_payment_create_guard_pkey crm_sync_payment_create_guard');
    expect(runner).toContain('q_trg_def_on trg_crm_sync_payments payments');
    expect(runner).toContain("pg_get_functiondef('crm_sync_enqueue_payment_order()'::regprocedure)");
    expect(runner).toMatch(/073_\*\|074_\*\)[\s\S]*probe_file "\$f"/);
  });
});
