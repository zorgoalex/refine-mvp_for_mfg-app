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
import { PgBazisCutRepository } from '../../bazis-cut/adapters/pg-bazis-cut-repository';
import { PgBazisCutPicker } from '../../bazis-cut/adapters/pg-bazis-cut-picker';
import { PgMdfBoardManualMoveRepository } from '../../orders/adapters/pg-mdf-board-manual-move-repository';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { readMdfPublishedSnapshot } from './mdf-published-snapshot';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('real BASIS creation → MDF queue → publication', () => {
  const schema = `e2e_mdf_bazis_${randomUUID().replaceAll('-','')}`;
  const connection = { host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB,user: process.env.PG_USER,password: process.env.PG_PASSWORD,connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c lock_timeout=3000 -c max_parallel_workers_per_gather=0 -c jit=off' };
  const db = new Client(connection);
  let database: DatabaseService, repository: PgBazisCutRepository, sequence = 0;
  let onQuery: ((sql: string) => void) | undefined;
  const user: CurrentUser = { id: '1',username: 'E2E BASIS source',role: 'admin',roleId: 1,
    permissions: ['cut.view','cut.manage','orders.view'] };
  const runner = () => new MdfJobRunner(database,executeMdfAcceptedJob);
  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true'); vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE','false');
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE','true'); vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH','true');
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql']) {
      await db.query(readFileSync(new URL(`../../../../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    for (const table of ['orders','order_details','production_statuses','order_statuses','materials','sheet_material_types',
      'users','status_automation_rules','outbox_events','audit_log','audit_log_related_entity','app_settings','order_workshops',
      'bazis_cut_sets','bazis_cut_set_details','command_idempotency_keys','projects','clients','milling_types','films',
      'bazis_node_order_detail_map','bazis_nodes','bazis_project_revisions','bazis_order_links','order_import_entity_map',
      'cut_job_item','cut_job','cut_result','cut_result_archive_state','cut_param_profiles','order_doweling_links',
      'doweling_orders','employees','order_hdf_details','hdf_calculation_config_state','mdf_board_manual_moves',
      'cnc_telegram_packets','cnc_telegram_packet_items','cnc_telegram_packet_whole_order_keys',
      'cut_result_board_projection','cut_result_placement','cut_result_sheet_map']) {
      await db.query(`CREATE TABLE ${table} AS TABLE public.${table} WITH NO DATA`);
    }
    await db.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await db.query(readFileSync(new URL('../../../../db/migrations/179_mdf_active_return.sql',import.meta.url),'utf8'));
    await db.query(`CREATE SEQUENCE e2e_set_seq OWNED BY bazis_cut_sets.bazis_cut_set_id;
      ALTER TABLE bazis_cut_sets ALTER COLUMN bazis_cut_set_id SET DEFAULT nextval('e2e_set_seq');
      ALTER TABLE bazis_cut_sets ALTER COLUMN version SET DEFAULT 0;
      ALTER TABLE bazis_cut_sets ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE bazis_cut_sets ALTER COLUMN updated_at SET DEFAULT now();
      CREATE SEQUENCE e2e_detail_seq OWNED BY bazis_cut_set_details.bazis_cut_set_detail_id;
      ALTER TABLE bazis_cut_set_details ALTER COLUMN bazis_cut_set_detail_id SET DEFAULT nextval('e2e_detail_seq');
      ALTER TABLE bazis_cut_set_details ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE bazis_cut_set_details ALTER COLUMN updated_at SET DEFAULT now();
      CREATE UNIQUE INDEX e2e_detail_source ON bazis_cut_set_details(bazis_cut_set_id,source_order_detail_id) WHERE source_order_detail_id IS NOT NULL;
      CREATE UNIQUE INDEX e2e_hdf_source ON bazis_cut_set_details(bazis_cut_set_id,source_order_hdf_detail_id) WHERE source_order_hdf_detail_id IS NOT NULL;
      CREATE UNIQUE INDEX e2e_command_key ON command_idempotency_keys(idempotency_key);
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_outbox ON outbox_events(idempotency_key);
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES(1,'E2E BASIS source',1,true);
      INSERT INTO projects(project_id,code) VALUES(1,'E2E');
      INSERT INTO sheet_material_types(sheet_material_type_id,name,thickness_mm,is_cuttable)
        VALUES(1,'МДФ 10 мм',10,true),(2,'MDF 18 mm',18,true),(3,'ХДФ',3,true),(4,'fanera',10,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',1,true),(2,'drawn','Отрисован',10,true),(3,'cut','Распилен',20,true),
          (4,'laminated','Закатан',30,true),(5,'packed','Упакован',40,true),(6,'issued','Выдан',50,true);
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES(16,'E2E own file present','mdf.order_machine_files_present','change_details_production_status',2,'{}',100,true,1,'{}'),
          (17,'E2E own cut','mdf.board.completed','change_details_production_status',3,'{}',100,true,1,'{}');
      INSERT INTO hdf_calculation_config_state(id,revision) VALUES(1,1)`);
    for (const name of ['set_session_user','order_production_summary','recalc_order_production_status']) {
      const definitions = (await db.query<{ definition: string }>(`SELECT pg_get_functiondef(p.oid) definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`,[name])).rows;
      expect(definitions.length).toBeGreaterThan(0);
      for (const { definition } of definitions) {
        expect(definition).not.toMatch(/(?:FROM|UPDATE|JOIN|INTO)\s+public\./i);
        await db.query(definition.replace('FUNCTION public.',`FUNCTION ${schema}.`));
      }
    }
    const url = new URL('postgresql://localhost'); url.hostname = connection.host;
    url.pathname = `/${connection.database}`; url.username = connection.user ?? ''; url.password = connection.password ?? '';
    url.searchParams.set('options',`-c search_path=${schema},public -c lock_timeout=3000 -c jit=off -c max_parallel_workers_per_gather=0`);
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(),DATABASE_QUERY_TIMEOUT_MS: 15000,
      DATABASE_POOL_MIN: 0,DATABASE_POOL_MAX: 2,DATABASE_SSL: false };
    database = new DatabaseService({ get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv,true>,
      { measure: <T>(sql: string, operation: () => Promise<T>) => { onQuery?.(sql); return operation(); } } as PerformanceQueryTelemetryService);
    repository = new PgBazisCutRepository(database);
  });
  afterAll(async () => {
    vi.unstubAllEnvs(); await database?.onModuleDestroy();
    try { await db.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows).toHaveLength(0);
    } finally { await db.end(); }
  });
  async function fixture(material = 1) {
    const orderId = ++sequence,detailId = orderId*10;
    await db.query(`INSERT INTO orders(order_id,order_name,project_id,order_date,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,1,'2026-09-21','production_order',false,1,4,1,1)`,[orderId,`E2E BASIS ${orderId}`]);
    await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,detail_name,quantity,height,width,production_status_id,
      delete_flag,sheet_material_type_id,version,updated_at) VALUES($1,$2,1,'E2E own',4,500,300,1,false,$4,1,now()),
      ($3,$2,2,'E2E other',1,500,300,1,false,1,1,now())`,[detailId,orderId,detailId+1,material]);
    const command = () => ({ currentUser: user,orderId,detailIds: [detailId],idempotencyKey: `E2E-${randomUUID()}`,requestId: 'E2E BASIS create' });
    return { orderId,detailId,command };
  }
  async function pickerCommand(owners: { orderId: number; detailId: number }[]) {
    const criteria = { dateFrom: '2026-09-01',dateTo: '2026-09-30',orderIds: owners.map(o => o.orderId),
      clientIds: [],sheetMaterialTypeIds: [],millingTypeIds: [],bazisKeys: [],designEngineerIds: [],dowelingOrderIds: [],excludedDetailIds: [] };
    const selection = await new PgBazisCutPicker(database).search(user,criteria,1,100);
    return { currentUser: user,criteria,criteriaHash: selection.criteriaHash,idempotencyKey: `E2E-${randomUUID()}`,
      requestId: 'E2E mixed picker',details: selection.items.filter(d => owners.some(o => o.detailId === d.detailId))
        .map(d => ({ detailId: d.detailId,selectionToken: d.selectionToken })) };
  }
  const statuses = async (orderId: number) => (await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[orderId])).rows;
  const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM bazis_cut_sets) sets,
    (SELECT count(*) FROM mdf_evidence_revisions) receipts,(SELECT count(*) FROM mdf_recalculation_jobs) jobs,
    (SELECT count(*) FROM audit_log) audits,(SELECT count(*) FROM outbox_events) outbox,
    (SELECT count(*) FROM command_idempotency_keys) commands`)).rows[0];

  it.each([1,2])('creates verified membership for material %s, queues own details, never invents cut quantity', async material => {
    const f = await fixture(material),command = f.command();
    const result = await repository.create(command);
    expect(result.mdfJobId).toEqual(expect.any(String));
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 1 },{ production_status_id: 1 }]);
    const savedCounts = await counts(); expect(await repository.create(command)).toEqual(result); expect(await counts()).toEqual(savedCounts);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: result.mdfJobId });
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 2 },{ production_status_id: 1 }]);
    const sourceId = String(result.set.bazisCutSetId);
    expect((await db.query('SELECT stage_code,evidence_kind FROM mdf_evidence_lines WHERE source_id=$1',[sourceId])).rows)
      .toEqual([{ stage_code: 'membership',evidence_kind: 'derived' }]);
    const board = await readMdfPublishedSnapshot(database,user,{ focus: { kind: 'bazisCutSet',id: sourceId } });
    expect(board.cards.find(c => c.kind === 'bazisCutSet' && c.id === sourceId)).toMatchObject({ column: 'parsed',issues: [],
      acceptedRevision: `bazis-created:${sourceId}`,receivedRevision: `bazis-created:${sourceId}` });
    expect((await db.query('SELECT credited_cut,credited_rolled FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({ credited_cut: '0',credited_rolled: '0' });
    await expect(repository.create({ ...command,detailIds: [f.detailId+1] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('mixed picker freezes both full owner compositions and reauthorizes every owner on replay', async () => {
    const a = await fixture(),b = await fixture();
    const command = await pickerCommand([a,b]),result = await repository.createFromPicker(command);
    expect(result.set.positionCount).toBe(2); expect(result.mdfJobId).toEqual(expect.any(String));
    expect((await db.query('SELECT count(*) FROM mdf_revision_demand WHERE source_id=$1',[String(result.set.bazisCutSetId)])).rows[0].count).toBe('4');
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    for (const f of [a,b]) expect(await statuses(f.orderId)).toEqual([{ production_status_id: 2 },{ production_status_id: 1 }]);
    expect(await repository.createFromPicker(command)).toEqual(result);
    await db.query('UPDATE orders SET created_by=999 WHERE order_id=$1',[b.orderId]);
    const base = rolePolicyForUser(user),restricted = { ...user,policyScopes: { ...base,orders: { ...base.orders,view: 'own' as const } } };
    await expect(repository.createFromPicker({ ...command,currentUser: restricted })).rejects.toMatchObject({ code: 'BAZIS_CUT_PICKER_SELECTION_STALE' });
  });
  it('connects actual creation to manual cut confirmation without a manufactured baseline', async () => {
    const f = await fixture(),created = await repository.create(f.command()); await runner().processOne();
    const sourceId = String(created.set.bazisCutSetId);
    const board = await readMdfPublishedSnapshot(database,user,{ focus: { kind: 'bazisCutSet',id: sourceId } });
    const token = board.cards.find(c => c.kind === 'bazisCutSet' && c.id === sourceId)?.commandToken;
    expect(token).toEqual(expect.any(String));
    const result = await new PgMdfBoardManualMoveRepository(database).upsert({
      currentUser: { ...user,permissions: [...user.permissions,'orders.update','production.tasks.update','orders.change_production_status'] },
      cardKind: 'bazisCutSet',cardId: sourceId,targetColumn: 'completed',sourceToken: token!,
      idempotencyKey: `E2E-${randomUUID()}`,requestId: 'E2E cut actual created set' });
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: result.jobId });
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 3 },{ production_status_id: 1 }]);
    expect((await db.query('SELECT credited_cut,remaining FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({ credited_cut: '4',remaining: '0' });
  });
  it.each([3,4])('non-MDF material %s creates a normal set but no MDF source/job', async material => {
    const f = await fixture(material),before = await counts();
    const result = await repository.create(f.command()); expect(result.mdfJobId).toBeUndefined();
    const after = await counts(); expect(after.jobs).toBe(before.jobs); expect(after.receipts).toBe(before.receipts);
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 1 },{ production_status_id: 1 }]);
  });
  it('typed HDF is excluded even when its saved material name contains MDF', async () => {
    const f = await fixture();
    await db.query(`INSERT INTO order_hdf_details(order_hdf_detail_id,order_id,hdf_sheet_material_name,hdf_sheet_material_type_id,
      source_detail_number,source_detail_name,hdf_height_mm,hdf_width_mm,quantity,delete_flag,status,config_revision)
      VALUES($1,$1,'MDF 10 mm',1,1,'E2E HDF',500,300,4,false,'ok',1)`,[f.orderId]);
    const before = await counts();
    const result = await repository.create({ ...f.command(),detailIds: [],hdfDetailIds: [f.orderId] });
    expect(result.mdfJobId).toBeUndefined(); expect((await counts()).jobs).toBe(before.jobs);
  });
  it('receipt failure rolls back the source, domain audit/outbox and idempotency claim', async () => {
    const f = await fixture(),before = await counts();
    await db.query(`CREATE FUNCTION e2e_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'E2E receipt failure'; END $$;
      CREATE TRIGGER e2e_reject_receipt BEFORE INSERT ON mdf_evidence_revisions FOR EACH ROW EXECUTE FUNCTION e2e_reject_receipt()`);
    try { await expect(repository.create(f.command())).rejects.toThrow('E2E receipt failure'); expect(await counts()).toEqual(before); }
    finally { await db.query('DROP TRIGGER e2e_reject_receipt ON mdf_evidence_revisions'); }
  });
  it.each(['quantity','delete','reparent'] as const)('locks selected details before capture while another writer changes %s', async change => {
    const f = await fixture(),other = await fixture(),before = await counts();
    await db.query('BEGIN');
    await db.query('SELECT detail_id FROM order_details WHERE detail_id=$1 FOR UPDATE',[f.detailId]);
    const sql = change === 'quantity' ? 'UPDATE order_details SET quantity=7 WHERE detail_id=$1'
      : change === 'delete' ? 'UPDATE order_details SET delete_flag=true WHERE detail_id=$1'
        : 'UPDATE order_details SET order_id=$2 WHERE detail_id=$1';
    await db.query(sql,change === 'reparent' ? [f.detailId,other.orderId] : [f.detailId]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entered = new Promise<void>((resolve,reject) => {
      timer = setTimeout(() => reject(new Error('Selected detail lock was not reached')),2000);
      onQuery = statement => { if (/SELECT detail_id FROM order_details/.test(statement) && /FOR UPDATE/.test(statement)) resolve(); };
    });
    const pending = repository.create(f.command()).then(value => ({ value }),error => ({ error }));
    try {
      await entered; await db.query('COMMIT');
      const result = await pending;
      if (change === 'quantity') {
        expect(result).not.toHaveProperty('error');
        if (!('value' in result)) throw new Error('Creation failed');
        expect(result.value.set.details[0].quantity).toBe(7);
        expect((await db.query('SELECT quantity FROM mdf_evidence_lines WHERE source_id=$1',[String(result.value.set.bazisCutSetId)])).rows)
          .toEqual([{ quantity: '7' }]);
        expect(await runner().processOne()).toMatchObject({ status: 'done' });
      } else {
        expect(result).toMatchObject({ error: { code: 'ORDER_NOT_FOUND' } });
        expect(await counts()).toEqual(before);
      }
    } finally { clearTimeout(timer); onQuery = undefined; await db.query('ROLLBACK'); await pending; }
  });
  it('disabled rules retain membership publication without changing detail status', async () => {
    const f = await fixture(); await db.query('UPDATE status_automation_rules SET is_enabled=false');
    try {
      const result = await repository.create(f.command());
      expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: result.mdfJobId });
      expect(await statuses(f.orderId)).toEqual([{ production_status_id: 1 },{ production_status_id: 1 }]);
    } finally { await db.query('UPDATE status_automation_rules SET is_enabled=true'); }
  });
  it('downstream failure keeps the committed source and receipt; exact replay never queues a duplicate', async () => {
    const f = await fixture(),command = f.command(),result = await repository.create(command);
    const broken = new MdfJobRunner(database,async tx => {
      await tx.query('UPDATE order_details SET production_status_id=3 WHERE detail_id=$1',[f.detailId]);
      throw new Error('E2E downstream failure');
    });
    expect(await broken.processOne()).toMatchObject({ status: 'retry',jobId: result.mdfJobId });
    expect(await statuses(f.orderId)).toEqual([{ production_status_id: 1 },{ production_status_id: 1 }]);
    const before = await counts(); expect(await repository.create(command)).toEqual(result); expect(await counts()).toEqual(before);
    await db.query('UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE job_id=$1',[result.mdfJobId]);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: result.mdfJobId });
  });
  it('legacy creation stays outside the accepted queue', async () => {
    const f = await fixture(),before = await counts();
    await db.query("UPDATE mdf_engine_state SET mode='legacy'");
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','false'); vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE','false');
    try {
      const result = await repository.create(f.command()); expect(result.mdfJobId).toBeUndefined();
      expect((await counts()).receipts).toBe(before.receipts); expect((await counts()).jobs).toBe(before.jobs);
    } finally {
      await db.query("UPDATE mdf_engine_state SET mode='active'");
      vi.stubEnv('BACKEND_STATUS_AUTOMATION','true'); vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE','true');
    }
  });
  it('read_only and unsupported active edits reject before domain effects', async () => {
    const f = await fixture(),before = await counts();
    await db.query("UPDATE mdf_engine_state SET mode='read_only'");
    try { await expect(repository.create(f.command())).rejects.toMatchObject({ code: 'MDF_ENGINE_READ_ONLY' }); }
    finally { await db.query("UPDATE mdf_engine_state SET mode='active'"); }
    expect(await counts()).toEqual(before);
    await expect(repository.rename({ currentUser: user,setId: 1,name: 'E2E blocked',expectedVersion: 0,
      idempotencyKey: `E2E-${randomUUID()}` })).rejects.toMatchObject({ code: 'MDF_WRITER_NOT_CONNECTED' });
    expect(await counts()).toEqual(before);
  });
  it('does not reuse an identity whose immutable MDF history outlives the raw set', async () => {
    const first = await fixture(),created = await repository.create(first.command()); await runner().processOne();
    await db.query('DELETE FROM bazis_cut_set_details WHERE bazis_cut_set_id=$1',[created.set.bazisCutSetId]);
    await db.query('DELETE FROM bazis_cut_sets WHERE bazis_cut_set_id=$1',[created.set.bazisCutSetId]);
    const second = await fixture(),next = await repository.create(second.command());
    expect(next.set.bazisCutSetId).toBeGreaterThan(created.set.bazisCutSetId);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: next.mdfJobId });
  });
});
