import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./095_bitrix24_reverse_sync.sql', import.meta.url), 'utf8');

describe('095 Bitrix24 reverse sync migration', () => {
  it('adds source ownership without changing existing ERP mappings', () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'erp'");
    expect(sql).toContain("CHECK (source_system IN ('erp', 'bitrix24'))");
  });

  it('creates encrypted installation, durable inbox, remote state and request tables', () => {
    for (const table of [
      'bitrix24_app_installation',
      'bitrix24_inbound_event',
      'bitrix24_reconcile_cursor',
      'bitrix24_remote_state',
      'bitrix24_incoming_request',
      'bitrix24_incoming_request_payment',
      'bitrix24_payment_type_mapping',
      'bitrix24_outbound_operation',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).not.toMatch(/\baccess_token\s+TEXT\b/i);
    expect(sql).not.toMatch(/\brefresh_token\s+TEXT\b/i);
  });

  it('constrains inbound payload size and makes event delivery idempotent', () => {
    expect(sql).toContain('chk_bitrix24_inbound_event_payload_size');
    expect(sql).toContain('uq_bitrix24_inbound_event_fingerprint');
    expect(sql).toContain("status IN ('pending', 'processing', 'processed', 'failed', 'dead')");
  });

  it('keeps unconverted request payments separate from ERP payments', () => {
    expect(sql).toContain('bitrix24_incoming_request_payment');
    expect(sql).toContain('chk_bitrix24_request_payment_materialized');
    expect(sql).toContain('chk_bitrix24_request_payment_owner');
  });

  it('suppresses every existing CRM enqueue trigger during a reverse transaction', () => {
    expect(sql).toContain("current_setting('app.crm_sync_origin', true)");
    expect(sql.match(/IF crm_sync_is_bitrix_inbound\(\)/g)).toHaveLength(4);
    expect(sql).toContain('CREATE OR REPLACE FUNCTION crm_sync_enqueue()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION crm_sync_enqueue_client_phone()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION crm_sync_enqueue_client_orders()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION crm_sync_enqueue_payment_order()');
  });

  it('does not access order-only record fields from the client trigger', () => {
    expect(sql).toContain("to_jsonb(NEW)->>'client_id'");
    expect(sql).toContain("to_jsonb(NEW)->>'order_id'");
    expect(sql).not.toContain('NEW.client_id ELSE NEW.order_id');
  });
});
