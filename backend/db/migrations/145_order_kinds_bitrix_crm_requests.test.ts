import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./145_order_kinds_bitrix_crm_requests.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('145 order kinds and Bitrix CRM requests migration', () => {
  it('adds immutable order kind/source and contains legacy zero-detail debt', () => {
    expect(sql).toContain("order_kind TEXT NOT NULL DEFAULT 'production_order'");
    expect(sql).toContain("source_system TEXT NOT NULL DEFAULT 'erp'");
    expect(sql).toContain('legacy_zero_detail_exempt BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toMatch(/CHECK \(order_kind IN \('draft', 'crm_request', 'production_order'\)\)/);
    expect(sql).toContain('enforce_order_identity_transition');
    expect(sql).toContain('OLD.source_system IS DISTINCT FROM NEW.source_system');
  });

  it('makes project optional only for precursors and names globally unique only for production', () => {
    expect(sql).toMatch(/ALTER TABLE orders[\s\S]*ALTER COLUMN project_id DROP NOT NULL/);
    expect(sql).toContain("order_kind <> 'production_order' OR project_id IS NOT NULL");
    expect(sql).toMatch(/CREATE UNIQUE INDEX uq_orders_name_production_active[\s\S]*normalize_order_name\(order_name\)/i);
    expect(sql).toContain("order_kind = 'production_order'");
    expect(sql).toContain('legacy_duplicate_name_exempt BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toMatch(/WITH duplicate_names AS[\s\S]*HAVING count\(\*\) > 1/i);
    expect(sql).toContain('order_legacy_duplicate_name_registry');
    expect(sql).toContain('order_legacy_duplicate_name_ledger');
    expect(sql).toContain('prevent_order_legacy_name_history_mutation');
    expect(sql).toContain('trg_order_legacy_name_registry_immutable');
    expect(sql).toMatch(/trg_order_legacy_name_registry_immutable[\s\S]*BEFORE INSERT OR UPDATE OR DELETE/i);
    expect(sql).toMatch(/trg_order_legacy_name_ledger_immutable[\s\S]*BEFORE INSERT OR UPDATE OR DELETE/i);
    expect(sql).toContain("set_config('app.crm_sync_origin', 'bitrix24', true)");
    expect(sql).toContain("to_regclass('public.order_legacy_duplicate_name_registry') IS NULL");
    expect(sql).toContain('legacy_duplicate_name_exempt = false');
    expect(sql).toContain('legacy duplicate-name exemption cannot be granted to new orders');
    expect(sql).toContain('OLD.legacy_duplicate_name_exempt = false');
    expect(sql).toContain('NEW.legacy_duplicate_name_exempt := false');
    expect(sql).toContain("CONSTRAINT = 'uq_orders_name_production_active'");
  });

  it('adds stable statuses, non-login service identity, owner mapping and command idempotency', () => {
    expect(sql).toContain('order_status_code VARCHAR(64)');
    expect(sql).toContain("'crm_request'");
    expect(sql).toContain('is_service_account BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain("'integration_service'");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS bitrix24_user_mapping');
    expect(sql).toContain('validate_bitrix24_user_mapping_target');
    expect(sql).toContain('target.is_service_account=true');
    expect(sql).toContain('trg_bitrix24_user_mapping_reconcile');
    expect(sql).toContain('trg_bitrix24_mapped_user_reconcile');
    expect(sql).toContain('request.assigned_by_id = p_bitrix_user_id');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS order_kind_conversion_command');
  });

  it('upgrades incoming request state, provenance, conflict and one-to-one constraints', () => {
    for (const token of [
      'counterparty_object_type',
      'counterparty_bitrix_id',
      'sync_version',
      'sync_status',
      'sync_error_code',
      'archived_by_source',
      'archived_order_version',
      'is_deleted',
      'deleted_at',
      'remote_revision',
    ]) {
      expect(sql).toContain(token);
    }
    expect(sql).toContain('uq_bitrix24_incoming_request_linked_order');
    expect(sql).toContain('validate_bitrix24_incoming_request_link');
    expect(sql).toContain('chk_bitrix24_request_client_mapping');
    expect(sql).toContain('ctrg_bitrix24_request_client_mapping');
    expect(sql).toContain('bitrix24_incoming_request_payment');
    expect(sql).toContain('chk_bitrix24_request_payment_sync_version');
  });

  it('uses deferred aggregate validation and child guards', () => {
    expect(sql).toContain('validate_order_kind_aggregate');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('unnest(ARRAY[v_old_order_id, v_new_order_id])');
    for (const table of [
      'order_details',
      'payments',
      'order_workshops',
      'order_resource_requirements',
      'order_doweling_links',
      'production_status_events',
      'deadline_instances',
      'cut_job',
      'bazis_order_links',
      'bazis_cut_set_details',
      'movement_items',
      'cnc_telegram_packet_items',
      'group_order_groups',
    ]) {
      expect(sql).toContain(table);
    }
  });

  it('rebuilds views with nullable projects and production-only project aggregates', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW projects_view[\s\S]*order_kind = 'production_order'/);
    expect(sql).toMatch(/CREATE OR REPLACE VIEW orders_view[\s\S]*LEFT JOIN projects mp/);
    expect(sql).toMatch(/CREATE OR REPLACE VIEW orders_view[\s\S]*ord\.order_kind = 'production_order'/);
    expect(sql).toContain('ord.order_kind');
    expect(sql).toContain('ord.source_system');
  });

  it('has a strict migration-runner end-state probe', () => {
    expect(runner).toContain('145_order_kinds_bitrix_crm_requests*) probe_all');
    expect(runner).toContain('q_col orders order_kind');
    expect(runner).toContain('q_col orders legacy_duplicate_name_exempt');
    expect(runner).toContain('q_tbl order_legacy_duplicate_name_registry');
    expect(runner).toContain("to_regprocedure('normalize_order_name(text)')");
    expect(runner).toContain('q_idx uq_orders_name_production_active');
    expect(runner).toContain('q_trg trg_bitrix24_user_mapping_reconcile');
    expect(runner).toContain("validate_order_kind_aggregate_id(bigint)");
  });
});
