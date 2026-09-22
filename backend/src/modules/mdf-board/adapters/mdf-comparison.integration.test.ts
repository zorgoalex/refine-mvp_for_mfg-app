import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { PerformanceQueryTelemetryService } from '../../../performance/performance-query-telemetry.service';
import { dispatchMdfBoardEvent } from '../../status-automation/application/status-automation-runtime';
import { MdfShadowComparisonService } from '../application/mdf-shadow-comparison.service';
import { loadMdfComparisonSnapshot } from './mdf-comparison-snapshot';
import { observeMdfShadowCommand } from '../application/mdf-shadow';
import type { MdfShadowCommand } from '../application/mdf-shadow-command';
import { compareMdfShadow } from '../domain/mdf-shadow-comparison';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('MDF actual event → snapshot comparison (PostgreSQL)', () => {
  const schema = `e2e_mdf_compare_${randomUUID().replaceAll('-', '')}`, packetId = randomUUID();
  const host = process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1';
  const client = new Client({ host, database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000, options: '-c statement_timeout=10000 -c lock_timeout=1000 -c max_parallel_workers_per_gather=0 -c jit=off' });
  let database: DatabaseService;
  const source = { kind: 'packet' as const, id: packetId };
  const send = (key: string) => database.transaction(tx => dispatchMdfBoardEvent(tx, { source,
    actor: { id: '1', username: 'e2e', role: 'admin', roleId: 1, permissions: [] }, requestId: key, sourceIdempotencyKey: key }));
  const report = async () => (await client.query('SELECT report FROM mdf_shadow_comparisons ORDER BY created_at DESC')).rows[0]?.report;
  const business = async () => (await client.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY detail_id) FROM order_details d) details,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY order_id) FROM orders o) orders,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY packet_id) FROM cnc_telegram_packets p) packets,
    (SELECT jsonb_agg(to_jsonb(h) ORDER BY source_id) FROM mdf_source_heads h) heads,
    (SELECT jsonb_agg(to_jsonb(j) ORDER BY job_id) FROM mdf_recalculation_jobs j) jobs,
    (SELECT count(*) FROM mdf_bath_allocations) allocations,
    (SELECT count(*) FROM mdf_board_manual_moves) moves,
    (SELECT published_revision FROM mdf_engine_state) published`)).rows[0];
  beforeAll(async () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE', 'true'); vi.stubEnv('BACKEND_MDF_SHADOW_COMPARE', 'true');
    vi.stubEnv('BACKEND_ENABLE_STATUS_AUTOMATION', 'false');
    await client.connect(); await client.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql', '167_mdf_shadow_observations.sql', '169_mdf_shadow_comparison.sql', '171_mdf_shadow_commands.sql']) {
      await client.query(readFileSync(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    for (const table of ['orders','order_details','production_statuses','order_statuses','cnc_telegram_packets','cnc_telegram_packet_items',
      'cnc_telegram_packet_whole_order_keys','mdf_board_manual_moves','status_automation_rules','bazis_cut_sets','bazis_cut_set_details',
      'cut_result','cut_result_board_projection','cut_result_placement','cut_result_sheet_map','sheet_material_types','materials',
      'cut_job','cut_group','cut_group_sheet','cut_result_archive_state','cut_result_label_map_projection','app_settings','outbox_events',
      'order_workshops','users','audit_log']) {
      await client.query(`CREATE TABLE ${schema}.${table} AS SELECT * FROM public.${table} WITH NO DATA`);
    }
    await client.query(`ALTER TABLE cut_result_placement ADD COLUMN IF NOT EXISTS order_hdf_detail_id bigint;
      INSERT INTO orders(order_id,order_name,delete_flag,order_kind,version) VALUES(1,'E2E-shadow-order',false,'production_order',1);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order)
        VALUES(2,'cut','Распилен',2),(3,'laminated','Закатан',3),(4,'packed','Упакован',4),(5,'issued','Выдан',5);
      INSERT INTO sheet_material_types(sheet_material_type_id,name) VALUES(1,'МДФ 10мм');
      INSERT INTO order_details(detail_id,order_id,detail_number,quantity,delete_flag,sheet_material_type_id,production_status_id)
        VALUES(11,1,1,10,false,1,2)`);
    await client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_version,updated_at,created_at,source_created_at,
      source_chat_id,workday,material_name,program_name,comments_json,completion_status,thumbs_up,rework,mdf_completion_returned,mdf_board_card_kind)
      VALUES($1,'E2E-shadow-packet',1,now(),now(),now(),'e2e',current_date,'МДФ 10мм','e2e-mdf','[]','completed',true,false,false,'machine_file')`, [packetId]);
    await client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,order_name,detail_number,
      match_order_id,match_detail_id,match_status,quantity) VALUES($1,$2,'a','E2E-shadow-order',1,1,11,'matched',5)`, [randomUUID(), packetId]);
    const url = new URL(`postgresql://${host}/${process.env.PG_DB}`);
    url.username = process.env.PG_USER ?? ''; url.password = process.env.PG_PASSWORD ?? '';
    url.searchParams.set('options', `-c search_path=${schema},public -c max_parallel_workers_per_gather=0 -c jit=off -c lock_timeout=1000`);
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 10000,
      DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 1, DATABASE_SSL: false };
    database = new DatabaseService({ get: (k: keyof BackendEnv) => values[k] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService);
  }, 30_000);
  afterAll(async () => {
    vi.unstubAllEnvs(); await database?.onModuleDestroy();
    try {
      await client.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
    } finally { await client.end(); }
  });
  it('runs both real loaders, persists differences and leaves all business state unchanged', async () => {
    await send('first'); const before = await business();
    await client.query(`INSERT INTO mdf_shadow_comparisons
      (source_kind,source_id,revision_key,algorithm_version,status,snapshot_at,duration_ms,report)
      SELECT source_kind,source_id,revision_key,'source-scope-v1','blocked',now(),0,
        '{"legacyMarker":true,"cutoverReady":false,"surface":"legacy-server-return-model"}'::jsonb
      FROM mdf_shadow_observations`);
    await new MdfShadowComparisonService(database).runTick();
    const result = await report();
    expect(result).toMatchObject({ algorithmVersion: 'source-scope-v3', cutoverReady: false,
      comparableDifferenceCount: 0, unverifiedDifferenceCount: 0,
      surface: 'legacy-server-return-model', ownerCount: 1, sourceCount: 1 });
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({ legacy: { cut: 5, remaining: 5 }, candidate: { cut: 5, remaining: 5 } });
    expect(result.columns[0]).toMatchObject({ legacy: 'completed', candidate: 'completed' });
    expect(await business()).toEqual(before);
    await new MdfShadowComparisonService(database).runTick();
    expect((await client.query('SELECT count(*) n FROM mdf_shadow_comparisons')).rows[0].n).toBe('2');
    expect((await client.query("SELECT report FROM mdf_shadow_comparisons WHERE algorithm_version='source-scope-v1'")).rows[0].report)
      .toEqual({ legacyMarker: true, cutoverReady: false, surface: 'legacy-server-return-model' });
    await expect(client.query("UPDATE mdf_shadow_comparisons SET status='blocked'")).rejects.toMatchObject({ code: '55000' });
  });
  it('keeps one repeatable snapshot when demand changes between old/new reads', async () => {
    await send('concurrent');
    const loader: typeof loadMdfComparisonSnapshot = async (db, trigger) => {
      expect((await db.query('SELECT quantity FROM order_details')).rows[0].quantity).toBe(10);
      await client.query('UPDATE order_details SET quantity=12 WHERE detail_id=11');
      return loadMdfComparisonSnapshot(db, trigger);
    };
    await new MdfShadowComparisonService(database, loader).runTick();
    expect((await report()).positions[0].quantity).toBe(10);
    expect((await client.query('SELECT quantity FROM order_details')).rows[0].quantity).toBe(12);
  });
  it('reports a real manual-BASIS provenance difference without changing it', async () => {
    await client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at) VALUES(1,'E2E-BASIS',1,now(),now());
      INSERT INTO bazis_cut_set_details(bazis_cut_set_id,bazis_cut_set_detail_id,source_order_id,source_order_detail_id,
        source_order_name,material_name,cut_enabled,quantity,updated_at) VALUES(1,1,1,11,'E2E-shadow-order','MDF 16',true,3,now());
      INSERT INTO mdf_board_manual_moves(move_id,card_kind,card_id,target_column,version,updated_at) VALUES(1,'bazisCutSet','1','completed',1,now())`);
    await send('basis'); const before = await business();
    await new MdfShadowComparisonService(database).runTick();
    const result = await report();
    expect(result).toMatchObject({ status: 'blocked', comparableDifferenceCount: 0, unverifiedDifferenceCount: 1 });
    expect(result.positions[0]).toMatchObject({ legacy: { cut: 8 }, candidate: { cut: 5 } });
    expect(result.positions[0].comparable).toBe(false);
    expect(result.orders[0].comparable).toBe(false);
    expect(result.issues).toContain('MANUAL_FACT_PROVENANCE_UNKNOWN');
    expect(await business()).toEqual(before);
  });
  it('resolves CNC and BASIS from their own packed members, ignoring another unfinished order position', async () => {
    await client.query(`UPDATE order_details SET production_status_id=4 WHERE detail_id=11;
      INSERT INTO order_details(detail_id,order_id,detail_number,quantity,delete_flag,sheet_material_type_id)
        VALUES(12,1,2,3,false,1)`);
    await send('own-packed'); const before = await business();
    await new MdfShadowComparisonService(database).runTick();
    const result = await report();
    expect(result.columns).toHaveLength(2);
    expect(result.columns.every((c: { candidate: string }) => c.candidate === 'completed_laminated')).toBe(true);
    expect(result.positions.find((p: { detailId: number }) => p.detailId === 12))
      .toMatchObject({ candidate: { cut: 0, remaining: 3 } });
    expect(await business()).toEqual(before);
  });
  it('consumes audited journal through the real RR loader: split, dedup, clear and scoped return', async () => {
    await client.query('UPDATE order_details SET production_status_id=2 WHERE detail_id=11');
    const observe = async (kind: 'packet' | 'bazisCutSet', intent: Omit<MdfShadowCommand, 'auditId'>) => {
      const auditId = randomUUID(), requestId = `E2E-proof-${auditId}`, id = kind === 'packet' ? packetId : '1';
      const command: MdfShadowCommand = intent.kind === 'production_return'
        ? { ...intent, targetColumn: intent.targetColumn!, auditId, targetStageId: 1, targetStageCode: 'drawn', previewDigest: 'a'.repeat(64) }
        : intent.kind === 'manual_clear' ? { kind: 'manual_clear', targetColumn: null, auditId }
          : { kind: 'manual_move', targetColumn: intent.targetColumn!, auditId };
      await database.transaction(async tx => {
        await tx.query(`INSERT INTO audit_log(audit_id,event,entity_type,entity_id,user_id,request_id,status_code,status_id,metadata_json)
          VALUES($1,$2,$3,$4,1,$5,$6,$7,$8::jsonb)`, [auditId,
          command.kind === 'production_return' ? 'mdf_board.production_returned'
            : command.kind === 'manual_clear' ? 'mdf_board.manual_move.deleted' : 'mdf_board.manual_move.created',
          command.kind === 'production_return' ? 'mdf_board_card' : 'mdf_board_manual_move', `${kind}:${id}`, requestId,
          command.targetColumn, command.kind === 'production_return' ? command.targetStageId : null,
          JSON.stringify(command.kind === 'production_return' ? { previewDigest: command.previewDigest } : {})]);
        await observeMdfShadowCommand(tx, { source: { kind, id }, actor: { id: '1', username: 'e2e', role: 'admin', roleId: 1, permissions: [] },
          requestId, sourceIdempotencyKey: requestId }, command);
      });
      return auditId;
    };
    const calculate = () => database.transaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return compareMdfShadow((await loadMdfComparisonSnapshot(tx, source)).input);
    });
    await observe('packet', { kind: 'manual_move', targetColumn: 'completed' });
    const basisAudit = await observe('bazisCutSet', { kind: 'manual_move', targetColumn: 'completed' });
    const before = await business();
    let result = await calculate();
    expect(result.positions.find(p => p.detailId === 11)?.candidate.cut).toBe(8);
    expect(result.proofs.every(p => p.cut && !p.issues.length)).toBe(true);
    expect(await business()).toEqual(before);
    await client.query("DELETE FROM mdf_board_manual_moves WHERE card_kind='bazisCutSet'");
    await observe('bazisCutSet', { kind: 'manual_clear', targetColumn: null });
    expect((await calculate()).positions.find(p => p.detailId === 11)?.candidate.cut).toBe(8);
    await observe('bazisCutSet', { kind: 'production_return', targetColumn: 'parsed' });
    expect((await calculate()).positions.find(p => p.detailId === 11)?.candidate.cut).toBe(5);
    await observe('bazisCutSet', { kind: 'manual_move', targetColumn: 'completed' });
    await observe('bazisCutSet', { kind: 'manual_move', targetColumn: 'completed' });
    expect((await calculate()).positions.find(p => p.detailId === 11)?.candidate.cut).toBe(8);
    await client.query('UPDATE bazis_cut_set_details SET quantity=4 WHERE bazis_cut_set_id=1');
    result = await calculate();
    expect(result.positions.find(p => p.detailId === 11)).toMatchObject({ comparable: false, candidate: { cut: 5 } });
    expect(result.issues).toContain('COMMAND_COMPOSITION_CHANGED');
    await client.query('UPDATE bazis_cut_set_details SET quantity=3 WHERE bazis_cut_set_id=1');
    await client.query("UPDATE audit_log SET request_id='E2E-invalid' WHERE audit_id=$1", [basisAudit]);
    expect((await calculate()).issues).toContain('COMMAND_PROVENANCE_INVALID');
    await client.query(`INSERT INTO orders(order_id,order_name,delete_flag,order_kind,version) VALUES(2,'E2E-new-owner',false,'production_order',1);
      INSERT INTO order_details(detail_id,order_id,detail_number,quantity,delete_flag,sheet_material_type_id,production_status_id)
        VALUES(21,2,1,3,false,1,2);
      UPDATE bazis_cut_set_details SET source_order_id=2,source_order_detail_id=21 WHERE bazis_cut_set_id=1`);
    result = await calculate();
    expect(result.orders.map(o => o.orderId)).toEqual([1,2]);
    expect(result.proofs.some(p => p.kind === 'bazisCutSet')).toBe(true);
    expect(result.orders.every(o => !o.comparable)).toBe(true);
  });
});
