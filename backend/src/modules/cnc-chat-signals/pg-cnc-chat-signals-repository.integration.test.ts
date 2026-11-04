import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CurrentUser } from '../../permissions/current-user';
import type { TransactionClient } from '../../database/database.types';
import type { DatabaseTransactionOptions } from '../../database/database.service';
import { getPermissionsForRole } from '../../permissions/permissions';
import { enterMdfCommand, discardMdfCommandBoundary } from '../mdf-board/application/mdf-command-boundary';
import { beginTransactionHooks, flushTransactionHooks, discardTransactionHooks } from '../../database/transaction-hooks';
import { PgCncChatSignalsRepository, confirmResultOf } from './pg-cnc-chat-signals-repository';
import { PgCncTelegramRepository, ingestCompletionUpdateSql } from '../cnc-telegram/adapters/pg-cnc-telegram-repository';

const enabled = process.env.CNC_SAWN_SIGNAL_INTEGRATION === '1';
const tables = [
  'orders', 'order_details', 'order_hdf_details', 'order_statuses', 'production_statuses', 'order_workshops', 'users',
  'cnc_telegram_packets', 'cnc_telegram_packet_items', 'cnc_telegram_packet_whole_order_keys', 'mdf_board_manual_moves',
  'cut_job', 'cut_result', 'cut_result_board_projection', 'cut_result_label_map_projection', 'cut_result_archive_state',
  'cut_result_placement', 'cut_result_sheet_map', 'cut_param_profiles', 'bazis_cut_sets', 'bazis_cut_set_details',
  'materials', 'sheet_material_types', 'app_settings', 'status_automation_rules', 'outbox_events', 'audit_log',
  'audit_log_related_entity', 'command_idempotency_keys', 'cnc_manual_svg_telegram_send_requests',
  'cnc_manual_svg_telegram_send_request_files', 'cnc_telegram_worker_operations', 'cnc_telegram_worker_session_leases',
  'order_import_entity_map', 'bazis_order_links', 'cnc_telegram_packet_evidence_set', 'cnc_telegram_packet_item_evidence',
  'cnc_telegram_label_sheet_map', 'cnc_telegram_label_placement',
];
const own = ['cnc_chat_signal_messages', 'cnc_chat_signal_claims', 'cnc_chat_sawn_packet_signals', 'cnc_chat_sawn_signals',
  'cnc_chat_signal_return_resets', 'cnc_chat_signal_commands'];
const packetId = '00000000-0000-0000-0000-000000000292';
const requestId = '00000000-0000-0000-0000-000000000293';
const chat = '-100292';
const lease = { sourceChatId: chat, leaseToken: 'E2E-lease-token-0123456789-0123456789', leaseGeneration: 1,
  workerInstanceId: '00000000-0000-0000-0000-000000000294' };
const worker: CurrentUser = { id: '1', username: 'E2E-Тест воркер', role: 'admin', roleId: 1,
  permissions: getPermissionsForRole('admin') };

describe.skipIf(!enabled)('«Распилено» from the CNC chat — real PostgreSQL, owned isolated schema', { timeout: 60_000 }, () => {
  const schema = `e2e_sawn_${randomUUID().replaceAll('-', '')}`;
  const client = new Client({
    host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=20000 -c lock_timeout=5000 -c max_parallel_workers_per_gather=0 -c jit=off',
  });
  const tx: TransactionClient = {
    query: (text, params) => client.query(text, params ? [...params] : []),
    raw: client as unknown as PoolClient,
  };
  const database = {
    query: (text: string, params?: unknown[]) => client.query(text, params ?? []),
    transaction: async <T>(handler: (tx: TransactionClient) => Promise<T>, options: DatabaseTransactionOptions = {}) => {
      const scoped: TransactionClient = { ...tx };
      await client.query('BEGIN');
      beginTransactionHooks(scoped);
      try {
        if (options.mdf) await enterMdfCommand(scoped, options.mdf);
        const result = await handler(scoped);
        await flushTransactionHooks(scoped);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        discardTransactionHooks(scoped);
        discardMdfCommandBoundary(scoped);
      }
    },
  };
  const repository = new PgCncChatSignalsRepository(database as never);
  const other = new Client({
    host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000, options: '-c statement_timeout=20000 -c lock_timeout=5000',
  });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const otherDb = {
    query: (text: string, params?: unknown[]) => other.query(text, params ?? []),
    transaction: async <T>(handler: (tx: TransactionClient) => Promise<T>, options: DatabaseTransactionOptions = {}) => {
      const scoped: TransactionClient = { query: (text, params) => other.query(text, params ? [...params] : []),
        raw: other as unknown as PoolClient };
      await other.query('BEGIN');
      beginTransactionHooks(scoped);
      try {
        if (options.mdf) await enterMdfCommand(scoped, options.mdf);
        const result = await handler(scoped);
        await flushTransactionHooks(scoped);
        await other.query('COMMIT');
        return result;
      } catch (error) {
        await other.query('ROLLBACK');
        throw error;
      } finally {
        discardTransactionHooks(scoped);
        discardMdfCommandBoundary(scoped);
      }
    },
  };
  const otherRepository = new PgCncChatSignalsRepository(otherDb as never);

  beforeAll(async () => {
    // Real status automation runtime with a real «МДФ-доска распилено» rule (seeded per test).
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const table of tables) await client.query(`CREATE TABLE ${schema}.${table} AS TABLE public.${table} WITH NO DATA`);
    await client.query(`
      ALTER TABLE order_details ALTER COLUMN production_round SET DEFAULT 1;
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE mdf_board_manual_moves ALTER COLUMN move_id SET DEFAULT 1;
      ALTER TABLE mdf_board_manual_moves ALTER COLUMN version SET DEFAULT 1;
      ALTER TABLE users ADD PRIMARY KEY (user_id);
      ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY (packet_id);
      ALTER TABLE cnc_manual_svg_telegram_send_requests ADD PRIMARY KEY (request_id);
      CREATE UNIQUE INDEX sawn_settings_key ON app_settings(setting_key);
      CREATE UNIQUE INDEX sawn_move_key ON mdf_board_manual_moves(card_kind,card_id);
      CREATE UNIQUE INDEX sawn_idempotency_key ON command_idempotency_keys(idempotency_key);
      CREATE UNIQUE INDEX sawn_outbox_key ON outbox_events(idempotency_key);
      ALTER TABLE outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX sawn_related_key ON audit_log_related_entity(audit_id,entity_type,entity_id);`);
    const migration = (file: string) => readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8')
      .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
    for (const file of ['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql']) {
      await client.query(readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await client.query(migration('292_cnc_chat_sawn_signals.sql'));
    await other.connect();
    await other.query(`SET search_path=${schema},public`);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await other.end().catch(() => undefined);
    try {
      await client.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  beforeEach(async () => {
    await client.query("UPDATE mdf_engine_state SET mode='legacy'");
    await client.query(`TRUNCATE ${[...tables, ...own].map((table) => `${schema}.${table}`).join(',')} CASCADE`);
    await client.query(`
      INSERT INTO users(user_id,username,is_active) VALUES(1,'E2E-Тест',true);
      INSERT INTO order_statuses(order_status_id,order_status_name,sort_order,is_active)
        VALUES(1,'В производстве',10,true),(3,'Выдан',30,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'drawn','Отрисован',10,true),(2,'cut','Распилен',20,true),(7,'packed','Упакован',80,true),(8,'issued','Выдан',90,true);
      INSERT INTO orders(order_id,order_name,order_kind,order_status_id,delete_flag,version,created_by)
        VALUES(1,'E2E-Тест 292','production_order',1,false,1,1);
      INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,width,height)
        VALUES(11,1,1,1,1,false,100,200),(12,1,2,1,1,false,100,200);
      INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,source_version,
        payload_hash,workday,completion_status,thumbs_up,material_name,program_name,mdf_board_card_kind,created_at,updated_at,
        parse_status,rework,mdf_completion_returned,cutting_sequence_no)
        VALUES('${packetId}','E2E-Тест-292','${chat}','1',1,'E2E-hash',CURRENT_DATE,'pending',false,'МДФ 10мм','E2E-292',
        'machine_file',now(),now(),'parsed',false,false,292);
      INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,match_order_id,match_detail_id,quantity,order_name,
        detail_number,width_mm,height_mm,source,match_status)
        VALUES(gen_random_uuid(),'${packetId}',1,11,1,'E2E-Тест 292',1,100,200,'svg','matched');
      INSERT INTO cnc_manual_svg_telegram_send_requests(request_id,packet_id,status,finished_at,sent_chat_id,sent_message_ids_json)
        VALUES('${requestId}','${packetId}','sent',now() - interval '10 minutes','${chat}','["101","102"]');
      INSERT INTO cnc_manual_svg_telegram_send_request_files(request_id,file_id,send_order)
        VALUES('${requestId}',gen_random_uuid(),1);
      INSERT INTO cnc_telegram_worker_session_leases(source_chat_id,lease_token,lease_generation,worker_instance_id,expires_at)
        VALUES('${chat}','${lease.leaseToken}',1,'${lease.workerInstanceId}',now() + interval '1 hour');
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,
        is_enabled,version,action_config_json)
        VALUES(920292,'E2E-Тест распилено → упакован','mdf.board.completed','change_details_production_status',7,'{}',10,
        true,1,'{}');
      INSERT INTO app_settings(setting_key,value_json,is_active) VALUES
        ('status_automation.cnc_mark_cut_details','{"value": true}',true),
        ('cnc_chat_signals.apply_to_packet','{"value": true}',true),
        ('cnc_chat_signals.activated_at', jsonb_build_object('value', to_char((now() - interval '1 day') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);`);
  });

  const claimAndReport = async (messages: Array<{ messageId: number; thumbsCount: number; reactedAt?: string | null }>) => {
    const claim = await repository.claim({ currentUser: worker, lease, requestId: 'E2E-claim' });
    expect(claim.claim).not.toBeNull();
    const ids = claim.claim!.messages.map((message) => message.messageId);
    const report = {
      claimId: claim.claim!.claimId, claimToken: claim.claim!.claimToken, observedAt: new Date().toISOString(),
      messages: ids.map((messageId) => {
        const entry = messages.find((message) => message.messageId === messageId);
        const thumbs = entry?.thumbsCount ?? 0;
        return { messageId, present: true, thumbsCount: thumbs, canSeeList: true, readError: null,
          authors: thumbs > 0 ? { state: 'complete' as const, reactors: [{ peerType: 'user' as const, peerId: '777',
            displayName: 'E2E-Тест цех', username: null, reactedAt: entry?.reactedAt ?? new Date().toISOString() }] } : null };
      }),
    };
    return { claim, report, result: await repository.report({ currentUser: worker, lease, requestId: 'E2E-report', report }) };
  };
  const packetSignal = async () => (await client.query(
    'SELECT packet_signal_id, apply_state, origin, freshness FROM cnc_chat_sawn_packet_signals ORDER BY packet_signal_id')).rows;
  const packet = async () => (await client.query(
    'SELECT completion_status, thumbs_up FROM cnc_telegram_packets WHERE packet_id=$1', [packetId])).rows[0];
  const detailStatuses = async () => (await client.query(
    'SELECT detail_id, production_status_id FROM order_details ORDER BY detail_id')).rows;
  const outbox = async () => (await client.query('SELECT event_type FROM outbox_events ORDER BY event_type')).rows
    .map((row) => row.event_type);

  it('legacy: a fresh 👍 on a file journals, emits the events and completes the packet with «Распилен» on its detail', async () => {
    const { result } = await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    expect(result.openedSignalIds).toHaveLength(1);
    const [signal] = await packetSignal();
    expect(signal).toMatchObject({ apply_state: 'pending', origin: 'live', freshness: 'fresh' });
    const outcome = await repository.applySignal({ packetSignalId: Number(signal.packet_signal_id), mode: 'auto',
      actor: worker, requestId: 'E2E-apply', idempotencyKey: `cnc-chat-signal:${signal.packet_signal_id}` });
    expect(outcome.result).toBe('applied');
    expect(await packet()).toEqual({ completion_status: 'completed', thumbs_up: true });
    // Auto-cut sets «Распилен», then the enabled «МДФ-доска распилено» rule moves the packet's detail on.
    expect(await detailStatuses()).toEqual([{ detail_id: '11', production_status_id: 7 }, { detail_id: '12', production_status_id: 1 }]);
    expect(await outbox()).toEqual(expect.arrayContaining(['cnc.chat_signal.sawn_received', 'cnc.telegram_packet.completed',
      'order.cnc_sawn_signal_received']));
    const journal = (await client.query('SELECT message_role, reactor_peer_id, packet_signal_id FROM cnc_chat_sawn_signals')).rows;
    expect(journal).toEqual([{ message_role: 'file', reactor_peer_id: '777', packet_signal_id: signal.packet_signal_id }]);
    expect((await packetSignal())[0].apply_state).toBe('applied');
  });

  it('a later pending ingest revision keeps the signal completion until the packet is returned', async () => {
    await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    const id = Number((await packetSignal())[0].packet_signal_id);
    await repository.applySignal({ packetSignalId: id, mode: 'auto', actor: worker, requestId: 'E2E-a',
      idempotencyKey: `cnc-chat-signal:${id}` });
    const ingestPending = () => client.query(`UPDATE cnc_telegram_packets SET ${ingestCompletionUpdateSql('$2', '$3', '$4')}
      WHERE packet_id=$1`, [packetId, 'pending', false, null]);
    await ingestPending();
    expect(await packet()).toEqual({ completion_status: 'completed', thumbs_up: true });
    await client.query(`INSERT INTO audit_log(event,entity_type,entity_id,request_id,source,created_at)
      VALUES('mdf_board.production_returned','mdf_board_card',$1,'E2E-return','E2E',now())`, [`packet:${packetId}`]);
    await ingestPending();
    expect(await packet()).toEqual({ completion_status: 'pending', thumbs_up: false });
  });

  it('a 👍 only on the «Задание №…» comment is journalled without a packet signal', async () => {
    const { result } = await claimAndReport([{ messageId: 102, thumbsCount: 1 }]);
    expect(result.openedSignalIds).toEqual([]);
    expect(await packetSignal()).toEqual([]);
    expect((await client.query('SELECT message_role FROM cnc_chat_sawn_signals')).rows).toEqual([{ message_role: 'comment' }]);
  });

  it('a replayed report is effect-free', async () => {
    const { report } = await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    const again = await repository.report({ currentUser: worker, lease, requestId: 'E2E-report-2', report });
    expect(again.replay).toBe(true);
    expect(await packetSignal()).toHaveLength(1);
  });

  it('an active return barrier holds the signal and leaves the packet pending', async () => {
    await client.query('UPDATE cnc_telegram_packets SET mdf_completion_returned=true WHERE packet_id=$1', [packetId]);
    await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    const [signal] = await packetSignal();
    const outcome = await repository.applySignal({ packetSignalId: Number(signal.packet_signal_id), mode: 'auto',
      actor: worker, requestId: 'E2E-apply', idempotencyKey: `cnc-chat-signal:${signal.packet_signal_id}` });
    expect(outcome).toMatchObject({ result: 'held', state: 'held_return_barrier' });
    expect(await packet()).toEqual({ completion_status: 'pending', thumbs_up: false });
  });

  it('active MDF engine: held_engine, no write to the packet', async () => {
    await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    await client.query("UPDATE mdf_engine_state SET mode='active'");
    const [signal] = await packetSignal();
    const outcome = await repository.applySignal({ packetSignalId: Number(signal.packet_signal_id), mode: 'auto',
      actor: worker, requestId: 'E2E-apply', idempotencyKey: `cnc-chat-signal:${signal.packet_signal_id}` });
    expect(outcome).toMatchObject({ result: 'held', state: 'held_engine' });
    expect(await packet()).toEqual({ completion_status: 'pending', thumbs_up: false });
  });

  it('baseline: preview shows the effect and rolls back; confirm applies; a changed effect is a stale conflict', async () => {
    await client.query(`UPDATE app_settings SET value_json=jsonb_build_object('value', to_char(now() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE setting_key='cnc_chat_signals.activated_at'`);
    await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    const [signal] = await packetSignal();
    expect(signal).toMatchObject({ apply_state: 'held_baseline', origin: 'baseline', freshness: 'late' });
    expect(await outbox()).not.toContain('order.cnc_sawn_signal_received');
    const id = Number(signal.packet_signal_id);
    const preview = await repository.applySignal({ packetSignalId: id, mode: 'preview', actor: worker, requestId: 'E2E-preview',
      idempotencyKey: `cnc-chat-signal:${id}` });
    expect(preview).toMatchObject({ result: 'preview', eligible: true });
    if (preview.result !== 'preview') throw new Error('preview expected');
    expect(preview.effect.details).toEqual([expect.objectContaining({ detailId: 11, statusBefore: 'Отрисован', statusAfter: 'Упакован' })]);
    expect(await packet()).toEqual({ completion_status: 'pending', thumbs_up: false });
    // Someone moves the detail between preview and confirm → the confirmed effect differs.
    await client.query('UPDATE order_details SET production_status_id=7 WHERE detail_id=11');
    const stale = await repository.applySignal({ packetSignalId: id, mode: 'manual', actor: worker, requestId: 'E2E-confirm',
      expectedDigest: preview.effectDigest, idempotencyKey: `cnc-chat-signal:${id}` });
    expect(stale).toEqual({ result: 'stale_conflict' });
    expect(await packet()).toEqual({ completion_status: 'pending', thumbs_up: false });
    await client.query('UPDATE order_details SET production_status_id=1 WHERE detail_id=11');
    const fresh = await repository.applySignal({ packetSignalId: id, mode: 'preview', actor: worker, requestId: 'E2E-preview-2',
      idempotencyKey: `cnc-chat-signal:${id}` });
    if (fresh.result !== 'preview') throw new Error('preview expected');
    const applied = await repository.applySignal({ packetSignalId: id, mode: 'manual', actor: worker, requestId: 'E2E-confirm-2',
      expectedDigest: fresh.effectDigest, idempotencyKey: `cnc-chat-signal:${id}` });
    expect(applied.result).toBe('applied');
    expect(await packet()).toEqual({ completion_status: 'completed', thumbs_up: true });
  });

  it('removal of 👍 closes the signal without touching the packet', async () => {
    await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    await client.query('UPDATE cnc_chat_signal_messages SET next_poll_at=now()');
    await claimAndReport([]);
    const [signal] = await packetSignal();
    expect(signal.apply_state).toBe('closed');
    expect((await client.query('SELECT count(*)::int AS open FROM cnc_chat_sawn_signals WHERE cleared_observed_at IS NULL'))
      .rows[0].open).toBe(0);
    expect(await packet()).toEqual({ completion_status: 'pending', thumbs_up: false });
  });

  const recordReturn = async (minutesAgo: number) => {
    await client.query(`UPDATE cnc_telegram_packets SET mdf_completion_returned=true, completion_status='pending',
      thumbs_up=false WHERE packet_id=$1`, [packetId]);
    const row = await client.query(`INSERT INTO audit_log(event,entity_type,entity_id,request_id,source,created_at)
      VALUES('mdf_board.production_returned','mdf_board_card',$1,'E2E-return','E2E',now() - make_interval(mins => $2))
      RETURNING audit_id::text`, [`packet:${packetId}`, minutesAgo]);
    return row.rows[0].audit_id as string;
  };
  const barrier = async () => (await client.query(
    'SELECT mdf_completion_returned AS returned FROM cnc_telegram_packets WHERE packet_id=$1', [packetId])).rows[0].returned;

  it('F16: «0 👍» after a return creates a reset bound to that return, and the reset clears the barrier', async () => {
    const ref = await recordReturn(30);
    await claimAndReport([]);
    const resets = (await client.query('SELECT reset_id, return_ref, state FROM cnc_chat_signal_return_resets')).rows;
    expect(resets).toEqual([{ reset_id: expect.anything(), return_ref: ref, state: 'pending' }]);
    expect(await repository.runReturnReset({ resetId: Number(resets[0].reset_id), actor: worker, requestId: 'E2E-reset' }))
      .toBe('done');
    expect(await barrier()).toBe(false);
  });

  it('F18: a return between claim issue and the report does not create a reset; a fresh poll asks again', async () => {
    await recordReturn(30);
    const claim = await repository.claim({ currentUser: worker, lease, requestId: 'E2E-claim' });
    await recordReturn(0); // newer return generation after the claim was issued
    const report = {
      claimId: claim.claim!.claimId, claimToken: claim.claim!.claimToken, observedAt: new Date().toISOString(),
      messages: claim.claim!.messages.map((message) => ({ messageId: message.messageId, present: true, thumbsCount: 0,
        canSeeList: true, readError: null, authors: null })),
    };
    await repository.report({ currentUser: worker, lease, requestId: 'E2E-report', report });
    expect((await client.query('SELECT count(*)::int AS n FROM cnc_chat_signal_return_resets')).rows[0].n).toBe(0);
    expect((await client.query('SELECT bool_and(next_poll_at <= now()) AS due FROM cnc_chat_signal_messages')).rows[0].due)
      .toBe(true);
    expect(await barrier()).toBe(true);
  });

  it('two concurrent runners of one reset: one clears the barrier, the other finds nothing to do', async () => {
    await recordReturn(30);
    await claimAndReport([]);
    const [reset] = (await client.query('SELECT reset_id FROM cnc_chat_signal_return_resets')).rows;
    const results = await Promise.all([
      repository.runReturnReset({ resetId: Number(reset.reset_id), actor: worker, requestId: 'E2E-ra' }),
      otherRepository.runReturnReset({ resetId: Number(reset.reset_id), actor: worker, requestId: 'E2E-rb' }),
    ]);
    expect(results.sort()).toEqual(['done', 'noop']);
    expect((await client.query('SELECT state FROM cnc_chat_signal_return_resets')).rows).toEqual([{ state: 'done' }]);
    expect(await barrier()).toBe(false);
  });

  it('F16: a delayed reset is cancelled when the packet was returned again', async () => {
    await recordReturn(30);
    await claimAndReport([]);
    const [reset] = (await client.query('SELECT reset_id FROM cnc_chat_signal_return_resets')).rows;
    await recordReturn(0);
    expect(await repository.runReturnReset({ resetId: Number(reset.reset_id), actor: worker, requestId: 'E2E-reset' }))
      .toBe('cancelled_stale');
    expect(await barrier()).toBe(true);
  });

  it('a claim of a previous session generation is refused after the same instance re-acquires the session', async () => {
    const claim = await repository.claim({ currentUser: worker, lease, requestId: 'E2E-claim' });
    await client.query('UPDATE cnc_telegram_worker_session_leases SET lease_generation=2');
    const report = { claimId: claim.claim!.claimId, claimToken: claim.claim!.claimToken, observedAt: new Date().toISOString(),
      messages: claim.claim!.messages.map((message) => ({ messageId: message.messageId, present: true, thumbsCount: 1,
        canSeeList: null, readError: null, authors: null })) };
    await expect(repository.report({ currentUser: worker, lease: { ...lease, leaseGeneration: 2 }, requestId: 'E2E-r',
      report })).rejects.toMatchObject({ code: 'CNC_SAWN_SIGNAL_CLAIM_STALE' });
    expect(await packetSignal()).toEqual([]);
  });

  it('automatic selection skips stale signals so a fresh one is not starved', async () => {
    await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    await client.query("UPDATE cnc_chat_sawn_packet_signals SET last_positive_observed_at=now() - interval '1 hour'");
    expect(await repository.dueAutoApplies(20)).toEqual([]);
    await client.query('UPDATE cnc_chat_sawn_packet_signals SET last_positive_observed_at=now()');
    expect(await repository.dueAutoApplies(20)).toHaveLength(1);
  });

  it('F10: a rule changed between preview and confirm is a stale conflict', async () => {
    await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    const [signal] = await packetSignal();
    const id = Number(signal.packet_signal_id);
    const preview = await repository.applySignal({ packetSignalId: id, mode: 'preview', actor: worker, requestId: 'E2E-p',
      idempotencyKey: `cnc-chat-signal:${id}` });
    if (preview.result !== 'preview') throw new Error('preview expected');
    await client.query('UPDATE status_automation_rules SET version=version+1 WHERE id=920292');
    expect(await repository.applySignal({ packetSignalId: id, mode: 'manual', actor: worker, requestId: 'E2E-c',
      expectedDigest: preview.effectDigest, idempotencyKey: `cnc-chat-signal:${id}` })).toEqual({ result: 'stale_conflict' });
    expect(await packet()).toEqual({ completion_status: 'pending', thumbs_up: false });
  });

  it('F13: a reset hitting read_only waits and completes after the return to legacy', async () => {
    await recordReturn(30);
    await claimAndReport([]);
    const [reset] = (await client.query('SELECT reset_id FROM cnc_chat_signal_return_resets')).rows;
    await client.query("UPDATE mdf_engine_state SET mode='read_only'");
    expect(await repository.runReturnReset({ resetId: Number(reset.reset_id), actor: worker, requestId: 'E2E-r1' }))
      .toBe('retry_wait');
    expect(await barrier()).toBe(true);
    await client.query("UPDATE mdf_engine_state SET mode='legacy'");
    expect(await repository.runReturnReset({ resetId: Number(reset.reset_id), actor: worker, requestId: 'E2E-r2' }))
      .toBe('done');
    expect(await barrier()).toBe(false);
  });

  it('a taken-over confirmation owner cannot commit an effect', async () => {
    await client.query(`UPDATE app_settings SET value_json=jsonb_build_object('value', to_char(now() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE setting_key='cnc_chat_signals.activated_at'`);
    await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    const id = Number((await packetSignal())[0].packet_signal_id);
    await client.query(`INSERT INTO cnc_chat_signal_commands(idempotency_key,command,actor_user_id,request_hash,response)
      VALUES('E2E-confirm-key','apply_pending_confirm',1,'h','{"state":"in_progress","owner":"new-owner","results":{}}')`);
    await expect(repository.applySignal({ packetSignalId: id, mode: 'manual', actor: worker, requestId: 'E2E-old',
      idempotencyKey: `cnc-chat-signal:${id}`, commandItem: { key: 'E2E-confirm-key', owner: 'old-owner' } }))
      .rejects.toMatchObject({ code: 'CNC_SAWN_SIGNAL_CONFIRM_TAKEN_OVER' });
    expect(await packet()).toEqual({ completion_status: 'pending', thumbs_up: false });
  });

  it('confirm: a concurrent same-key request is refused; an expired lease is taken over keeping stored results', async () => {
    await client.query(`UPDATE app_settings SET value_json=jsonb_build_object('value', to_char(now() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE setting_key='cnc_chat_signals.activated_at'`);
    await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
    const id = Number((await packetSignal())[0].packet_signal_id);
    const preview = await repository.applySignal({ packetSignalId: id, mode: 'preview', actor: worker, requestId: 'E2E-p',
      idempotencyKey: `cnc-chat-signal:${id}` });
    if (preview.result !== 'preview') throw new Error('preview expected');
    const dto = { items: [{ packetSignalId: id, effectDigest: preview.effectDigest }], idempotencyKey: 'E2E-confirm-0001' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = repository.confirmCommand({ actor: worker, dto, requestId: 'E2E-c1', applyItem: async (item, commandItem) => {
      await gate;
      return confirmResultOf(item.packetSignalId, await repository.applySignal({ packetSignalId: item.packetSignalId,
        mode: 'manual', actor: worker, requestId: 'E2E-c1', expectedDigest: item.effectDigest,
        idempotencyKey: `cnc-chat-signal:${item.packetSignalId}`, commandItem }));
    } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(otherRepository.confirmCommand({ actor: worker, dto, requestId: 'E2E-c2',
      applyItem: async () => { throw new Error('must not run'); } }))
      .rejects.toMatchObject({ code: 'CNC_SAWN_SIGNAL_CONFIRM_IN_PROGRESS' });
    release();
    expect(await first).toEqual({ results: [{ packetSignalId: id, result: 'applied' }] });
    // A replay of the finished command returns the stored receipt without running anything.
    expect(await repository.confirmCommand({ actor: worker, dto, requestId: 'E2E-c3',
      applyItem: async () => { throw new Error('must not run'); } })).toEqual({ results: [{ packetSignalId: id, result: 'applied' }] });
  });

  describe('F15: lock order is compatible with ingest and the auto-cut configuration (independent connections)', () => {

    const pendingSignal = async () => {
      await claimAndReport([{ messageId: 101, thumbsCount: 1 }]);
      return Number((await packetSignal())[0].packet_signal_id);
    };

    it('ingest holding the packet then the auto-cut lock: apply waits and completes, no deadlock', async () => {
      const id = await pendingSignal();
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM cnc_telegram_packets WHERE packet_id=$1 FOR UPDATE', [packetId]);
      await other.query("SELECT pg_advisory_xact_lock(hashtext('status_automation.cnc_mark_cut_details'))");
      const applying = repository.applySignal({ packetSignalId: id, mode: 'auto', actor: worker, requestId: 'E2E-cc1',
        idempotencyKey: `cnc-chat-signal:${id}` });
      await wait(300);
      await other.query('UPDATE order_details SET version=version WHERE detail_id=11');
      await other.query('COMMIT');
      expect((await applying).result).toBe('applied');
    });

    it('the real configureAutoCutStatus on another connection runs concurrently with apply without deadlock', async () => {
      const id = await pendingSignal();
      const otherDatabase = {
        query: (text: string, params?: unknown[]) => other.query(text, params ?? []),
        transaction: async <T>(handler: (tx: TransactionClient) => Promise<T>) => {
          const scoped: TransactionClient = { query: (text, params) => other.query(text, params ? [...params] : []),
            raw: other as unknown as PoolClient };
          await other.query('BEGIN');
          beginTransactionHooks(scoped);
          try {
            const result = await handler(scoped);
            await flushTransactionHooks(scoped);
            await other.query('COMMIT');
            return result;
          } catch (error) {
            await other.query('ROLLBACK');
            throw error;
          } finally {
            discardTransactionHooks(scoped);
          }
        },
      };
      const cnc = new PgCncTelegramRepository(otherDatabase as never);
      const [configured, applied] = await Promise.all([
        cnc.configureAutoCutStatus({ currentUser: worker, enabled: true, idempotencyKey: `E2E-configure-${randomUUID()}` }),
        repository.applySignal({ packetSignalId: id, mode: 'auto', actor: worker, requestId: 'E2E-cc3',
          idempotencyKey: `cnc-chat-signal:${id}` }),
      ]);
      expect(configured).toBeTruthy();
      expect(applied.result).toBe('applied');
      expect(await detailStatuses()).toEqual([{ detail_id: '11', production_status_id: 7 }, { detail_id: '12', production_status_id: 1 }]);
    });

    it('report closing a returned packet vs preview: the report waits on the packet before its signal (no cycle)', async () => {
      const id = await pendingSignal();
      await recordReturn(30);
      await client.query('UPDATE cnc_chat_signal_messages SET next_poll_at=now()');
      const claim = await repository.claim({ currentUser: worker, lease, requestId: 'E2E-claim' });
      const report = { claimId: claim.claim!.claimId, claimToken: claim.claim!.claimToken, observedAt: new Date().toISOString(),
        messages: claim.claim!.messages.map(({ messageId }) => ({ messageId, present: true, thumbsCount: 0, canSeeList: true,
          readError: null, authors: null })) };
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM cnc_telegram_packets WHERE packet_id=$1 FOR UPDATE', [packetId]); // apply's 1st lock
      const reporting = repository.report({ currentUser: worker, lease, requestId: 'E2E-report-cc', report });
      await wait(300);
      // apply's 2nd lock: the report must not hold the signal yet.
      await other.query('SELECT 1 FROM cnc_chat_sawn_packet_signals WHERE packet_signal_id=$1 FOR UPDATE NOWAIT', [id]);
      await other.query('COMMIT');
      expect((await reporting).accepted).toBe(true);
      expect((await packetSignal())[0].apply_state).toBe('closed');
    });

    it('two packets sharing an order are applied concurrently on two connections without deadlock', async () => {
      const second = '00000000-0000-0000-0000-000000000296';
      await client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
          source_version,payload_hash,workday,completion_status,thumbs_up,material_name,program_name,mdf_board_card_kind,
          created_at,updated_at,parse_status,rework,mdf_completion_returned,cutting_sequence_no)
        VALUES($1,'E2E-Тест-296',$2,'2',1,'E2E-hash',CURRENT_DATE,'pending',false,'МДФ 10мм','E2E-296','machine_file',now(),now(),
          'parsed',false,false,296);
        INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,match_order_id,match_detail_id,quantity,order_name,
          detail_number,width_mm,height_mm,source,match_status)
        VALUES(gen_random_uuid(),$1,1,12,1,'E2E-Тест 292',2,100,200,'svg','matched');
        INSERT INTO cnc_manual_svg_telegram_send_requests(request_id,packet_id,status,finished_at,sent_chat_id,sent_message_ids_json)
        VALUES('00000000-0000-0000-0000-000000000297',$1,'sent',now() - interval '10 minutes',$2,'["201","202"]');
        INSERT INTO cnc_manual_svg_telegram_send_request_files(request_id,file_id,send_order)
        VALUES('00000000-0000-0000-0000-000000000297',gen_random_uuid(),1);`.replaceAll('$1', `'${second}'`).replaceAll('$2', `'${chat}'`));
      await claimAndReport([{ messageId: 101, thumbsCount: 1 }, { messageId: 201, thumbsCount: 1 }]);
      const ids = (await packetSignal()).map((row) => Number(row.packet_signal_id));
      expect(ids).toHaveLength(2);
      const results = await Promise.all([
        repository.applySignal({ packetSignalId: ids[0]!, mode: 'auto', actor: worker, requestId: 'E2E-s1',
          idempotencyKey: `cnc-chat-signal:${ids[0]}` }),
        otherRepository.applySignal({ packetSignalId: ids[1]!, mode: 'auto', actor: worker, requestId: 'E2E-s2',
          idempotencyKey: `cnc-chat-signal:${ids[1]}` }),
      ]);
      expect(results.map((result) => result.result)).toEqual(['applied', 'applied']);
    });

    it('the real ingest of a pending revision of the same packet runs concurrently with apply; completion survives', async () => {
      const id = await pendingSignal();
      const cnc = new PgCncTelegramRepository(otherDb as never);
      const ingest = cnc.ingest({ currentUser: worker, requestId: 'E2E-ingest', dto: {
        idempotencyKey: `E2E-ingest-${randomUUID()}`, externalPacketKey: 'E2E-Тест-292',
        source: { chatId: chat, messageId: 1, version: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        completionStatus: 'pending', thumbsUp: false, materialName: 'МДФ 10мм', programName: 'E2E-292',
        items: [{ sourceItemKey: 'E2E-1', orderName: 'E2E-Тест 292', detailNumber: 1, widthMm: 100, heightMm: 200, quantity: 1 }],
      } as never });
      const [ingested, applied] = await Promise.allSettled([ingest, repository.applySignal({ packetSignalId: id, mode: 'auto',
        actor: worker, requestId: 'E2E-cc4', idempotencyKey: `cnc-chat-signal:${id}` })]);
      expect(applied.status === 'fulfilled' ? applied.value.result : applied.reason).toBe('applied');
      expect(ingested.status === 'fulfilled' ? 'ok' : String((ingested as PromiseRejectedResult).reason)).toBe('ok');
      expect(await packet()).toEqual({ completion_status: 'completed', thumbs_up: true });
    });

    it('configuration holding the auto-cut lock and an order: apply waits and completes, no deadlock', async () => {
      const id = await pendingSignal();
      await other.query('BEGIN');
      await other.query("SELECT pg_advisory_xact_lock(hashtext('status_automation.cnc_mark_cut_details'))");
      await other.query('SELECT 1 FROM orders WHERE order_id=1 FOR UPDATE');
      const applying = repository.applySignal({ packetSignalId: id, mode: 'auto', actor: worker, requestId: 'E2E-cc2',
        idempotencyKey: `cnc-chat-signal:${id}` });
      await wait(300);
      await other.query('COMMIT');
      expect((await applying).result).toBe('applied');
    });
  });
});
