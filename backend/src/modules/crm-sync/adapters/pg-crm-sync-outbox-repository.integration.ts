import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { PgCrmSyncOutboxRepository } from './pg-crm-sync-outbox-repository';

// Integration tests for PgCrmSyncOutboxRepository.
// Gated on CRM_SYNC_INTEGRATION_DATABASE_URL (falls back to TEST_DATABASE_URL).
// Skips cleanly without a database. Uses a throwaway schema only.
const databaseUrl =
  process.env.CRM_SYNC_INTEGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

const schemaName = `crm_outbox_${randomUUID().replaceAll('-', '_')}`;

async function createSchema(rawClient: import('pg').PoolClient): Promise<void> {
  await rawClient.query(`CREATE SCHEMA ${schemaName}`);
  await rawClient.query(`SET search_path TO ${schemaName}, public`);
  await rawClient.query(`
    CREATE TABLE ${schemaName}.crm_sync_outbox (
      outbox_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type      TEXT NOT NULL,
      aggregate_type  TEXT NOT NULL,
      aggregate_id    TEXT NOT NULL,
      payload_json    JSONB,
      status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','processed','failed')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_at       TIMESTAMPTZ,
      locked_by       TEXT,
      lock_token      UUID,
      processed_at    TIMESTAMPTZ
    )
  `);
}

/** Minimal DatabaseClient backed by the pool in the throwaway schema. */
function makeClient(pool: Pool): DatabaseClient {
  return {
    query: (text: string, params: readonly unknown[] = []) => pool.query(text, [...params]),
  };
}

describeIntegration('PgCrmSyncOutboxRepository (integration)', () => {
  let pool: Pool;
  let repo: PgCrmSyncOutboxRepository;
  let client: DatabaseClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    // Register search_path BEFORE first pool.connect() / pool.query().
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schemaName}, public`));
    const setupClient = await pool.connect();
    try {
      await createSchema(setupClient);
    } finally {
      setupClient.release();
    }
    repo = new PgCrmSyncOutboxRepository();
    client = makeClient(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  });

  async function insertPendingEvent(overrides: {
    next_attempt_at?: string;
    status?: string;
    locked_at?: string | null;
    lock_token?: string | null;
    locked_by?: string | null;
  } = {}): Promise<string> {
    const result = await pool.query<{ outbox_event_id: string }>(
      `INSERT INTO ${schemaName}.crm_sync_outbox
         (event_type, aggregate_type, aggregate_id, payload_json, status, next_attempt_at, locked_at, lock_token, locked_by)
       VALUES ('crm.sync.client', 'client', '1', '{"entity":"client","id":"1","op":"upsert"}',
               $1, $2, $3, $4, $5)
       RETURNING outbox_event_id`,
      [
        overrides.status ?? 'pending',
        overrides.next_attempt_at ?? new Date(Date.now() - 1000).toISOString(),
        overrides.locked_at ?? null,
        overrides.lock_token ?? null,
        overrides.locked_by ?? null,
      ],
    );
    return String(result.rows[0].outbox_event_id);
  }

  // ── (i) stale 'processing' row is reclaimed with a NEW lock_token ─────────────

  it('reclaims a stale processing row with a NEW lock_token', async () => {
    const oldToken = randomUUID();
    const _eventId = await insertPendingEvent({
      status: 'processing',
      locked_at: new Date(Date.now() - 400_000).toISOString(), // 400s ago → stale for 300s lease
      lock_token: oldToken,
      locked_by: 'old-worker',
    });

    const claimed = await repo.claimBatch(client, 'new-worker', 10, 300_000);
    expect(claimed.length).toBeGreaterThanOrEqual(1);

    const reclaimed = claimed.find((e) => e.lockToken !== oldToken);
    expect(reclaimed).toBeDefined();
    expect(reclaimed!.lockToken).not.toBe(oldToken);
    expect(reclaimed!.lockToken).toBeTruthy();

    // Cleanup
    await pool.query(`DELETE FROM ${schemaName}.crm_sync_outbox WHERE outbox_event_id=$1`, [
      reclaimed!.outboxEventId,
    ]);
  });

  // ── (ii) markProcessed/markRetry with STALE token affect 0 rows ──────────────

  it('markProcessed with a STALE token affects 0 rows', async () => {
    // Insert and claim to get the current token
    const _inserted = await insertPendingEvent();
    const claimed = await repo.claimBatch(client, 'worker-A', 1, 300_000);
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const event = claimed[0];

    // Simulate stale token
    const staleToken = randomUUID();
    const n = await repo.markProcessed(client, event.outboxEventId, staleToken);
    expect(n).toBe(0);

    // Row should still be in 'processing' state
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM ${schemaName}.crm_sync_outbox WHERE outbox_event_id=$1`,
      [event.outboxEventId],
    );
    expect(row.rows[0].status).toBe('processing');

    // Cleanup
    await pool.query(`DELETE FROM ${schemaName}.crm_sync_outbox WHERE outbox_event_id=$1`, [
      event.outboxEventId,
    ]);
  });

  it('markRetry with a STALE token affects 0 rows', async () => {
    const _inserted = await insertPendingEvent();
    const claimed = await repo.claimBatch(client, 'worker-B', 1, 300_000);
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const event = claimed[0];

    const staleToken = randomUUID();
    const n = await repo.markRetry(
      client,
      event.outboxEventId,
      staleToken,
      new Date(Date.now() + 5000).toISOString(),
      5,
    );
    expect(n).toBe(0);

    // Cleanup
    await pool.query(`DELETE FROM ${schemaName}.crm_sync_outbox WHERE outbox_event_id=$1`, [
      event.outboxEventId,
    ]);
  });

  // ── (iii) markProcessed/markRetry with CURRENT token succeed ─────────────────

  it('markProcessed with the CURRENT token affects 1 row and sets status=processed', async () => {
    const _inserted = await insertPendingEvent();
    const claimed = await repo.claimBatch(client, 'worker-C', 1, 300_000);
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const event = claimed[0];

    const n = await repo.markProcessed(client, event.outboxEventId, event.lockToken);
    expect(n).toBe(1);

    const row = await pool.query<{ status: string }>(
      `SELECT status FROM ${schemaName}.crm_sync_outbox WHERE outbox_event_id=$1`,
      [event.outboxEventId],
    );
    expect(row.rows[0].status).toBe('processed');
  });

  it('markRetry with the CURRENT token affects 1 row and sets status=pending (below maxAttempts)', async () => {
    const _inserted = await insertPendingEvent();
    const claimed = await repo.claimBatch(client, 'worker-D', 1, 300_000);
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const event = claimed[0];

    const nextAttemptAt = new Date(Date.now() + 5000).toISOString();
    const n = await repo.markRetry(client, event.outboxEventId, event.lockToken, nextAttemptAt, 5);
    expect(n).toBe(1);

    const row = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM ${schemaName}.crm_sync_outbox WHERE outbox_event_id=$1`,
      [event.outboxEventId],
    );
    // attempts was 0, now 1; below maxAttempts(5) → status=pending
    expect(row.rows[0].status).toBe('pending');
    expect(row.rows[0].attempts).toBe(1);
  });

  it('markRetry sets status=failed when attempts+1 >= maxAttempts', async () => {
    const _inserted = await insertPendingEvent();
    const claimed = await repo.claimBatch(client, 'worker-E', 1, 300_000);
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const event = claimed[0];

    // maxAttempts=1 so attempts+1 (1+1=2? No — attempts starts at 0, attempts+1=1 >= 1 → failed)
    // Actually: event.attempts is 0, DB increments to 1, 1 >= 1 → failed
    const nextAttemptAt = new Date(Date.now() + 5000).toISOString();
    const n = await repo.markRetry(client, event.outboxEventId, event.lockToken, nextAttemptAt, 1);
    expect(n).toBe(1);

    const row = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM ${schemaName}.crm_sync_outbox WHERE outbox_event_id=$1`,
      [event.outboxEventId],
    );
    expect(row.rows[0].status).toBe('failed');
    expect(row.rows[0].attempts).toBe(1);
  });

  // ── peekPending does NOT lock or change status ────────────────────────────────

  it('peekPending returns pending events without changing their status', async () => {
    const _inserted = await insertPendingEvent();
    const events = await repo.peekPending(client, 10);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).not.toHaveProperty('lockToken');
    // Verify no status change happened — row is still pending
    if (events.length > 0) {
      const row = await pool.query<{ status: string }>(
        `SELECT status FROM ${schemaName}.crm_sync_outbox WHERE outbox_event_id=$1`,
        [events[0].outboxEventId],
      );
      expect(row.rows[0].status).toBe('pending');
    }
    // Cleanup
    await pool.query(
      `DELETE FROM ${schemaName}.crm_sync_outbox WHERE status='pending'`,
    );
  });
});
