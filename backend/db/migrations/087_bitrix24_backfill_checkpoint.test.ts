import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('087_bitrix24_backfill_checkpoint migration', () => {
  const sql = readFileSync(
    resolve(__dirname, '087_bitrix24_backfill_checkpoint.sql'),
    'utf8',
  );
  const runner = readFileSync(
    resolve(__dirname, '../../../ops/apply-migrations.sh'),
    'utf8',
  );

  it('creates one durable checkpoint per supported scope', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS crm_sync_backfill_checkpoint/i);
    expect(sql).toMatch(/scope TEXT PRIMARY KEY/i);
    expect(sql).toMatch(/CHECK \(scope IN \('clients', 'all'\)\)/i);
    expect(sql).toMatch(/CHECK \(phase IN \('clients', 'orders', 'completed'\)\)/i);
    expect(sql).toMatch(
      /scope = 'all'[\s\S]*last_order_id IS NULL AND processed_orders = 0/i,
    );
    expect(sql).toMatch(
      /phase <> 'clients'[\s\S]*last_order_id IS NULL AND processed_orders = 0/i,
    );
  });

  it('guards cursors, non-negative counts and completion state', () => {
    expect(sql).toMatch(/last_client_id IS NULL OR last_client_id ~ '\^\[0-9\]\+\$'/i);
    expect(sql).toMatch(/last_order_id IS NULL OR last_order_id ~ '\^\[0-9\]\+\$'/i);
    expect(sql).toMatch(/processed_clients >= 0 AND processed_orders >= 0/i);
    expect(sql).toMatch(/\(phase = 'completed'\) = \(completed_at IS NOT NULL\)/i);
  });

  it('has a strict end-state probe in the migration runner', () => {
    expect(runner).toMatch(/087_bitrix24_backfill_checkpoint\*\)/);
    expect(runner).toMatch(/q_tbl crm_sync_backfill_checkpoint/);
    expect(runner).toMatch(/SELECT count\(\*\) = 9/);
    expect(runner).toMatch(/q_con_def_on_safe chk_crm_sync_backfill_scope_phase/);
    expect(runner).toMatch(/q_con_def_on_safe chk_crm_sync_backfill_scope_state/);
    expect(runner).toMatch(/q_con_def_on_safe chk_crm_sync_backfill_phase_state/);
    expect(runner).toMatch(/q_con_def_on_safe chk_crm_sync_backfill_completed_at/);
    expect(runner).toMatch(/\\\$erp_probe\\\$/);
    expect(runner).toMatch(/073_\*\|074_\*\|087_\*/);
  });
});
