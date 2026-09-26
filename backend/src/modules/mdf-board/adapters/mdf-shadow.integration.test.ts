import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import { beforeTransactionCommit } from '../../../database/transaction-hooks';
import { observeMdfShadowCommand as observeCommand } from '../application/mdf-shadow';
import type { TransactionClient } from '../../../database/database.types';
import type { MdfShadowCommand } from '../application/mdf-shadow-command';
import type { PerformanceQueryTelemetryService } from '../../../performance/performance-query-telemetry.service';
import { dispatchMdfBoardEvent } from '../../status-automation/application/status-automation-runtime';
import type { MdfBoardEventInput, MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';
import { loadMdfShadowSource } from './mdf-shadow-source';
import { prepareMdfShadow } from '../application/mdf-shadow';
import { discoverMdfComparisonScope } from './mdf-comparison-snapshot';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('MDF shadow through real DatabaseService and event dispatch', () => {
  const schema = `e2e_mdf_shadow_${randomUUID().replaceAll('-', '')}`;
  const packetId = randomUUID();
  const host = process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1';
  const client = new Client({ host, database: process.env.PG_DB, user: process.env.PG_USER,
    password: process.env.PG_PASSWORD, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=10000 -c lock_timeout=1000 -c max_parallel_workers_per_gather=0 -c jit=off' });
  let database: DatabaseService;
  const source: MdfBoardSource = { kind: 'packet', id: packetId };
  const event = (key: string, card = source): MdfBoardEventInput => ({ source: card,
    actor: { id: '1', username: 'e2e', role: 'admin', roleId: 1, permissions: [] },
    requestId: key, sourceIdempotencyKey: key });
  const observeMdfShadowCommand = async (tx: TransactionClient, input: MdfBoardEventInput, command: MdfShadowCommand) => {
    const returned = command.kind === 'production_return';
    await tx.query(`INSERT INTO audit_log(audit_id,event,entity_type,entity_id,user_id,request_id,status_code,status_id,metadata_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(audit_id) DO NOTHING`,
    [command.auditId, command.kind === 'manual_move' ? 'mdf_board.manual_move.created'
      : command.kind === 'manual_clear' ? 'mdf_board.manual_move.deleted' : 'mdf_board.production_returned',
      returned ? 'mdf_board_card' : 'mdf_board_manual_move', `${input.source.kind}:${input.source.id}`,
      Number(input.actor.id), input.requestId, command.targetColumn, returned ? command.targetStageId : null,
      JSON.stringify(returned ? { previewDigest: command.previewDigest } : {})]);
    await observeCommand(tx, input, command);
  };
  const send = (key: string, card = source) => database.transaction(async tx => {
    await tx.query(`SET LOCAL search_path=${schema},public`);
    await dispatchMdfBoardEvent(tx, event(key, card));
  });
  const observation = async (key: string) => (await client.query(`SELECT o.*,r.actor_user_id,r.request_id,
    h.accepted_revision_key,j.status FROM mdf_shadow_observations o
    JOIN mdf_evidence_revisions r USING(source_kind,source_id,revision_key)
    JOIN mdf_source_heads h USING(source_kind,source_id)
    JOIN mdf_recalculation_jobs j USING(source_kind,source_id,revision_key) WHERE r.request_id=$1`, [key])).rows;
  beforeAll(async () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE', 'true');
    vi.stubEnv('BACKEND_ENABLE_STATUS_AUTOMATION', 'false');
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql', '167_mdf_shadow_observations.sql', '171_mdf_shadow_commands.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql', '178_mdf_correction_receipts.sql', '188_mdf_order_cascade_intents.sql']) {
      await client.query(readFileSync(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    // Actual deployed column types; isolated owned schema, no operational writes.
    for (const table of ['orders', 'order_details', 'cnc_telegram_packets', 'cnc_telegram_packet_items',
      'cnc_telegram_packet_whole_order_keys', 'mdf_board_manual_moves', 'status_automation_rules',
      'bazis_cut_sets', 'bazis_cut_set_details', 'cut_result', 'cut_result_board_projection',
      'cut_result_placement', 'cut_result_sheet_map', 'sheet_material_types', 'materials', 'audit_log']) {
      await client.query(`CREATE TABLE ${schema}.${table} AS SELECT * FROM public.${table} WITH NO DATA`);
    }
    await client.query(`ALTER TABLE cut_result_placement ADD COLUMN IF NOT EXISTS order_hdf_detail_id bigint;
      CREATE UNIQUE INDEX shadow_audit_id ON audit_log(audit_id);
      INSERT INTO orders(order_id,delete_flag) VALUES(1,false),(2,false);
      INSERT INTO sheet_material_types(sheet_material_type_id,name) VALUES(1,'МДФ 10мм');
      INSERT INTO order_details(detail_id,order_id,quantity,delete_flag,sheet_material_type_id)
        VALUES(11,1,20,false,1),(12,1,3,false,1),(21,2,7,false,1);
      INSERT INTO status_automation_rules(id,version,is_enabled,event_type) VALUES(17,3,true,'mdf.board.completed');`);
    await client.query(`INSERT INTO cnc_telegram_packets(packet_id,source_version,updated_at,material_name,
      program_name,external_packet_key,comments_json,completion_status,thumbs_up,rework,mdf_completion_returned,mdf_board_card_kind)
      VALUES($1,1,'2001-01-01','МДФ 16мм','e2e-mdf','e2e-mdf','[]','completed',true,false,false,'machine_file');
    `, [packetId]);
    await client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,
      match_order_id,match_detail_id,match_status,quantity)
      VALUES($1,$2,'a',1,11,'matched',5),($3,$2,'b',2,21,'matched',2)`, [randomUUID(), packetId, randomUUID()]);
    const url = new URL(`postgresql://${host}/${process.env.PG_DB}`);
    url.username = process.env.PG_USER ?? ''; url.password = process.env.PG_PASSWORD ?? '';
    url.searchParams.set('options', '-c max_parallel_workers_per_gather=0 -c jit=off -c lock_timeout=1000');
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 10000,
      DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 2, DATABASE_SSL: false };
    database = new DatabaseService({ get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.onModuleDestroy();
    try {
      await client.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
    } finally { await client.end(); }
  });
  it('captures a real dispatch with automation disabled, full mixed scope, no period cutoff or accepted facts', async () => {
    await send('capture');
    const rows = await observation('capture');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: '1', accepted_revision_key: null, status: 'needs_attention' });
    expect(rows[0].candidate_quantities).toMatchObject({ required: 7, cut: 7 });
    expect(rows[0].candidate_quantities.positions.map((p: { detailId: number }) => p.detailId)).toEqual([11,21]);
    expect((await client.query('SELECT rule_id,rule_version FROM mdf_recalculation_job_rules')).rows)
      .toEqual([{ rule_id: '17', rule_version: '3' }]);
    expect((await client.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision).toBe('0');
  });
  it('deduplicates both repeated dispatch inside one transaction and replay', async () => {
    await database.transaction(async tx => {
      await tx.query(`SET LOCAL search_path=${schema},public`);
      await dispatchMdfBoardEvent(tx, event('duplicate'));
      await dispatchMdfBoardEvent(tx, event('duplicate'));
    });
    await database.transaction(async tx => {
      await tx.query(`SET LOCAL search_path=${schema},public`);
      await dispatchMdfBoardEvent(tx, { ...event('duplicate'), requestId: 'duplicate-new-http-request' });
    });
    expect(await observation('duplicate')).toHaveLength(1);
    expect(await observation('duplicate-new-http-request')).toHaveLength(0);
  });
  it('rolls back source and receipt when a later finalizer fails', async () => {
    await expect(database.transaction(async tx => {
      await tx.query(`SET LOCAL search_path=${schema},public`);
      await tx.query('UPDATE cnc_telegram_packets SET program_name=$1', ['rollback-name']);
      await dispatchMdfBoardEvent(tx, event('rollback'));
      beforeTransactionCommit(tx, 'z-fail', async () => { await tx.query('SELECT 1/0'); });
    })).rejects.toMatchObject({ code: '22012' });
    expect(await observation('rollback')).toHaveLength(0);
    expect((await client.query('SELECT program_name FROM cnc_telegram_packets')).rows[0].program_name).toBe('e2e-mdf');
  });
  it('excludes transliterated non-MDF filenames even with default MDF material', async () => {
    await client.query("UPDATE cnc_telegram_packets SET program_name='fanera_18.nc'");
    await send('material');
    expect((await observation('material'))[0].candidate_quantities.cut).toBe(0);
    await client.query("UPDATE cnc_telegram_packets SET program_name='e2e-mdf'");
  });
  it('captures manual BASIS once and never infers physical cut from order/detail statuses', async () => {
    await client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,version,updated_at) VALUES(1,1,now());
      INSERT INTO bazis_cut_set_details(bazis_cut_set_id,bazis_cut_set_detail_id,source_order_id,
        source_order_detail_id,quantity,material_name,cut_enabled,updated_at) VALUES(1,1,1,11,8,'MDF 18',true,now())`);
    const basis: MdfBoardSource = { kind: 'bazisCutSet', id: '1' };
    await send('basis-pending', basis);
    expect((await observation('basis-pending'))[0].candidate_quantities.cut).toBe(0);
    await client.query(`INSERT INTO mdf_board_manual_moves(move_id,card_kind,card_id,target_column,version,updated_at)
      VALUES(1,'bazisCutSet','1','completed',1,now())`);
    await send('basis-cut', basis);
    expect((await observation('basis-cut'))[0].candidate_quantities.cut).toBe(8);
  });
  it('captures effective bath membership only; manual ready does not manufacture cut supply', async () => {
    await client.query(`INSERT INTO cut_result(cut_result_id,snapshot_digest) VALUES(1,'e2e-digest');
      INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum) VALUES(1,'e2e-digest',true);
      INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,is_effective) VALUES(1,true),(2,false);
      INSERT INTO cut_result_placement(cut_result_id,cut_result_sheet_map_id,order_id,order_detail_id)
        VALUES(1,1,1,11),(1,1,1,11),(1,2,2,21);
      INSERT INTO mdf_board_manual_moves(move_id,card_kind,card_id,target_column,version,updated_at)
        VALUES(2,'bath','cut-result:1','baths_ready',1,now())`);
    const bath: MdfBoardSource = { kind: 'bath', id: 'cut-result:1' };
    await send('bath-ready', bath);
    expect((await observation('bath-ready'))[0].candidate_quantities).toMatchObject({ required: 2, cut: 0, rolled: 0 });
    await client.query("UPDATE mdf_board_manual_moves SET target_column='baths_laminated',version=2 WHERE card_kind='bath'");
    await send('bath-laminated', bath);
    expect((await observation('bath-laminated'))[0].candidate_quantities).toMatchObject({ required: 2, cut: 0, rolled: 2 });
  });
  it('typed HDF neither taints shadow membership nor expands comparison owner closure', async () => {
    await client.query(`INSERT INTO cut_result(cut_result_id,snapshot_digest) VALUES(90,'typed-mixed'),(91,'typed-hdf');
      INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum)
        VALUES(90,'typed-mixed',true),(91,'typed-hdf',true);
      INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,is_effective) VALUES(90,true);
      INSERT INTO cut_result_placement(cut_result_id,cut_result_sheet_map_id,order_id,order_detail_id,order_hdf_detail_id)
        VALUES(90,90,1,11,NULL),(90,90,2,NULL,11),(91,90,1,NULL,11);`);
    const mixed = { kind: 'bath' as const, id: 'cut-result:90' };
    const hdf = { kind: 'bath' as const, id: 'cut-result:91' };
    const rows = await loadMdfShadowSource(client, mixed);
    expect(rows).toHaveLength(1);
    const prepared = prepareMdfShadow(rows);
    expect(prepared.issues).not.toContain('UNRESOLVED_MEMBERSHIP');
    expect(prepared.issues).not.toContain('MATERIAL_OR_SOURCE_EXCLUDED');
    expect(prepared.candidateQuantities).toMatchObject({ required: 1, cut: 0, rolled: 0 });
    expect(await loadMdfShadowSource(client, hdf)).toEqual([]);
    expect(prepareMdfShadow(await loadMdfShadowSource(client, hdf)).issues).not.toContain('UNRESOLVED_MEMBERSHIP');
    const scope = await discoverMdfComparisonScope(client, mixed);
    expect(scope.sources).not.toContainEqual(hdf);
    await expect(discoverMdfComparisonScope(client, hdf)).rejects.toThrow('UNRESOLVED_OWNERS');
    await client.query(`INSERT INTO cut_result_placement(cut_result_id,cut_result_sheet_map_id,order_id,order_detail_id)
      VALUES(90,90,1,NULL)`);
    expect(prepareMdfShadow(await loadMdfShadowSource(client, mixed)).issues).toContain('UNRESOLVED_MEMBERSHIP');
  });

  it('freezes explicit membership before later writes and generic dispatch, all commands survive in order', async () => {
    const confirmAudit = randomUUID(), clearAudit = randomUUID();
    await database.transaction(async tx => {
      await tx.query(`SET LOCAL search_path=${schema},public`);
      await observeMdfShadowCommand(tx, event('explicit-confirm'), { kind: 'manual_move', targetColumn: 'completed', auditId: confirmAudit });
      await tx.query("UPDATE cnc_telegram_packet_items SET quantity=6 WHERE source_item_key='a'");
      await observeMdfShadowCommand(tx, event('explicit-clear'), { kind: 'manual_clear', targetColumn: null, auditId: clearAudit });
      await dispatchMdfBoardEvent(tx, event('explicit-final-state'));
    });
    const commands = (await client.query(`SELECT c.*,r.origin,r.actor_user_id,r.request_id,h.accepted_revision_key
      FROM mdf_shadow_commands c JOIN mdf_evidence_revisions r USING(source_kind,source_id,revision_key)
      JOIN mdf_source_heads h USING(source_kind,source_id) ORDER BY observation_id`)).rows;
    expect(commands.map(c => c.command_kind)).toEqual(['manual_move', 'manual_clear']);
    expect(commands[0]).toMatchObject({ audit_event_id: confirmAudit, origin: 'manual', actor_user_id: '1',
      request_id: 'explicit-confirm', target_column: 'completed', accepted_revision_key: null });
    expect(commands[1]).toMatchObject({ audit_event_id: clearAudit, target_column: null });
    expect(commands[0].composition_digest).not.toBe(commands[1].composition_digest);
    for (const [request, qty] of [['explicit-confirm', 7], ['explicit-clear', 8]] as const) {
      expect((await observation(request))[0].candidate_quantities).toMatchObject({ required: qty, cut: 0, rolled: 0 });
      const lines = (await client.query(`SELECT l.detail_id,l.quantity,l.evidence_kind FROM mdf_evidence_lines l
        JOIN mdf_evidence_revisions r USING(source_kind,source_id,revision_key) WHERE r.request_id=$1 ORDER BY detail_id`, [request])).rows;
      expect(lines).toEqual([{ detail_id: '11', quantity: String(qty - 2), evidence_kind: 'derived' },
        { detail_id: '21', quantity: '2', evidence_kind: 'derived' }]);
    }
    expect(await observation('explicit-final-state')).toHaveLength(1);
    await expect(client.query("UPDATE mdf_shadow_commands SET target_column='parsed' WHERE audit_event_id=$1", [confirmAudit])).rejects.toThrow();
    await expect(client.query('DELETE FROM mdf_shadow_commands WHERE audit_event_id=$1', [clearAudit])).rejects.toThrow();
  });
  it('deduplicates explicit replay and rejects reused cause with changed audit or target', async () => {
    const intent = { kind: 'manual_move' as const, targetColumn: 'completed', auditId: randomUUID() };
    const sendCommand = (command = intent) => database.transaction(async tx => {
      await tx.query(`SET LOCAL search_path=${schema},public`);
      await observeMdfShadowCommand(tx, event('explicit-replay'), command);
      await observeMdfShadowCommand(tx, event('explicit-replay'), command);
    });
    await sendCommand(); await sendCommand();
    expect(await observation('explicit-replay')).toHaveLength(1);
    await expect(sendCommand({ ...intent, targetColumn: 'completed_laminated' })).rejects.toThrow('MDF_RECEIPT_CONFLICT');
    await expect(sendCommand({ ...intent, auditId: randomUUID() })).rejects.toThrow('MDF_RECEIPT_CONFLICT');
    expect(await observation('explicit-replay')).toHaveLength(1);
  });
  it('captures BASIS/bath explicit commands and custom-stage return without accepting or fabricating work', async () => {
    for (const card of [{ kind: 'bazisCutSet' as const, id: '1' }, { kind: 'bath' as const, id: 'cut-result:1' }]) {
      const key = `explicit-${card.kind}`;
      await database.transaction(async tx => {
        await tx.query(`SET LOCAL search_path=${schema},public`);
        await observeMdfShadowCommand(tx, event(key, card), { kind: 'production_return',
          targetColumn: card.kind === 'bath' ? 'baths_ready' : 'completed', auditId: randomUUID(),
          targetStageId: 4, targetStageCode: 'sanded', previewDigest: 'a'.repeat(64) });
      });
      expect((await observation(key))[0]).toMatchObject({ accepted_revision_key: null, status: 'needs_attention' });
      expect((await observation(key))[0].candidate_quantities).toMatchObject({ cut: 0, rolled: 0 });
      expect((await client.query('SELECT target_stage_id,target_stage_code,preview_digest FROM mdf_shadow_commands WHERE source_kind=$1', [card.kind])).rows[0])
        .toEqual({ target_stage_id: '4', target_stage_code: 'sanded', preview_digest: 'a'.repeat(64) });
    }
    expect((await client.query('SELECT count(*) n FROM mdf_bath_allocations')).rows[0].n).toBe('0');
    expect((await client.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision).toBe('0');
  });
  it('rolls back typed journal and source mutation together on late failure', async () => {
    const before = (await client.query('SELECT program_name FROM cnc_telegram_packets')).rows[0].program_name;
    await expect(database.transaction(async tx => {
      await tx.query(`SET LOCAL search_path=${schema},public`);
      await tx.query("UPDATE cnc_telegram_packets SET program_name='E2E-rollback'");
      await observeMdfShadowCommand(tx, event('typed-rollback'), { kind: 'manual_move', targetColumn: 'completed', auditId: randomUUID() });
      beforeTransactionCommit(tx, 'z-typed-fail', async () => { await tx.query('SELECT 1/0'); });
    })).rejects.toMatchObject({ code: '22012' });
    expect(await observation('typed-rollback')).toHaveLength(0);
    expect((await client.query('SELECT program_name FROM cnc_telegram_packets')).rows[0].program_name).toBe(before);
  });
  it('serializes concurrent reverse-order source batches without dropping explicit commands', async () => {
    const cards: MdfBoardSource[] = [source, { kind: 'bazisCutSet', id: '1' }];
    await Promise.all([cards, [...cards].reverse()].map((batch, n) => database.transaction(async tx => {
      await tx.query(`SET LOCAL search_path=${schema},public`);
      for (const card of batch) await observeMdfShadowCommand(tx, event(`concurrent-${n}-${card.kind}`, card),
        { kind: 'manual_move', targetColumn: 'completed', auditId: randomUUID() });
    })));
    const rows = (await client.query(`SELECT c.source_kind,c.observation_id FROM mdf_shadow_commands c
      JOIN mdf_evidence_revisions r USING(source_kind,source_id,revision_key) WHERE r.request_id LIKE 'concurrent-%'`)).rows;
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(r => r.observation_id)).size).toBe(4);
  });
  it.each(['missing', 'request_id', 'entity_type', 'entity_id', 'event', 'user_id', 'status_code'] as const)
  ('rejects %s audit provenance and rolls back source, receipt, journal and observation', async field => {
    const key = `bad-audit-${field}`, auditId = randomUUID();
    const before = (await client.query('SELECT program_name FROM cnc_telegram_packets')).rows[0].program_name;
    await expect(database.transaction(async tx => {
      await tx.query(`SET LOCAL search_path=${schema},public`);
      await tx.query("UPDATE cnc_telegram_packets SET program_name='E2E-bad-audit'");
      const intent = { kind: 'manual_move' as const, targetColumn: 'completed', auditId };
      if (field === 'missing') await observeCommand(tx, event(key), intent);
      else {
        await observeMdfShadowCommand(tx, event(key), intent);
        // Owned CTAS audit fixture, no production trigger or audit alteration.
        const value = field === 'user_id' ? '2' : 'wrong';
        await tx.query(`UPDATE audit_log SET ${field}=$2 WHERE audit_id=$1`, [auditId, value]);
      }
    })).rejects.toThrow('MDF_SHADOW_AUDIT_MISMATCH');
    expect(await observation(key)).toHaveLength(0);
    expect((await client.query('SELECT 1 FROM mdf_shadow_commands WHERE audit_event_id=$1', [auditId])).rows).toHaveLength(0);
    expect((await client.query('SELECT 1 FROM mdf_evidence_revisions WHERE request_id=$1', [key])).rows).toHaveLength(0);
    expect((await client.query('SELECT program_name FROM cnc_telegram_packets')).rows[0].program_name).toBe(before);
  });
  it.each(['status_id', 'metadata_json'] as const)('rejects return audit with mismatched %s', async field => {
    const key = `bad-return-${field}`, auditId = randomUUID();
    await expect(database.transaction(async tx => {
      await tx.query(`SET LOCAL search_path=${schema},public`);
      await observeMdfShadowCommand(tx, event(key), { kind: 'production_return', targetColumn: 'completed',
        targetStageId: 4, targetStageCode: 'sanded', previewDigest: 'a'.repeat(64), auditId });
      await tx.query(`UPDATE audit_log SET ${field}=$2 WHERE audit_id=$1`, [auditId, field === 'status_id' ? '5' : '{}']);
    })).rejects.toThrow('MDF_SHADOW_AUDIT_MISMATCH');
    expect(await observation(key)).toHaveLength(0);
  });
});
