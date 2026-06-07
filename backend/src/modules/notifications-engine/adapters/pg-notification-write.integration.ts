import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { InsertNotificationInput } from '../ports/notification-write.port';
import { PgNotificationWriteAdapter } from './pg-notification-write';

const databaseUrl = process.env.NOTIFICATION_ENGINE_INTEGRATION_DATABASE_URL;
const maybe = databaseUrl ? describe : describe.skip;

function buildInput(overrides: Partial<InsertNotificationInput> = {}): InsertNotificationInput {
  return {
    userId: 1,
    level: 'info',
    title: 'E2E-title',
    message: 'E2E-message',
    entityType: 'order',
    entityId: '123',
    sourceType: 'notification_rule',
    sourceId: 'rule-1',
    idempotencyKey: `notif-rule:E2E-${randomUUID()}`,
    ...overrides,
  };
}

maybe('PgNotificationWriteAdapter integration', () => {
  const schemaName = `notification_write_${randomUUID().replaceAll('-', '_')}`;
  let pool: Pool;
  let adapter: PgNotificationWriteAdapter;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    await pool.query(`SET search_path TO ${schemaName}`);
    await createMinimalSchema(pool);
    adapter = new PgNotificationWriteAdapter();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  });

  it('inserting twice with the same idempotency key returns created:true then created:false with the same id, and exactly one row exists', async () => {
    const input = buildInput({ idempotencyKey: `notif-rule:E2E-${randomUUID()}` });

    const first = await adapter.insertIfAbsent(pool, input);
    expect(first.created).toBe(true);
    expect(first.notificationId).toBeTruthy();

    const second = await adapter.insertIfAbsent(pool, input);
    expect(second.created).toBe(false);
    expect(second.notificationId).toBe(first.notificationId);

    const rows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    expect(rows.rows[0].count).toBe('1');
  });

  it('a different idempotency key creates a second distinct row', async () => {
    const inputA = buildInput({ idempotencyKey: `notif-rule:E2E-${randomUUID()}` });
    const inputB = buildInput({ idempotencyKey: `notif-rule:E2E-${randomUUID()}` });

    const resultA = await adapter.insertIfAbsent(pool, inputA);
    const resultB = await adapter.insertIfAbsent(pool, inputB);

    expect(resultA.created).toBe(true);
    expect(resultB.created).toBe(true);
    expect(resultA.notificationId).not.toBe(resultB.notificationId);
  });
});

async function createMinimalSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE notifications (
      notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id BIGINT,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT,
      idempotency_key TEXT,
      is_read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX uq_notifications_idempotency_key ON notifications(idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);
}
