import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./073_bitrix24_crm_sync.sql', import.meta.url), 'utf8');

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
});
