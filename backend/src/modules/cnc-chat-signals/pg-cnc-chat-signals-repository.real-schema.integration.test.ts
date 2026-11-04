import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import type { CurrentUser } from '../../permissions/current-user';
import type { TransactionClient } from '../../database/database.types';
import type { DatabaseTransactionOptions } from '../../database/database.service';
import { getPermissionsForRole } from '../../permissions/permissions';
import { enterMdfCommand, discardMdfCommandBoundary } from '../mdf-board/application/mdf-command-boundary';
import { beginTransactionHooks, flushTransactionHooks, discardTransactionHooks } from '../../database/transaction-hooks';
import { PgCncChatSignalsRepository } from './pg-cnc-chat-signals-repository';

/**
 * Production tables, their triggers and the stage automation rules (stage = production dump), in ONE outer
 * transaction that is always rolled back: nothing is committed. Only the MDF mode is shadowed (pg_temp, legacy),
 * because stage runs the engine in `active`. Opt-in: CNC_SAWN_SIGNAL_REAL_SCHEMA=1 plus a pending stage packet
 * number with a sent manual send in CNC_SAWN_SIGNAL_REAL_PACKET_NO (default 391).
 * Repository transactions are savepoints here; the own-row capture (xmin of this transaction or its
 * sub-transactions, still in progress) also covers them, so events are asserted.
 */
const enabled = process.env.CNC_SAWN_SIGNAL_REAL_SCHEMA === '1';
const packetNo = Number(process.env.CNC_SAWN_SIGNAL_REAL_PACKET_NO ?? '391');
const worker: CurrentUser = { id: '1', username: 'E2E-Тест воркер', role: 'admin', roleId: 1,
  permissions: getPermissionsForRole('admin') };

describe.skipIf(!enabled)('«Распилено» on production tables and triggers (rolled back)', { timeout: 120_000 }, () => {
  const client = new Client({
    host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=60000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=180000',
  });
  const base: TransactionClient = {
    query: (text, params) => client.query(text, params ? [...params] : []),
    raw: client as unknown as PoolClient,
  };
  let savepoint = 0;
  const database = {
    query: (text: string, params?: unknown[]) => client.query(text, params ?? []),
    transaction: async <T>(handler: (tx: TransactionClient) => Promise<T>, options: DatabaseTransactionOptions = {}) => {
      const name = `sawn_sp_${++savepoint}`;
      const scoped: TransactionClient = { ...base };
      await client.query(`SAVEPOINT ${name}`);
      beginTransactionHooks(scoped);
      try {
        if (options.mdf) await enterMdfCommand(scoped, options.mdf);
        const result = await handler(scoped);
        await flushTransactionHooks(scoped);
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      } finally {
        discardTransactionHooks(scoped);
        discardMdfCommandBoundary(scoped);
      }
    },
  };
  const repository = new PgCncChatSignalsRepository(database as never);
  let packetId = '';
  let chatId = '';
  let fileMessageId = 0;
  const lease = { sourceChatId: '', leaseToken: 'E2E-real-lease-token-0123456789-0123456789', leaseGeneration: 1,
    workerInstanceId: '00000000-0000-0000-0000-000000000295' };

  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    await client.connect();
    await client.query('BEGIN');
    // Migration 292 (if stage does not have it yet) goes into public inside this rolled-back transaction.
    await client.query('SET LOCAL search_path=public');
    const exists = (await client.query("SELECT to_regclass('public.cnc_chat_signal_messages') IS NOT NULL AS ok")).rows[0].ok;
    if (!exists) {
      await client.query(readFileSync(new URL('../../../db/migrations/292_cnc_chat_sawn_signals.sql', import.meta.url), 'utf8')
        .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''));
    }
    await client.query(`CREATE TEMP TABLE mdf_engine_state (singleton boolean PRIMARY KEY, mode text NOT NULL)
      ON COMMIT DROP; INSERT INTO pg_temp.mdf_engine_state VALUES (true,'legacy'); SET LOCAL search_path=pg_temp,public`);
    const target = (await client.query(`
      SELECT p.packet_id::text, r.sent_chat_id, r.sent_message_ids_json->>0 AS first_id
        FROM cnc_telegram_packets p JOIN cnc_manual_svg_telegram_send_requests r ON r.packet_id=p.packet_id
       WHERE p.cutting_sequence_no=$1 AND r.status='sent' AND p.completion_status='pending'
       ORDER BY r.finished_at DESC LIMIT 1`, [packetNo])).rows[0];
    if (!target) throw new Error(`stage packet №${packetNo} with a sent manual send is required`);
    packetId = target.packet_id;
    chatId = target.sent_chat_id;
    fileMessageId = Number(target.first_id);
    lease.sourceChatId = chatId;
    // Fresh send inside the observation window, activation before it → a live signal.
    await client.query(`UPDATE cnc_manual_svg_telegram_send_requests SET finished_at=now() - interval '5 minutes'
      WHERE packet_id=$1::uuid AND status='sent'`, [packetId]);
    await client.query(`INSERT INTO cnc_telegram_worker_session_leases(source_chat_id,lease_token,lease_generation,
        worker_instance_id,worker_image_revision,expires_at)
      VALUES($1,$2,1,$3,'e2e0292',now() + interval '1 hour')
      ON CONFLICT (source_chat_id) DO UPDATE SET lease_token=EXCLUDED.lease_token, lease_generation=1,
        worker_instance_id=EXCLUDED.worker_instance_id, expires_at=EXCLUDED.expires_at`,
    [chatId, lease.leaseToken, lease.workerInstanceId]);
    await client.query(`INSERT INTO app_settings(setting_key,value_json,is_active) VALUES
        ('cnc_chat_signals.activated_at', jsonb_build_object('value', to_char((now() - interval '1 day') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true),
        ('cnc_chat_signals.apply_to_packet','{"value": false}', true)
      ON CONFLICT (setting_key) DO UPDATE SET value_json=EXCLUDED.value_json`);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('journals the 👍, previews the real effect and confirms the same effect on production tables', async () => {
    // The first claim registers the window's real sends; it is answered with read errors (no evidence), then only
    // our packet's messages are made due so the second claim carries exactly them.
    const first = await repository.claim({ currentUser: worker, lease, requestId: 'E2E-real-claim-1' });
    expect(first.claim).not.toBeNull();
    await repository.report({ currentUser: worker, lease, requestId: 'E2E-real-report-1', report: {
      claimId: first.claim!.claimId, claimToken: first.claim!.claimToken, observedAt: new Date().toISOString(),
      messages: first.claim!.messages.map(({ messageId }) => ({ messageId, present: true, thumbsCount: 0, canSeeList: null,
        readError: 'READ_ERROR', authors: null })),
    } });
    await client.query(`UPDATE cnc_chat_signal_messages SET next_poll_at = CASE WHEN packet_id=$1::uuid
      THEN now() - interval '1 day' ELSE now() + interval '1 day' END, claim_expires_at=NULL`, [packetId]);
    const claim = await repository.claim({ currentUser: worker, lease, requestId: 'E2E-real-claim-2' });
    expect(claim.claim!.messages.map(({ messageId }) => messageId)).toContain(fileMessageId);
    const report = {
      claimId: claim.claim!.claimId, claimToken: claim.claim!.claimToken, observedAt: new Date().toISOString(),
      messages: claim.claim!.messages.map(({ messageId }) => messageId === fileMessageId
        ? { messageId, present: true, thumbsCount: 1, canSeeList: true, readError: null,
            authors: { state: 'complete' as const, reactors: [{ peerType: 'user' as const, peerId: '777',
              displayName: 'E2E-Тест цех', username: null, reactedAt: new Date().toISOString() }] } }
        : { messageId, present: true, thumbsCount: 0, canSeeList: true, readError: null, authors: null }),
    };
    const reported = await repository.report({ currentUser: worker, lease, requestId: 'E2E-real-report', report });
    expect(reported.openedSignalIds).toHaveLength(1);
    const id = reported.openedSignalIds[0]!;
    expect((await client.query('SELECT apply_state, origin FROM cnc_chat_sawn_packet_signals WHERE packet_signal_id=$1',
      [id])).rows[0]).toEqual({ apply_state: 'held_disabled', origin: 'live' });

    // Real `set_edited_by` trigger: details without an editor, and a stale actor left on the pooled connection.
    const detailIds = (await client.query(`SELECT DISTINCT match_detail_id FROM cnc_telegram_packet_items
      WHERE packet_id=$1::uuid AND match_detail_id IS NOT NULL`, [packetId])).rows.map((row) => Number(row.match_detail_id));
    await client.query('UPDATE order_details SET edited_by=NULL WHERE detail_id = ANY($1::bigint[])', [detailIds]);
    await client.query("SELECT set_config('app.user_id', '3', false)");
    const preview = await repository.applySignal({ packetSignalId: id, mode: 'preview', actor: worker,
      requestId: 'E2E-real-preview', idempotencyKey: `cnc-chat-signal:${id}` });
    if (preview.result !== 'preview') throw new Error(`preview expected, got ${preview.result}`);
    expect(preview.eligible).toBe(true);
    expect(preview.effect.details.length).toBeGreaterThan(0);
    // Own-row capture works inside savepoints too: the trigger/automation-written events are part of the effect.
    expect(preview.effect.events).toEqual(expect.arrayContaining(['cnc.telegram_packet.completed']));
    expect((await client.query('SELECT completion_status FROM cnc_telegram_packets WHERE packet_id=$1::uuid', [packetId]))
      .rows[0].completion_status).toBe('pending');

    const applied = await repository.applySignal({ packetSignalId: id, mode: 'manual', actor: worker,
      requestId: 'E2E-real-confirm', expectedDigest: preview.effectDigest, idempotencyKey: `cnc-chat-signal:${id}` });
    expect(applied.result).toBe('applied');
    expect((await client.query('SELECT completion_status, thumbs_up FROM cnc_telegram_packets WHERE packet_id=$1::uuid',
      [packetId])).rows[0]).toEqual({ completion_status: 'completed', thumbs_up: true });
    // Details the apply changed carry the apply actor; nothing carries the stale connection actor (3).
    // (The fixture's own `edited_by=NULL` rows belong to this outer test transaction too, so only status changes count.)
    const changed = preview.effect.details.filter((detail) => detail.statusBefore !== detail.statusAfter)
      .map((detail) => detail.detailId);
    expect(changed.length).toBeGreaterThan(0);
    const changedEditors = (await client.query('SELECT DISTINCT edited_by FROM order_details WHERE detail_id = ANY($1::bigint[])',
      [changed])).rows.map((row) => String(row.edited_by));
    expect(changedEditors).toEqual(['1']);
    const allEditors = (await client.query('SELECT DISTINCT edited_by FROM order_details WHERE detail_id = ANY($1::bigint[])',
      [detailIds])).rows.map((row) => String(row.edited_by));
    expect(allEditors).not.toContain('3');
  });
});
