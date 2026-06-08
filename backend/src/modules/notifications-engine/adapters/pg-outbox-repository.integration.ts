import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PgOutboxRepository } from './pg-outbox-repository';

const databaseUrl = process.env.NOTIFICATION_ENGINE_INTEGRATION_DATABASE_URL;
const maybe = databaseUrl ? describe : describe.skip;

interface OutboxRow {
  outbox_event_id: string;
  status: string;
  locked_by: string | null;
  processed_at: string | null;
  attempts: number;
}

async function insertPending(pool: Pool, aggregateId: string): Promise<string> {
  const rows = await pool.query<{ outbox_event_id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json)
     VALUES ('E2E.test_event', 'order', $1, '{"e2e": true}'::jsonb)
     RETURNING outbox_event_id`,
    [aggregateId],
  );
  return String(rows.rows[0].outbox_event_id);
}

async function fetchRow(pool: Pool, outboxEventId: string): Promise<OutboxRow> {
  const rows = await pool.query<OutboxRow>(
    `SELECT outbox_event_id, status, locked_by, processed_at, attempts FROM outbox_events WHERE outbox_event_id = $1`,
    [outboxEventId],
  );
  return rows.rows[0];
}

maybe('PgOutboxRepository integration', () => {
  const schemaName = `notification_outbox_repository_${randomUUID().replaceAll('-', '_')}`;
  let pool: Pool;
  let repository: PgOutboxRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    await pool.query(`SET search_path TO ${schemaName}`);
    await createMinimalSchema(pool);
    repository = new PgOutboxRepository();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  });

  it('claimPendingBatch claims a pending row, marks it processing/locked, and returns it as an OutboxEventRecord', async () => {
    const aggregateId = `E2E-order-${randomUUID()}`;
    const outboxEventId = await insertPending(pool, aggregateId);

    const claimed = await repository.claimPendingBatch(pool, { batchSize: 10, workerId: 'E2E-worker', now: new Date() });

    const record = claimed.find((r) => r.outboxEventId === outboxEventId);
    expect(record).toBeDefined();
    expect(record).toMatchObject({
      outboxEventId,
      eventType: 'E2E.test_event',
      aggregateType: 'order',
      aggregateId,
      payload: { e2e: true },
      attempts: 0,
    });

    const row = await fetchRow(pool, outboxEventId);
    expect(row.status).toBe('processing');
    expect(row.locked_by).toBe('E2E-worker');
  });

  it('markProcessed sets status=processed and processed_at', async () => {
    const aggregateId = `E2E-order-${randomUUID()}`;
    const outboxEventId = await insertPending(pool, aggregateId);
    await repository.claimPendingBatch(pool, { batchSize: 10, workerId: 'E2E-worker', now: new Date() });

    await repository.markProcessed(pool, outboxEventId);

    const row = await fetchRow(pool, outboxEventId);
    expect(row.status).toBe('processed');
    expect(row.processed_at).not.toBeNull();
  });

  it('markRetry increments attempts and stays pending until attempts reach maxAttempts, then becomes failed', async () => {
    const aggregateId = `E2E-order-${randomUUID()}`;
    const outboxEventId = await insertPending(pool, aggregateId);
    await repository.claimPendingBatch(pool, { batchSize: 10, workerId: 'E2E-worker', now: new Date() });

    const future = new Date(Date.now() + 60_000);

    const first = await repository.markRetry(pool, outboxEventId, { nextAttemptAt: future, maxAttempts: 2 });
    expect(first).toEqual({ status: 'pending', attempts: 1 });

    const second = await repository.markRetry(pool, outboxEventId, { nextAttemptAt: future, maxAttempts: 2 });
    expect(second).toEqual({ status: 'failed', attempts: 2 });
  });

  it('a second claim does not return a row already claimed as processing by a prior claim', async () => {
    const aggregateId = `E2E-order-${randomUUID()}`;
    const outboxEventId = await insertPending(pool, aggregateId);

    const firstClaim = await repository.claimPendingBatch(pool, { batchSize: 10, workerId: 'E2E-worker-1', now: new Date() });
    expect(firstClaim.some((r) => r.outboxEventId === outboxEventId)).toBe(true);

    const secondClaim = await repository.claimPendingBatch(pool, { batchSize: 10, workerId: 'E2E-worker-2', now: new Date() });
    expect(secondClaim.some((r) => r.outboxEventId === outboxEventId)).toBe(false);

    const row = await fetchRow(pool, outboxEventId);
    expect(row.status).toBe('processing');
    expect(row.locked_by).toBe('E2E-worker-1');
  });

  it('uses FOR UPDATE SKIP LOCKED: two concurrent claims in overlapping transactions never both take the same row', async () => {
    const aggregateId = `E2E-order-${randomUUID()}`;
    const outboxEventId = await insertPending(pool, aggregateId);

    // Two distinct connections with overlapping open transactions race on the same pending row.
    const concurrencyPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const clientA = await concurrencyPool.connect();
    const clientB = await concurrencyPool.connect();
    try {
      await clientA.query(`SET search_path TO ${schemaName}`);
      await clientB.query(`SET search_path TO ${schemaName}`);
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      const [claimA, claimB] = await Promise.all([
        repository.claimPendingBatch(clientA, { batchSize: 10, workerId: 'E2E-A', now: new Date() }),
        repository.claimPendingBatch(clientB, { batchSize: 10, workerId: 'E2E-B', now: new Date() }),
      ]);

      const gotA = claimA.some((r) => r.outboxEventId === outboxEventId);
      const gotB = claimB.some((r) => r.outboxEventId === outboxEventId);
      // SKIP LOCKED guarantees exactly one of the two concurrent claims takes the row.
      expect(gotA !== gotB).toBe(true);

      await clientA.query('COMMIT');
      await clientB.query('COMMIT');
    } finally {
      clientA.release();
      clientB.release();
      await concurrencyPool.end();
    }

    const row = await fetchRow(pool, outboxEventId);
    expect(row.status).toBe('processing');
    expect(['E2E-A', 'E2E-B']).toContain(row.locked_by);
  });
});

async function createMinimalSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
      processed_at TIMESTAMPTZ
    );
  `);
}
