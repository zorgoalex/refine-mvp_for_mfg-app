import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { MySendsRepository } from './my-sends.repository';

// Real PostgreSQL in an isolated schema: set WHATSAPP_BROADCAST_TEST_DATABASE_URL (or TEST_DATABASE_URL).
const databaseUrl = process.env.WHATSAPP_BROADCAST_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const GROUP = '120363338054016575@g.us';

describe.skipIf(!databaseUrl)('MySendsRepository (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_my_sends_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let repository: MySendsRepository;
  let calendarId: number;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q(`CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,user_id bigint,
      username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
      related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
      stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT now());
      CREATE TABLE users(user_id bigint PRIMARY KEY, username text);
      INSERT INTO users VALUES (11, 'me'), (12, 'someone-else');
      CREATE TABLE orders(order_id bigint PRIMARY KEY, order_name text);
      INSERT INTO orders VALUES (9001, 'E2E-Тест-1'), (9002, 'E2E-Тест-2');`);
    for (const file of ['183_whatsapp_daily_digest.sql', '184_whatsapp_daily_digest_schedule.sql', '209_whatsapp_broadcasts.sql',
      '224_whatsapp_calendar_send.sql', '230_whatsapp_order_send.sql']) {
      await q(await readFile(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    calendarId = Number((await q<{ broadcast_id: string }>(`SELECT broadcast_id FROM whatsapp_broadcasts WHERE purpose = 'calendar'`)).rows[0].broadcast_id);
    const database = {
      query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
    } as unknown as DatabaseService;
    repository = new MySendsRepository(database);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      try { await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { client.release(); }
    }
    await pool?.end();
  });

  beforeEach(async () => {
    await q('DELETE FROM whatsapp_order_sends');
    await q('DELETE FROM whatsapp_broadcast_messages');
    await q('DELETE FROM whatsapp_broadcast_runs');
    await q('DELETE FROM whatsapp_broadcast_commands');
    await q('DELETE FROM whatsapp_order_send_chats');
    await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = NULL, next_delivery_at = NULL, min_interval_minutes = 10, send_window_minutes = 5`);
    await q(`UPDATE whatsapp_broadcasts SET calendar_last_delivery_at = NULL WHERE purpose = 'calendar'`);
  });

  const orderSend = async (actorId: number, state: string, extra: Record<string, unknown> = {}) => {
    const sendId = randomUUID();
    const active = state === 'queued' || state === 'sending';
    await q(`INSERT INTO whatsapp_order_sends (send_id, order_id, actor_id, request_id, idempotency_key, fingerprint, target_kind, chat_key, form_code,
        phone_normalized, recipient_masked, file_key, sha256, size_bytes, file_name, state, attempt_count, lock_token, send_started_at,
        provider_message_id, provider_ack, sent_at, cancel_reason, queue_expires_at, next_attempt_at)
      VALUES ($1, 9001, $2, 'req', gen_random_uuid(), $3, 'client', NULL, 'order_pdf', '77014952060', '7701***2060', $4, $5, 10, 'a.pdf', $6,
        $7, $8, $9, $10, $11, $12, $13, now() + interval '1 hour', $14)`, [
      sendId, actorId, 'a'.repeat(64), active ? `${randomUUID()}.pdf` : null, active ? 'b'.repeat(64) : null, state,
      state === 'sending' || state === 'sent' ? 1 : 0, state === 'sending' ? randomUUID() : null, state === 'sending' ? new Date() : null,
      state === 'sent' ? 'true_x@c.us_1' : null, state === 'sent', state === 'sent' ? new Date() : null, state === 'cancelled' ? 'disabled' : null,
      extra.nextAttemptAt ?? new Date(),
    ]);
    return sendId;
  };

  const calendarRun = async (userId: number, state: string, message: { state: string; nextAttemptAt?: Date; attempts?: number; sentAt?: Date } | null) => {
    const runId = randomUUID();
    const commandId = randomUUID();
    await q(`INSERT INTO whatsapp_broadcast_commands (command_id, broadcast_id, kind, idempotency_key, fingerprint, result, created_by)
      VALUES ($1, $2, 'manual', gen_random_uuid(), $3, '{}'::jsonb, $4)`, [commandId, calendarId, 'c'.repeat(64), userId]);
    await q(`INSERT INTO whatsapp_broadcast_runs (run_id, broadcast_id, business_date, target_date, kind, root_run_id, settings_version, initiated_by_user_id,
        required_permissions, destination_chat_id, catch_up_policy, partial_policy, cards_per_message, renderer_version, state, source, command_id)
      VALUES ($1, $2, CURRENT_DATE, DATE '2026-10-02', 'manual', $1, 1, $3, '{}', $4, 'skip', 'remaining', 2, 'test', $5, 'calendar', $6)`,
    [runId, calendarId, userId, GROUP, state, commandId]);
    if (message) {
      await q(`INSERT INTO whatsapp_broadcast_messages (run_id, delivery_seq, message_kind, text_body, expires_at, state, attempt_count, next_attempt_at, sent_at)
        VALUES ($1, 1, 'text', 'Заказы', now() + interval '1 day', $2, $3, $4, $5)`,
      [runId, message.state, message.attempts ?? 0, message.nextAttemptAt ?? new Date(), message.sentAt ?? null]);
    }
    return runId;
  };

  it('returns only the caller\'s own sends, with titles and no recipient ids', async () => {
    const mine = await orderSend(11, 'sent');
    await orderSend(12, 'queued');
    const myRun = await calendarRun(11, 'sent', { state: 'sent', attempts: 1, sentAt: new Date() });
    await calendarRun(12, 'queued', { state: 'pending' });
    const items = await repository.list('11');
    expect(items.map((item) => item.id).sort()).toEqual([mine, myRun].sort());
    expect(items.find((item) => item.id === mine)).toMatchObject({ kind: 'order_send', title: 'Заказ E2E-Тест-1 → клиенту, PDF заказа', active: false,
      estimatedAt: null, orderId: 9001 });
    expect(items.find((item) => item.id === myRun)).toMatchObject({ kind: 'calendar_send', title: 'Календарь, 02.10.2026 → чат', active: false });
    expect(JSON.stringify(items)).not.toMatch(/@g\.us|@c\.us|7014952060/);
  });

  it('estimates a queued card send from the delivery gate (threshold + drawn window moment)', async () => {
    const last = new Date(Date.now() - 2 * 60_000);
    const drawn = new Date(last.getTime() + 13 * 60_000);
    await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = $1, next_delivery_at = $2`, [last, drawn]);
    const id = await orderSend(11, 'queued');
    const item = (await repository.list('11')).find((entry) => entry.id === id)!;
    expect(item.active).toBe(true);
    expect(new Date(item.estimatedAt!).getTime()).toBe(drawn.getTime());
  });

  it('estimates a queued calendar send from its pending message and the calendar threshold', async () => {
    await q(`UPDATE whatsapp_broadcasts SET calendar_last_delivery_at = now() - interval '5 minutes' WHERE purpose = 'calendar'`);
    const id = await calendarRun(11, 'queued', { state: 'pending' });
    const item = (await repository.list('11')).find((entry) => entry.id === id)!;
    const interval = Number((await q<{ m: number }>(`SELECT calendar_min_interval_minutes m FROM whatsapp_broadcasts WHERE purpose = 'calendar'`)).rows[0].m);
    const expected = Date.now() - 5 * 60_000 + interval * 60_000;
    expect(Math.abs(new Date(item.estimatedAt!).getTime() - expected)).toBeLessThan(5_000);
  });

  it('an overdue estimate is «now», never in the past', async () => {
    const id = await orderSend(11, 'queued', { nextAttemptAt: new Date(Date.now() - 60 * 60_000) });
    const now = new Date();
    const item = (await repository.list('11', now)).find((entry) => entry.id === id)!;
    expect(new Date(item.estimatedAt!).getTime()).toBe(now.getTime());
  });

  it('an old active send and a followed old id are returned even after 30 newer finished ones; never someone else\'s', async () => {
    const old = await orderSend(11, 'queued');
    const oldFinished = await orderSend(11, 'sent');
    await q(`UPDATE whatsapp_order_sends SET created_at = now() - interval '2 days' WHERE send_id IN ($1, $2)`, [old, oldFinished]);
    for (let index = 0; index < 31; index += 1) await calendarRun(11, 'sent', { state: 'sent', attempts: 1, sentAt: new Date() });
    const foreign = await orderSend(12, 'sent');
    const items = await repository.list('11', new Date(), [oldFinished, foreign]);
    expect(items.some((item) => item.id === old && item.active)).toBe(true);
    expect(items.some((item) => item.id === oldFinished)).toBe(true);
    expect(items.some((item) => item.id === foreign)).toBe(false);
    expect(items.filter((item) => !item.active && item.id !== oldFinished)).toHaveLength(30);
  });

  it('a followed old id survives 180+ newer rows of the same source', async () => {
    const followed = await orderSend(11, 'sent');
    await q(`UPDATE whatsapp_order_sends SET created_at = now() - interval '3 days' WHERE send_id = $1`, [followed]);
    await q(`INSERT INTO whatsapp_order_sends (send_id, order_id, actor_id, request_id, idempotency_key, fingerprint, target_kind, form_code,
        phone_normalized, recipient_masked, file_name, state, attempt_count, provider_message_id, provider_ack, sent_at, queue_expires_at)
      SELECT gen_random_uuid(), 9001, 11, 'req', gen_random_uuid(), $1, 'client', 'order_pdf', NULL, '7701***2060', 'a.pdf', 'sent', 1, 'id', true, now(),
        now() + interval '1 hour' FROM generate_series(1, 185)`, ['a'.repeat(64)]);
    const items = await repository.list('11', new Date(), [followed]);
    expect(items.some((item) => item.id === followed)).toBe(true);
    expect(items.filter((item) => item.id !== followed)).toHaveLength(30);
  });

  it('the calendar estimate follows the first unsent message (strict delivery order), not the earliest pending one', async () => {
    const runId = await calendarRun(11, 'sending', { state: 'sent', attempts: 1, sentAt: new Date() });
    const later = new Date(Date.now() + 30 * 60_000);
    const earlier = new Date(Date.now() + 10 * 60_000);
    await q(`INSERT INTO whatsapp_broadcast_messages (run_id, delivery_seq, message_kind, text_body, expires_at, state, next_attempt_at)
      VALUES ($1, 2, 'text', 'Два', now() + interval '1 day', 'pending', $2), ($1, 3, 'text', 'Три', now() + interval '1 day', 'pending', $3)`, [runId, later, earlier]);
    const item = (await repository.list('11')).find((entry) => entry.id === runId)!;
    expect(new Date(item.estimatedAt!).getTime()).toBe(later.getTime());
  });
});
