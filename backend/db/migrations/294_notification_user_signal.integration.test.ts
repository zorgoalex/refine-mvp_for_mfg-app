import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

/** Migration 294 on real PostgreSQL: a LISTEN client receives the user id for visible changes only, after COMMIT. */
describe.skipIf(!databaseUrl)('migration 294: notification user signal (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_notification_signal_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let listener: Client;
  const received: string[] = [];
  const settle = () => new Promise((resolveTimer) => setTimeout(resolveTimer, 150));

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path="${schema}"`);
    await client.query(`CREATE TABLE notifications(notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id bigint NOT NULL,
      is_read boolean NOT NULL DEFAULT false, read_at timestamptz, balloon_shown_at timestamptz, balloon_lease_token uuid,
      balloon_leased_at timestamptz)`);
    const migration = (await readFile(new URL('./294_notification_user_signal.sql', import.meta.url), 'utf8')).replaceAll('public.', '');
    await client.query(migration);
    listener = new Client({ connectionString: databaseUrl });
    await listener.connect();
    listener.on('notification', (message) => { if (message.channel === 'erp_user_notifications') received.push(message.payload ?? ''); });
    await listener.query('LISTEN erp_user_notifications');
  });

  afterAll(async () => {
    await listener.end();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  });

  it('insert, read, balloon shown and delete signal the user; a balloon lease does not; a rollback does not', async () => {
    const id = (await client.query<{ notification_id: string }>(
      'INSERT INTO notifications (user_id) VALUES (7) RETURNING notification_id')).rows[0].notification_id;
    await settle();
    expect(received).toEqual(['7']);

    await client.query('UPDATE notifications SET balloon_lease_token = gen_random_uuid(), balloon_leased_at = now() WHERE notification_id = $1', [id]);
    await client.query('UPDATE notifications SET is_read = is_read WHERE notification_id = $1', [id]);
    await settle();
    expect(received).toEqual(['7']);

    await client.query('UPDATE notifications SET balloon_shown_at = now() WHERE notification_id = $1', [id]);
    await client.query('UPDATE notifications SET is_read = true, read_at = now() WHERE notification_id = $1', [id]);
    await settle();
    expect(received).toEqual(['7', '7', '7']);

    await client.query('BEGIN');
    await client.query('INSERT INTO notifications (user_id) VALUES (8)');
    await client.query('ROLLBACK');
    await client.query('DELETE FROM notifications WHERE notification_id = $1', [id]);
    await settle();
    expect(received).toEqual(['7', '7', '7', '7']);
  });
});
