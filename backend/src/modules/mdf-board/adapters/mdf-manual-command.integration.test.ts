import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { PerformanceQueryTelemetryService } from '../../../performance/performance-query-telemetry.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import { PgMdfBoardManualMoveRepository } from '../../orders/adapters/pg-mdf-board-manual-move-repository';
import { recordMdfReceipt } from '../application/mdf-receipt';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { readMdfPublishedSnapshot } from './mdf-published-snapshot';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('real MDF manual command → queue → publication', () => {
  const schema = `e2e_mdf_manual_${randomUUID().replaceAll('-','')}`;
  const config = { host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB,user: process.env.PG_USER,password: process.env.PG_PASSWORD,connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c lock_timeout=3000 -c max_parallel_workers_per_gather=0 -c jit=off' };
  const db = new Client(config);
  let database: DatabaseService, repo: PgMdfBoardManualMoveRepository, sequence = 0;
  const admin: CurrentUser = { id: '1',username: 'E2E MDF manual',role: 'admin',roleId: 1,
    permissions: ['orders.view','orders.update','production.tasks.update','orders.change_production_status'] };
  const runner = () => new MdfJobRunner(database,executeMdfAcceptedJob);
  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE','false');
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE','true'); // Active route must not run legacy shadow finalizer.
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql']) {
      await db.query(readFileSync(new URL(`../../../../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    for (const table of ['orders','order_details','production_statuses','order_statuses','materials','sheet_material_types',
      'users','status_automation_rules','outbox_events','audit_log','audit_log_related_entity','app_settings',
      'bazis_order_links','order_import_entity_map','order_workshops','bazis_cut_sets','bazis_cut_set_details',
      'cnc_telegram_packets','cnc_telegram_packet_items','cnc_telegram_packet_whole_order_keys','mdf_board_manual_moves',
      'cut_result','cut_result_board_projection','cut_result_placement','cut_result_sheet_map']) {
      await db.query(`CREATE TABLE ${table} AS TABLE public.${table} WITH NO DATA`);
    }
    await db.query(`ALTER TABLE cut_result_placement ADD COLUMN IF NOT EXISTS order_hdf_detail_id bigint;
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_outbox ON outbox_events(idempotency_key);
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES(1,'E2E MDF manual',1,true);
      INSERT INTO materials(material_id,material_name) VALUES(1,'MDF 10 mm');
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',1,true),(2,'cut','Распилен',20,true),(3,'laminated','Закатан',30,true),
          (4,'packed','Упакован',40,true),(5,'issued','Выдан',50,true);
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES(17,'E2E scoped cut','mdf.board.completed','change_details_production_status',2,'{}',100,true,1,'{}'),
        (18,'E2E scoped lamination','mdf.board.baths_laminated','change_details_production_status',3,'{}',100,true,1,'{}')`);
    for (const signature of ['order_production_summary(bigint,bigint[])','recalc_order_production_status(bigint)']) {
      const definition = (await db.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) definition',
        [`public.${signature}`])).rows[0].definition;
      expect(definition).not.toMatch(/(?:FROM|UPDATE|JOIN)\s+public\./i);
      await db.query(definition.replace('FUNCTION public.',`FUNCTION ${schema}.`));
    }
    const url = new URL('postgresql://localhost'); url.hostname = config.host;
    url.pathname = `/${config.database}`; url.username = config.user ?? ''; url.password = config.password ?? '';
    url.searchParams.set('options',`-c search_path=${schema},public -c lock_timeout=3000 -c jit=off -c max_parallel_workers_per_gather=0`);
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(),DATABASE_QUERY_TIMEOUT_MS: 15000,
      DATABASE_POOL_MIN: 0,DATABASE_POOL_MAX: 2,DATABASE_SSL: false };
    database = new DatabaseService({ get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv,true>,
      { measure: <T>(_sql: string, operation: () => Promise<T>) => operation() } as PerformanceQueryTelemetryService);
    repo = new PgMdfBoardManualMoveRepository(database);
  });
  afterAll(async () => {
    vi.unstubAllEnvs(); await database?.onModuleDestroy();
    try { await db.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows).toHaveLength(0);
    } finally { await db.end(); }
  });
  async function fixture(kind: 'packet'|'bazisCutSet'|'bath' = 'bazisCutSet') {
    const orderId = ++sequence,detailId = orderId*10;
    const source = { kind,id: kind === 'packet' ? randomUUID() : kind === 'bath' ? `cut-result:${orderId}` : String(orderId) };
    await db.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,'production_order',false,1,4,1,1)`,[orderId,`E2E manual ${orderId}`]);
    await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
      VALUES($1,$2,1,4,1,false,1),($3,$2,2,1,1,false,1)`,[detailId,orderId,detailId+1]);
    if (kind === 'bazisCutSet') {
      await db.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at) VALUES($1,'E2E source',1,now(),now())`,[orderId]);
      await db.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,source_order_id,source_order_detail_id,quantity,cut_enabled,material_name)
        VALUES($1,$1,$1,$2,4,true,'MDF 10 mm')`,[orderId,detailId]);
    } else if (kind === 'packet') {
      await db.query(`INSERT INTO cnc_telegram_packets(packet_id,material_name,comments_json,mdf_board_card_kind,rework,completion_status,thumbs_up)
        VALUES($1,'MDF 10 mm','[]','machine_file',false,'pending',false)`,[source.id]);
      await db.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,match_detail_id,match_status,quantity)
        VALUES($1,$2,'own-part',$3,$4,'matched',4)`,[randomUUID(),source.id,orderId,detailId]);
    } else {
      await db.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest) VALUES($1,now(),repeat('a',64))`,[orderId]);
      await db.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum) VALUES($1,repeat('a',64),true)`,[orderId]);
      await db.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective) VALUES($1,$1,true)`,[orderId]);
      await db.query(`INSERT INTO cut_result_placement(cut_result_sheet_map_id,cut_result_id,order_id,order_detail_id)
        SELECT $1,$1,$1,$2 FROM generate_series(1,4)`,[orderId,detailId]);
    }
    await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: kind,sourceId: source.id,revisionKey: 'baseline',
      origin: 'derived',actorUserId: 1,requestId: 'E2E-baseline',causeKey: `baseline-${orderId}`,expectedFence: null,
      accept: true,rules: [],lines: [{ lineKey: 'own-part',orderId,detailId,quantity: 4,
        stageCode: 'membership',evidenceKind: 'derived',rework: false }],
      executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: `E2E ${kind}`,
        priorColumn: kind === 'bath' ? 'baths' : 'parsed',compositionComplete: true,
        demand: [{ orderId,detailId,quantity: 4 },{ orderId,detailId: detailId+1,quantity: 1 }] } }));
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    const token = async () => {
      const head = (await db.query<{ received: string; version: string; epoch: string }>(`SELECT received_revision_key received,
        version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`,[kind,source.id])).rows[0];
      return mdfSourceCommandToken(source,head);
    };
    const command = async () => ({ currentUser: admin,cardKind: kind,cardId: source.id,sourceToken: await token(),
      idempotencyKey: randomUUID(),requestId: `E2E-manual-${orderId}` });
    return { source,orderId,detailId,token,command };
  }
  const ledger = async (source: { kind: string; id: string }) => (await db.query(`SELECT l.stage_code,l.quantity FROM mdf_evidence_lines l
    JOIN mdf_source_heads h ON h.source_kind=l.source_kind AND h.source_id=l.source_id AND h.received_revision_key=l.revision_key
    WHERE l.source_kind=$1 AND l.source_id=$2 ORDER BY l.stage_code,l.line_key`,[source.kind,source.id])).rows;
  const audits = async (id: string) => (await db.query("SELECT * FROM audit_log WHERE entity_id=$1 AND event LIKE 'mdf_board.manual_move.%'",[id])).rows;

  it.each(['packet','bazisCutSet'] as const)('moves real %s through queue; only its own detail changes', async kind => {
    const f = await fixture(kind);
    const result = await repo.upsert({ ...await f.command(),targetColumn: 'completed' });
    expect(result).toMatchObject({ changed: true,jobId: expect.any(String),auditId: expect.any(String) });
    expect((await db.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0].production_status_id).toBe(1);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: result.jobId });
    expect((await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[f.orderId])).rows)
      .toEqual([{ production_status_id: 2 },{ production_status_id: 1 }]);
    expect(await ledger(f.source)).toEqual([{ stage_code: 'cut',quantity: '4' },{ stage_code: 'membership',quantity: '4' }]);
    expect((await db.query('SELECT 1 FROM mdf_board_manual_moves')).rows).toHaveLength(0);
    const board = await readMdfPublishedSnapshot(database,admin,{ dateTo: '2026-09-21' });
    expect(board.cards.find(c => c.kind === kind && c.id === f.source.id)?.commandToken).toBe(await f.token());
  });
  it('clear keeps confirmed quantity and never calls legacy automation', async () => {
    const f = await fixture(); await repo.upsert({ ...await f.command(),targetColumn: 'completed' }); await runner().processOne();
    const before = await ledger(f.source);
    const cleared = await repo.delete(await f.command());
    expect(cleared.deleted).toBe(true); expect(await runner().processOne()).toMatchObject({ status: 'done' });
    expect(await ledger(f.source)).toEqual(before);
    expect((await db.query('SELECT credited_cut FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0].credited_cut).toBe('4');
  });
  it('explicit bath lamination consumes verified cut supply and changes only its own detail', async () => {
    const f = await fixture('bath');
    await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: 'packet',sourceId: randomUUID(),revisionKey: 'cut',
      origin: 'cnc',actorUserId: 1,requestId: 'E2E cut supply',causeKey: 'E2E cut supply',expectedFence: null,accept: true,rules: [],
      lines: [{ lineKey: 'member',orderId: f.orderId,detailId: f.detailId,quantity: 4,stageCode: 'membership',evidenceKind: 'derived',rework: false },
        { lineKey: 'proof',orderId: f.orderId,detailId: f.detailId,quantity: 4,stageCode: 'cut',evidenceKind: 'physical',rework: false }],
      executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: 'physical supply',priorColumn: 'parsed',compositionComplete: true,
        demand: [{ orderId: f.orderId,detailId: f.detailId,quantity: 4 },{ orderId: f.orderId,detailId: f.detailId+1,quantity: 1 }] } }));
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    await repo.upsert({ ...await f.command(),targetColumn: 'baths_laminated' });
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    expect((await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[f.orderId])).rows)
      .toEqual([{ production_status_id: 3 },{ production_status_id: 1 }]);
    expect((await db.query("SELECT state,quantity FROM mdf_bath_allocations WHERE bath_id=$1 AND state<>'released'",[f.source.id])).rows)
      .toEqual([{ state: 'consumed',quantity: '4' }]);
    expect((await db.query('SELECT credited_rolled FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0].credited_rolled).toBe('4');
  });
  it.each(['packet','bazisCutSet','bath'] as const)('terminal placement for %s creates no physical proof', async kind => {
    const f = await fixture(kind);
    await repo.upsert({ ...await f.command(),targetColumn: kind === 'bath' ? 'completed_baths' : 'completed_laminated' });
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    expect(await ledger(f.source)).toEqual([{ stage_code: 'membership',quantity: '4' }]);
    expect((await db.query('SELECT credited_cut,credited_rolled FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({ credited_cut: '0',credited_rolled: '0' });
  });
  it('two clients using the same card token cannot both commit', async () => {
    const f = await fixture(), command = { ...await f.command(),targetColumn: 'completed' as const };
    const results = await Promise.allSettled([repo.upsert(command),repo.upsert({ ...command,idempotencyKey: randomUUID() })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'MDF_SOURCE_STALE' } });
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(1);
    await runner().processOne();
  });
  it('missing/stale token blocks both write and clear before any receipt or audit', async () => {
    const f = await fixture(), command = await f.command();
    await expect(repo.upsert({ ...command,sourceToken: undefined,targetColumn: 'completed' })).rejects.toMatchObject({ code: 'MDF_SOURCE_TOKEN_REQUIRED' });
    await expect(repo.delete({ ...command,sourceToken: undefined })).rejects.toMatchObject({ code: 'MDF_SOURCE_TOKEN_REQUIRED' });
    await expect(repo.delete({ ...command,sourceToken: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'MDF_SOURCE_STALE' });
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(0);
    expect((await db.query('SELECT version FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',[f.source.kind,f.source.id])).rows[0].version).toBe('1');
  });
  it('replays exact response after source advances; altered payload with same key conflicts', async () => {
    const f = await fixture(), command = { ...await f.command(),targetColumn: 'completed' as const };
    const first = await repo.upsert(command);
    expect(await repo.upsert(command)).toEqual(first);
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(1);
    await expect(repo.upsert({ ...command,targetColumn: 'completed_laminated' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await runner().processOne();
    expect(await repo.upsert(command)).toEqual(first);
  });
  it.each(['demand','membership'] as const)('changed %s requires reconciliation', async what => {
    const f = await fixture();
    await db.query(what === 'demand' ? 'UPDATE order_details SET quantity=5 WHERE detail_id=$1'
      : 'UPDATE bazis_cut_set_details SET quantity=5 WHERE source_order_detail_id=$1',[f.detailId]);
    await expect(repo.upsert({ ...await f.command(),targetColumn: 'completed' })).rejects.toMatchObject({ code: 'MDF_COMMAND_RECONCILIATION_REQUIRED' });
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(0);
  });
  it('owner scope is enforced even with production.tasks.update', async () => {
    const f = await fixture();
    const user: CurrentUser = { ...admin,id: '999',role: 'manager',roleId: 2 };
    await expect(repo.upsert({ ...await f.command(),currentUser: user,targetColumn: 'completed' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(0);
  });
  it('mixed card requires access to every owner, not only the first', async () => {
    const f = await fixture(), other = await fixture();
    await db.query('UPDATE orders SET created_by=999 WHERE order_id=$1',[f.orderId]);
    await db.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,source_order_id,source_order_detail_id,quantity,cut_enabled,material_name)
      VALUES($1,$2,$3,$4,4,true,'MDF 18 mm')`,[10000+f.orderId,f.orderId,other.orderId,other.detailId]);
    await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: f.source.kind,sourceId: f.source.id,
      revisionKey: 'mixed',origin: 'derived',actorUserId: 1,requestId: 'E2E mixed',causeKey: 'E2E mixed',
      expectedFence: { version: '1',correctionEpoch: '0' },accept: true,rules: [],
      lines: [f,other].map(v => ({ lineKey: String(v.detailId),orderId: v.orderId,detailId: v.detailId,quantity: 4,
        stageCode: 'membership',evidenceKind: 'derived' as const,rework: false })),
      executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: 'mixed',priorColumn: 'parsed',compositionComplete: true,
        demand: [f,other].flatMap(v => [{ orderId: v.orderId,detailId: v.detailId,quantity: 4 },
          { orderId: v.orderId,detailId: v.detailId+1,quantity: 1 }]) } }));
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    const base = rolePolicyForUser(admin);
    const restricted: CurrentUser = { ...admin,id: '999',policyScopes: { ...base,
      orders: { ...base.orders,view: 'own',update: 'own' },productionTasks: { ...base.productionTasks,update: 'own' } } };
    await expect(repo.upsert({ ...await f.command(),currentUser: restricted,targetColumn: 'completed' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(0);
  });
  it('unverified unrelated source on the same order does not block this confirmed composition', async () => {
    const f = await fixture();
    await database.transaction(tx => recordMdfReceipt(tx,{ sourceKind: 'packet',sourceId: randomUUID(),revisionKey: 'unknown',
      origin: 'legacy',actorUserId: 1,requestId: 'E2E unknown',causeKey: 'E2E unknown',expectedFence: null,
      accept: false,rules: [],lines: [{ lineKey: 'unknown',orderId: f.orderId,detailId: f.detailId+1,
        quantity: 1,stageCode: 'membership',evidenceKind: 'derived',rework: false }],
      executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: 'requires verification',priorColumn: 'parsed',
        compositionComplete: false,demand: [{ orderId: f.orderId,detailId: f.detailId,quantity: 4 },
          { orderId: f.orderId,detailId: f.detailId+1,quantity: 1 }] } }));
    const result = await repo.upsert({ ...await f.command(),targetColumn: 'completed' });
    expect(result.changed).toBe(true);
    await runner().processOne(); await runner().processOne();
    expect((await db.query('SELECT credited_cut FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0].credited_cut).toBe('4');
  });
  it('receipt failure rolls back earlier audit and leaves no job or placement', async () => {
    const f = await fixture();
    await db.query("ALTER TABLE mdf_evidence_revisions ADD CONSTRAINT e2e_manual_failure CHECK(request_id<>'E2E-reject-receipt')");
    try {
      await expect(repo.upsert({ ...await f.command(),targetColumn: 'completed',requestId: 'E2E-reject-receipt' }))
        .rejects.toMatchObject({ code: '23514' });
      expect(await audits(`${f.source.kind}:${f.source.id}`)).toHaveLength(0);
      expect((await db.query('SELECT version FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',[f.source.kind,f.source.id])).rows[0].version).toBe('1');
      expect((await db.query('SELECT 1 FROM mdf_recalculation_jobs WHERE request_id=$1',['E2E-reject-receipt'])).rows).toHaveLength(0);
    } finally { await db.query('ALTER TABLE mdf_evidence_revisions DROP CONSTRAINT e2e_manual_failure'); }
  });
});
