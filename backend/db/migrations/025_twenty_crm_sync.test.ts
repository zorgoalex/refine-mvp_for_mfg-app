import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./025_twenty_crm_sync.sql', import.meta.url), 'utf8');

describe('025_twenty_crm_sync migration', () => {
  it('creates crm_sync_mapping table with IF NOT EXISTS', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS crm_sync_mapping/i);
  });

  it('creates crm_sync_outbox table with IF NOT EXISTS', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS crm_sync_outbox/i);
  });

  it('crm_sync_outbox includes lock_token column', () => {
    expect(sql).toMatch(/lock_token\s+TEXT/i);
  });

  it('crm_sync_outbox includes idempotency_key column', () => {
    expect(sql).toMatch(/idempotency_key\s+TEXT/i);
  });

  it('creates pending-claim index idx_crm_sync_outbox_pending on (next_attempt_at, created_at)', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_crm_sync_outbox_pending/i);
    expect(sql).toMatch(/idx_crm_sync_outbox_pending[\s\S]*?next_attempt_at,\s*created_at/i);
  });

  it('creates coalesce index idx_crm_sync_outbox_key_pending on (idempotency_key)', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_crm_sync_outbox_key_pending/i);
    expect(sql).toMatch(/idx_crm_sync_outbox_key_pending[\s\S]*?idempotency_key/i);
  });

  it('pending indexes are NOT unique', () => {
    // UNIQUE INDEX on pending would break markRetry processing->pending transitions
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[\s\S]*?pending/i);
  });

  it('coalesce logic uses DELETE FROM crm_sync_outbox WHERE idempotency_key = v_key AND status = pending', () => {
    expect(sql).toMatch(/DELETE FROM crm_sync_outbox WHERE idempotency_key = v_key AND status = 'pending'/i);
  });

  it('does NOT use ON CONFLICT for coalescing', () => {
    expect(sql).not.toMatch(/ON CONFLICT/i);
  });

  it('uses CREATE OR REPLACE FUNCTION for crm_sync_enqueue', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION crm_sync_enqueue/i);
  });

  it('drops and creates trigger trg_crm_sync_clients on clients', () => {
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_crm_sync_clients ON clients/i);
    expect(sql).toMatch(/CREATE TRIGGER trg_crm_sync_clients[\s\S]*?ON clients/i);
  });

  it('drops and creates trigger trg_crm_sync_orders on orders', () => {
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_crm_sync_orders ON orders/i);
    expect(sql).toMatch(/CREATE TRIGGER trg_crm_sync_orders[\s\S]*?ON orders/i);
  });

  it('enqueue function uses crm_sync_enqueue(client) for clients trigger', () => {
    expect(sql).toMatch(/crm_sync_enqueue\('client'\)/i);
  });

  it('enqueue function uses crm_sync_enqueue(order) for orders trigger', () => {
    expect(sql).toMatch(/crm_sync_enqueue\('order'\)/i);
  });

  it('declares v_client_id TEXT variable in crm_sync_enqueue', () => {
    expect(sql).toMatch(/v_client_id\s+TEXT/i);
  });

  it('sets v_client_id for order entity using OLD.client_id on DELETE and NEW.client_id otherwise', () => {
    expect(sql).toMatch(/IF v_entity = 'order'/i);
    expect(sql).toMatch(/OLD\.client_id[\s\S]*?NEW\.client_id|NEW\.client_id[\s\S]*?OLD\.client_id/i);
  });

  it("payload jsonb_build_object includes 'clientId' key", () => {
    expect(sql).toMatch(/'clientId'/i);
    expect(sql).toMatch(/jsonb_build_object[\s\S]*?'clientId'[\s\S]*?v_client_id/i);
  });

  it('trigger function uses client_id for client entity', () => {
    expect(sql).toMatch(/WHEN 'client' THEN (OLD|NEW)\.client_id|'client' THEN OLD\.client_id[\s\S]*?'client' THEN NEW\.client_id/i);
  });

  it('trigger function uses order_id for order entity', () => {
    expect(sql).toMatch(/ELSE (OLD|NEW)\.order_id/i);
  });

  it('crm_sync_mapping has attempts and last_error columns', () => {
    expect(sql).toMatch(/attempts\s+INTEGER/i);
    expect(sql).toMatch(/last_error\s+TEXT/i);
  });

  it('crm_sync_mapping status has active/deleted/failed constraint', () => {
    expect(sql).toMatch(/CHECK.*?active.*?deleted.*?failed/i);
  });
});
