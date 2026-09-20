import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import { beforeTransactionCommit } from '../../../database/transaction-hooks';
import type { PerformanceQueryTelemetryService } from '../../../performance/performance-query-telemetry.service';
import { dispatchMdfBoardEvent } from '../../status-automation/application/status-automation-runtime';
import type { MdfBoardEventInput, MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';

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
    for (const file of ['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql', '167_mdf_shadow_observations.sql']) {
      await client.query(readFileSync(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    // Actual deployed column types; isolated owned schema, no operational writes.
    for (const table of ['orders', 'order_details', 'cnc_telegram_packets', 'cnc_telegram_packet_items',
      'cnc_telegram_packet_whole_order_keys', 'mdf_board_manual_moves', 'status_automation_rules',
      'bazis_cut_sets', 'bazis_cut_set_details', 'cut_result', 'cut_result_board_projection',
      'cut_result_placement', 'cut_result_sheet_map', 'sheet_material_types', 'materials']) {
      await client.query(`CREATE TABLE ${schema}.${table} AS SELECT * FROM public.${table} WITH NO DATA`);
    }
    await client.query(`INSERT INTO orders(order_id,delete_flag) VALUES(1,false),(2,false);
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
      DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 1, DATABASE_SSL: false };
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
});
