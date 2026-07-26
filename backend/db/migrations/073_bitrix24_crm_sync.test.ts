import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./073_bitrix24_crm_sync.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('073 Bitrix24 CRM sync migration', () => {
  it('adds a defaulted physical/legal person type', () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS person_type TEXT NOT NULL DEFAULT 'individual'");
    expect(sql).toContain("CHECK (person_type IN ('individual', 'legal'))");
  });

  it('retires Twenty mapping names and supports payments', () => {
    expect(sql).toContain('RENAME COLUMN twenty_object TO bitrix_object');
    expect(sql).toContain('RENAME COLUMN twenty_id TO bitrix_id');
    expect(sql).toContain("'payment'");
    expect(sql).toContain('parent_erp_id');
  });

  it('enqueues client changes for phones and counterparty type changes', () => {
    expect(sql).toContain('trg_crm_sync_client_phones');
    expect(sql).toContain('trg_crm_sync_client_person_type_orders');
    expect(sql).toContain("'crm.sync.order.upsert'");
  });

  it('lets auto migration mode detect the complete end state', () => {
    expect(runner).toMatch(/073_\*\)\s*probe_all/);
    expect(runner).toContain("column_default='''individual''::text'");
    expect(runner).toContain('q_con_def_on uq_crm_sync_mapping_bitrix crm_sync_mapping');
    expect(runner).toContain('q_trg_def_on trg_crm_sync_client_phones client_phones');
    expect(runner).toContain("column_name IN ('twenty_object', 'twenty_id')");
    expect(runner).toMatch(/073_\*\|074_\*\|087_\*\)[\s\S]*probe_file "\$f"/);
  });
});
