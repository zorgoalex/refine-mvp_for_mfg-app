import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PgDeadlineRepository } from './pg-deadline-repository';

describe('PgDeadlineRepository terminal event idempotency integration', () => {
  const databaseUrl = process.env.DEADLINE_REPOSITORY_INTEGRATION_DATABASE_URL;
  const schemaName = `deadline_idempotency_${randomUUID().replaceAll('-', '_')}`;
  let pool: Pool;
  let repository: PgDeadlineRepository;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error('DEADLINE_REPOSITORY_INTEGRATION_DATABASE_URL is required for this integration test');
    }

    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    await pool.query(`SET search_path TO ${schemaName}`);
    await createMinimalSchema(pool);
    repository = new PgDeadlineRepository(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  });

  it('returns the existing terminal event and writes one audit and outbox row for duplicate idempotency keys', async () => {
    const deadlineId = '11111111-1111-4111-8111-111111111111';
    const idempotencyKey = `deadline-terminal:${deadlineId}:DEADLINE_EXPIRED:deadline-engine`;

    const first = await repository.createDeadlineEvent({
      deadlineId,
      eventType: 'DEADLINE_EXPIRED',
      severity: 'critical',
      entityType: 'order',
      entityId: '100',
      orderId: 100,
      clientId: 5,
      deadlineAt: '2026-05-02T10:00:00.000Z',
      eventAt: '2026-05-03T10:00:00.000Z',
      delayMinutes: 1440,
      payload: {
        status: 'expired',
        source: 'deadline-engine',
        trigger: 'scheduler',
        workerId: 'worker-a',
        schedulerRunId: 'scheduler-run-1',
        actorUserId: '42',
        requestId: 'req-worker-1',
      },
      idempotencyKey,
    });
    const duplicate = await repository.createDeadlineEvent({
      deadlineId,
      eventType: 'DEADLINE_EXPIRED',
      severity: 'critical',
      entityType: 'order',
      entityId: '100',
      orderId: 100,
      clientId: 5,
      deadlineAt: '2026-05-02T10:00:00.000Z',
      eventAt: '2026-05-03T10:05:00.000Z',
      delayMinutes: 1445,
      payload: {
        status: 'expired',
        source: 'deadline-engine',
        trigger: 'scheduler',
        workerId: 'worker-a',
        schedulerRunId: 'scheduler-run-1',
        actorUserId: '42',
        requestId: 'req-worker-1',
      },
      idempotencyKey,
    });

    expect(duplicate.deadlineEventId).toBe(first.deadlineEventId);
    expect(duplicate.eventAt).toBe(first.eventAt);
    await expect(
      pool.query<{ count: string }>('SELECT COUNT(*)::int AS count FROM deadline_events'),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      pool.query<{ count: string }>('SELECT COUNT(*)::int AS count FROM outbox_events'),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      pool.query<{ count: string }>('SELECT COUNT(*)::int AS count FROM audit_log'),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});

async function createMinimalSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE deadline_events (
      deadline_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      deadline_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      order_id BIGINT,
      order_workshop_id BIGINT,
      client_id BIGINT,
      deadline_at TIMESTAMPTZ,
      event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      delay_minutes INTEGER,
      payload_json JSONB,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX uq_deadline_events_idempotency_key
      ON deadline_events (idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE audit_log (
      audit_id BIGSERIAL PRIMARY KEY,
      event TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      user_id TEXT,
      request_id TEXT,
      source TEXT,
      related_order_id BIGINT,
      related_client_id BIGINT,
      before_json JSONB,
      after_json JSONB,
      diff_json JSONB,
      metadata_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE outbox_events (
      outbox_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_at TIMESTAMPTZ,
      locked_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ,
      idempotency_key TEXT
    );

    CREATE UNIQUE INDEX uq_outbox_events_idempotency_key
      ON outbox_events(idempotency_key);
  `);
}
