import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkSchemaPreflight, getSchemaPreflightIssueCodes } from './preflight';

describe('schema preflight', () => {
  it('detects missing referenced tables', () => {
    const sql = 'CREATE UNIQUE INDEX idx_film_vendors ON film_vendors(ref_key_1c);';

    expect(getSchemaPreflightIssueCodes(sql)).toContain('FILM_VENDORS_TABLE_MISSING');
  });

  it('detects duplicate production status sort order with a unique constraint', () => {
    const sql = `
      CREATE TABLE production_statuses (
        production_status_id SMALLINT,
        sort_order SMALLINT NOT NULL,
        CONSTRAINT uq_production_statuses_sort_order UNIQUE (sort_order)
      );

      INSERT INTO production_statuses (sort_order, production_status_name, production_status_code, color) VALUES
        (10, 'New', 'new', '#000000'),
        (10, 'Drawn', 'drawn', '#000000')
      ON CONFLICT (production_status_name) DO NOTHING;
    `;

    expect(getSchemaPreflightIssueCodes(sql)).toContain(
      'PRODUCTION_STATUS_SORT_ORDER_SEED_CONFLICT',
    );
  });

  it('detects deadline_events schema drift when idempotency_key is missing', () => {
    const sql = `
      CREATE TABLE deadline_events (
        deadline_event_id UUID PRIMARY KEY,
        deadline_id UUID NOT NULL,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        order_id BIGINT,
        payload_json JSONB,
        created_at TIMESTAMPTZ NOT NULL
      );
    `;

    expect(getSchemaPreflightIssueCodes(sql)).toContain(
      'DEADLINE_EVENTS_IDEMPOTENCY_KEY_MISSING',
    );
  });

  it('accepts deadline_events.idempotency_key added by an additive migration', () => {
    const sql = `
      CREATE TABLE deadline_events (
        deadline_event_id UUID PRIMARY KEY,
        deadline_id UUID NOT NULL,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        order_id BIGINT,
        payload_json JSONB,
        created_at TIMESTAMPTZ NOT NULL
      );

      ALTER TABLE deadline_events
        ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    `;

    expect(getSchemaPreflightIssueCodes(sql)).not.toContain(
      'DEADLINE_EVENTS_IDEMPOTENCY_KEY_MISSING',
    );
  });

  it('detects missing notification idempotency when deadline notifications are enabled', () => {
    const issues = checkSchemaPreflight(`
      CREATE TABLE notifications (
        notification_id UUID PRIMARY KEY,
        user_id BIGINT,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT
      );
    `);

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'notifications.idempotency_key_missing',
        severity: 'error',
      }),
    );
  });

  it('detects missing notification idempotency index when the idempotency column exists', () => {
    const issues = checkSchemaPreflight(`
      CREATE TABLE notifications (
        notification_id UUID PRIMARY KEY,
        user_id BIGINT,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        idempotency_key TEXT
      );
    `);

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'notifications.idempotency_index_missing',
        severity: 'error',
      }),
    );
  });

  it('accepts notification idempotency schema added by the deadline notification migration', () => {
    const issues = checkSchemaPreflight(`
      CREATE TABLE notifications (
        notification_id UUID PRIMARY KEY,
        user_id BIGINT,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        idempotency_key TEXT
      );
      CREATE UNIQUE INDEX uq_notifications_idempotency_key
        ON notifications(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);

    expect(issues).not.toContainEqual(
      expect.objectContaining({
        code: 'notifications.idempotency_key_missing',
      }),
    );
    expect(issues).not.toContainEqual(
      expect.objectContaining({
        code: 'notifications.idempotency_index_missing',
      }),
    );
  });

  it('detects the known blockers in postgresql_schema_v_14.sql', () => {
    const schema = readFileSync(
      new URL('./fixtures/postgresql_schema_v_14.preflight.sql', import.meta.url),
      'utf8',
    );

    const issues = checkSchemaPreflight(schema);
    const codes = issues.map((issue) => issue.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        'FILM_VENDORS_TABLE_MISSING',
        'ORDERS_ADD_CONSTRAINT_IN_CREATE_TABLE',
        'PRODUCTION_STATUS_SORT_ORDER_SEED_CONFLICT',
        'MUC_MATERIAL_ID_TYPE_MISMATCH',
        'ORR_EDGE_TYPE_ID_TYPE_MISMATCH',
        'ORR_SUPPLIER_ID_TYPE_MISMATCH',
        'ORR_UNIQUE_NULL_DUPLICATE_RISK',
        'AUDIT_LOG_TABLE_MISSING',
        'PAYMENT_STATUS_CODE_MISSING',
        'ROLES_CODE_UNIQUENESS_MISSING',
      ]),
    );

    expect(issues.filter((issue) => issue.severity === 'blocker').length).toBeGreaterThan(0);
  });
});
