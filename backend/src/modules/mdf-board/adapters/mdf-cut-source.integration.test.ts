import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import { ApiError } from '../../../common/errors/api-error';
import type { PerformanceQueryTelemetryService } from '../../../performance/performance-query-telemetry.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import { PgCutRepository } from '../../cut/adapters/pg-cut-repository';
import { PgBazisCutRepository } from '../../bazis-cut/adapters/pg-bazis-cut-repository';
import { PgCncTelegramRepository } from '../../cnc-telegram/adapters/pg-cnc-telegram-repository';
import { PgCncTelegramImportRepository } from '../../cnc-telegram/adapters/pg-cnc-telegram-import-repository';
import { PgCncTelegramMdfObservationRepository } from '../../cnc-telegram/adapters/pg-cnc-telegram-mdf-observation-repository';
import type { ManualSvgUploadCommand } from '../../cnc-telegram/application/cnc-telegram.types';
import { PgMdfBoardManualMoveRepository } from '../../orders/adapters/pg-mdf-board-manual-move-repository';
import { StaticCutConfig } from '../../cut/application/cut-config';
import type { OptimizeRequest, FreecutOptimizeResponse } from '../../cut/application/cut-freecut-mapping';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { readMdfPublishedSnapshot } from './mdf-published-snapshot';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('actual vacuum calculation → MDF receipt → queue → publication', () => {
  const schema = `e2e_mdf_cut_${randomUUID().replaceAll('-','')}`;
  const connection = { host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB,user: process.env.PG_USER,password: process.env.PG_PASSWORD,connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c lock_timeout=3000 -c max_parallel_workers_per_gather=0 -c jit=off' };
  const db = new Client(connection);
  let database: DatabaseService,repository: PgCutRepository,sequence = 0;
  let duringOptimize: (() => Promise<void>) | undefined;
  let onQuery: ((sql: string) => void) | undefined;
  const user: CurrentUser = { id: '1',username: 'E2E bath source',role: 'admin',roleId: 1,
    permissions: ['cut.view','cut.manage','orders.view'] };
  const config = new StaticCutConfig();
  const freecut = { optimize: async (request: OptimizeRequest): Promise<FreecutOptimizeResponse> => {
    await duringOptimize?.();
    let x = 0;
    return { status: 'ok',summary: { used_stock_count: 1,waste_percent: 10 },solutions: [{
      stock_id: request.stock[0].id,index: 0,width_mm: request.stock[0].width_mm,height_mm: request.stock[0].height_mm,
      trim_mm: request.params.trim_mm,placements: request.items.flatMap(item => Array.from({ length: item.qty },(_,i) => {
        const placement = { item_id: item.id,instance: i+1,x_mm: x,y_mm: 0,width_mm: item.width_mm,height_mm: item.height_mm,rotated: false };
        x += item.width_mm + request.params.spacing_mm + request.params.kerf_mm + 10; return placement;
      })) }] };
  } };
  const runner = () => new MdfJobRunner(database,executeMdfAcceptedJob);
  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true'); vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE','false');
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE','true'); vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH','true');
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql','174_mdf_execution_context.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql']) {
      await db.query(readFileSync(new URL(`../../../../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    // Structural clones only. Every sequence/default is local; tests cannot
    // consume public IDs or write public data through inherited triggers.
    const tables = ['orders','order_details','production_statuses','order_statuses','materials','sheet_material_types',
      'users','status_automation_rules','outbox_events','audit_log','audit_log_related_entity','app_settings','order_workshops',
      'bazis_cut_sets','bazis_cut_set_details','projects','clients','milling_types','films','edge_types','employees',
      'cut_job_item','cut_job','cut_group','cut_group_sheet','cut_group_manual_layout','cut_result','cut_result_command',
      'cut_result_archive_state','cut_param_profiles','cut_pdf_templates','order_doweling_links','doweling_orders',
      'order_hdf_details','hdf_calculation_config_state','mdf_board_manual_moves','cnc_telegram_packets',
      'cnc_telegram_packet_items','cnc_telegram_packet_whole_order_keys','cut_result_board_projection',
      'cut_result_placement','cut_result_sheet_map','cut_result_label_map_projection','command_idempotency_keys',
      'bazis_node_order_detail_map','bazis_nodes','bazis_project_revisions','bazis_order_links','order_import_entity_map'];
    tables.push('cnc_telegram_packet_evidence_set','cnc_telegram_packet_item_evidence','cnc_telegram_label_sheet_map',
      'cnc_telegram_label_placement','cnc_manual_svg_upload_files','cnc_manual_svg_upload_file_orders',
      'cnc_manual_svg_telegram_send_requests','cnc_manual_svg_telegram_send_request_files');
    tables.push('roles','permissions_catalog','role_permissions','role_policy_scopes','permissions_state',
      'cnc_telegram_worker_session_leases','cnc_telegram_import_scans','cnc_telegram_import_candidates',
      'cnc_telegram_import_candidate_matches','cnc_telegram_import_requests','cnc_telegram_import_items');
    let serial = 0;
    for (const table of tables) {
      await db.query(`CREATE TABLE ${table} AS TABLE public.${table} WITH NO DATA`);
      const defaults = (await db.query<{ name: string; expression: string | null; identity: string }>(`SELECT a.attname name,
        pg_get_expr(d.adbin,d.adrelid) expression,a.attidentity identity FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated=''
          AND (d.oid IS NOT NULL OR a.attidentity<>'')`,[`public.${table}`])).rows;
      for (const d of defaults) {
        if (d.identity || d.expression?.includes('nextval(')) {
          const seq = `e2e_seq_${++serial}`;
          await db.query(`CREATE SEQUENCE ${seq}; ALTER TABLE ${table} ALTER COLUMN ${d.name} SET DEFAULT nextval('${seq}')`);
        } else if (d.expression) await db.query(`ALTER TABLE ${table} ALTER COLUMN ${d.name} SET DEFAULT ${d.expression}`);
      }
      const indexes = (await db.query<{ definition: string }>(`SELECT pg_get_indexdef(indexrelid) definition FROM pg_index
        WHERE indrelid=$1::regclass AND indisunique`,[`public.${table}`])).rows;
      for (const i of indexes) {
        if (table==='cnc_telegram_packets'&&i.definition.includes('cnc_telegram_packets_pkey')) continue;
        await db.query(i.definition.replace(`ON public.${table}`,`ON ${schema}.${table}`));
      }
    }
    await db.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await db.query(readFileSync(new URL('../../../../db/migrations/179_mdf_active_return.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL('../../../../db/migrations/180_mdf_cnc_observations.sql',import.meta.url),'utf8'));
    await db.query(`ALTER TABLE cut_group_sheet ADD FOREIGN KEY(cut_group_id) REFERENCES cut_group(cut_group_id) ON DELETE CASCADE`);
    for (const name of ['set_session_user','order_production_summary','recalc_order_production_status',
      'cut_result_snapshot_digest','cut_result_snapshot_is_complete','cut_result_snapshot_is_vacuum',
      'cut_result_label_map_expected_counts','project_cut_result_label_maps','project_new_cut_result_label_maps',
      'project_cut_result_board_metadata','project_new_cut_result_board_metadata']) {
      const definitions = (await db.query<{ definition: string }>(`SELECT pg_get_functiondef(p.oid) definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`,[name])).rows;
      expect(definitions.length).toBeGreaterThan(0);
      for (const { definition } of definitions) {
        expect(definition).not.toMatch(/(?:FROM|UPDATE|JOIN|INTO)\s+public\./i);
        await db.query(definition.replace('FUNCTION public.',`FUNCTION ${schema}.`));
      }
    }
    await db.query(readFileSync(new URL('../../../../db/migrations/177_cut_result_typed_hdf.sql',import.meta.url),'utf8'));
    await db.query(`CREATE TRIGGER e2e_project_maps AFTER INSERT ON cut_result FOR EACH ROW EXECUTE FUNCTION project_new_cut_result_label_maps();
      CREATE TRIGGER e2e_project_board AFTER INSERT ON cut_result FOR EACH ROW EXECUTE FUNCTION project_new_cut_result_board_metadata();
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES(1,'E2E bath source',1,true);
      INSERT INTO roles(role_id,role_code,role_name,is_active) VALUES(1,'admin','E2E admin',true);
      INSERT INTO permissions_state(id,version) VALUES(true,1);
      INSERT INTO permissions_catalog(permission_name,domain,label,is_active)
        VALUES('cut.manage','cut','E2E cut',true),('orders.view','orders','E2E orders',true);
      INSERT INTO role_permissions(role_id,permission_name,is_enabled) VALUES(1,'cut.manage',true),(1,'orders.view',true);
      INSERT INTO role_policy_scopes(role_id,scope_key,scope_value) VALUES(1,'orders.view','all');
      INSERT INTO projects(project_id,code) VALUES(1,'E2E');
      INSERT INTO sheet_material_types(sheet_material_type_id,name,thickness_mm,width_mm,height_mm,is_cuttable,is_active)
        VALUES(1,'МДФ 10 мм',10,2800,2070,true,true),(2,'MDF 18 mm',18,2800,2070,true,true),
          (3,'ХДФ',3,2800,2070,true,true),(4,'fanera',10,2800,2070,true,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',1,true),(2,'drawn','Отрисован',10,true),(3,'cut','Распилен',20,true),
          (4,'laminated','Закатан',30,true),(5,'packed','Упакован',40,true),(6,'issued','Выдан',50,true);
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES(18,'E2E own rolled','mdf.board.baths_laminated','change_details_production_status',4,'{}',100,true,1,'{}');
      INSERT INTO hdf_calculation_config_state(id,revision) VALUES(1,1)`);
    const url = new URL('postgresql://localhost'); url.hostname=connection.host; url.pathname=`/${connection.database}`;
    url.username=connection.user ?? ''; url.password=connection.password ?? '';
    url.searchParams.set('options',`-c search_path=${schema},public -c lock_timeout=3000 -c jit=off -c max_parallel_workers_per_gather=0`);
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(),DATABASE_QUERY_TIMEOUT_MS: 15000,DATABASE_POOL_MIN: 0,DATABASE_POOL_MAX: 2,DATABASE_SSL: false };
    database = new DatabaseService({ get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv,true>,
      { measure: <T>(sql: string, operation: () => Promise<T>) => { onQuery?.(sql); return operation(); } } as PerformanceQueryTelemetryService);
    repository = new PgCutRepository(database,freecut,config);
  },30000);
  afterAll(async () => {
    vi.unstubAllEnvs(); await database?.onModuleDestroy();
    try { await db.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows).toHaveLength(0);
    } finally { await db.end(); }
  });
  async function fixture(material=1, vacuum=true) {
    const orderId=++sequence,detailId=orderId*10,cutJobId=orderId;
    await db.query(`INSERT INTO orders(order_id,order_name,project_id,order_date,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,1,'2026-09-22','production_order',false,1,4,1,1)`,[orderId,`E2E bath ${orderId}`]);
    await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,detail_name,quantity,height,width,production_status_id,
      delete_flag,sheet_material_type_id,version,updated_at) VALUES($1,$2,1,'E2E own',2,200,100,1,false,$4,1,now()),
      ($3,$2,2,'E2E outside bath',1,200,100,1,false,1,1,now())`,[detailId,orderId,detailId+1,material]);
    const params={ ...await config.getDefaultParams(),layout_mode: vacuum ? 'vacuum_table' : 'guillotine' };
    await db.query(`INSERT INTO cut_job(cut_job_id,name,status,version,source,params,rotation_allowed,combine_films,split_by_material)
      VALUES($1,$2,'draft',1,'manual',$3::jsonb,true,false,true)`,[cutJobId,`E2E bath ${cutJobId}`,JSON.stringify(params)]);
    await db.query(`INSERT INTO cut_job_item(cut_job_id,source_type,order_id,order_detail_id,freecut_item_id,qty,is_active)
      VALUES($1,'order_detail',$2,$3,$4,2,true)`,[cutJobId,orderId,detailId,`det-${detailId}`]);
    const command=()=>({ currentUser: user,cutJobId,version: 1,commandId: randomUUID(),requestId: 'E2E bath calculate' });
    return { orderId,detailId,cutJobId,command };
  }
  const counts=async()=> (await db.query(`SELECT (SELECT count(*) FROM cut_result) results,
    (SELECT count(*) FROM mdf_evidence_revisions) receipts,(SELECT count(*) FROM mdf_recalculation_jobs) jobs,
    (SELECT count(*) FROM audit_log) audits,(SELECT count(*) FROM outbox_events) outbox`)).rows[0];
  const resultId=async(job:number)=>Number((await db.query('SELECT current_cut_result_id FROM cut_job WHERE cut_job_id=$1',[job])).rows[0].current_cut_result_id);
  async function svgFixture(quantity=2): Promise<{ orderId:number; detailId:number; command:ManualSvgUploadCommand }> {
    const orderId=++sequence,detailId=orderId*10;
    await db.query(`INSERT INTO orders(order_id,order_name,project_id,order_date,order_kind,delete_flag,version,order_status_id,payment_status_id,created_by)
      VALUES($1,$2,1,'2026-09-22','production_order',false,1,4,1,1)`,[orderId,`E2E-SVG-${orderId}`]);
    await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,detail_name,quantity,height,width,production_status_id,
      delete_flag,sheet_material_type_id,version,updated_at) VALUES($1,$2,1,'E2E SVG own',2,200,100,1,false,1,1,now()),
      ($3,$2,2,'E2E outside SVG',1,200,100,1,false,1,1,now())`,[detailId,orderId,detailId+1]);
    const item={ sourceItemKey:`svg-${detailId}`,orderName:`E2E-SVG-${orderId}`,detailNumber:1,widthMm:100,heightMm:200,
      quantity,source:'vector' as const,confidence:1 };
    return { orderId,detailId,command:{ currentUser:user,requestId:'E2E SVG upload',dto:{
      idempotencyKey:`E2E-${randomUUID()}`,selectedOrderIds:[orderId],createMdfMachineFileCard:true,
      matchMode:'order_details',validationMode:'strict',svgContentHash:randomUUID().replaceAll('-','').repeat(2),
      programName:`E2E-SVG-${orderId}.svg`,materialName:'МДФ 10 мм',workday:'2026-09-22',
      comments:[`E2E-SVG-${orderId} — весь заказ`],items:[item],cutLayout:{ status:'valid',reasons:[],
        sheet:{widthMm:2800,heightMm:2070},rawCommentCount:1,partContourCount:quantity,acceptedItemCount:quantity,
        items:Array.from({length:quantity},(_,i)=>({...item,quantity:1,sourceElementId:`part-${i}`,
          xMm:10+i*150,yMm:10,placedWidthMm:100,placedHeightMm:200,rotated:false})) } } } };
  }
  it('actual SVG upload commits membership only; own-detail rules execute in the queue, not intake',async()=>{
    const f=await svgFixture();
    await db.query(`INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
      VALUES(19,'E2E SVG present','mdf.order_machine_files_present','change_details_production_status',2,'{}',100,true,1,'{}')`);
    try {
      const repo=new PgCncTelegramRepository(database),result=await repo.manualSvgUpload(f.command),id=result.packet.packetId;
      expect((await db.query('SELECT stage_code,evidence_kind,quantity FROM mdf_evidence_lines WHERE source_id=$1',[id])).rows)
        .toEqual([{stage_code:'membership',evidence_kind:'derived',quantity:'2'}]);
      expect((await db.query("SELECT metadata_json->>'mdfJobId' job FROM audit_log WHERE event='cnc.manual_svg_upload.created' AND entity_id=$1",[id])).rows[0].job).toEqual(expect.any(String));
      expect((await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[f.orderId])).rows)
        .toEqual([{production_status_id:1},{production_status_id:1}]);
      const before=await counts();await repo.manualSvgUpload(f.command);expect(await counts()).toEqual(before);
      expect(await runner().processOne()).toMatchObject({status:'done'});
      expect((await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[f.orderId])).rows)
        .toEqual([{production_status_id:2},{production_status_id:1}]);
      const board=await readMdfPublishedSnapshot(database,user,{focus:{kind:'packet',id}});
      expect(board.cards.find(c=>c.kind==='packet' && c.id===id)).toMatchObject({column:'parsed',issues:[]});
      expect((await db.query('SELECT credited_cut,credited_rolled,remaining FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
        .toEqual({credited_cut:'0',credited_rolled:'0',remaining:'2'});
    } finally { await db.query('DELETE FROM status_automation_rules WHERE id=19'); }
  });
  it('SVG partial position preserves its own quantity and complete order demand',async()=>{
    const f=await svgFixture(1),result=await new PgCncTelegramRepository(database).manualSvgUpload(f.command),id=result.packet.packetId;
    expect((await db.query('SELECT quantity FROM mdf_evidence_lines WHERE source_id=$1',[id])).rows).toEqual([{quantity:'1'}]);
    expect((await db.query('SELECT detail_id,quantity FROM mdf_revision_demand WHERE source_id=$1 ORDER BY detail_id',[id])).rows)
      .toEqual([{detail_id:String(f.detailId),quantity:'2'},{detail_id:String(f.detailId+1),quantity:'1'}]);
    expect(await runner().processOne()).toMatchObject({status:'done'});
  });
  it.each(['quantity','extra_position'])('SVG %s mismatch with actual saved layout is unaccepted',async mismatch=>{
    const f=await svgFixture(1);
    if(mismatch==='quantity') { f.command.dto.validationMode='lenient';f.command.dto.items[0].quantity=2; }
    else f.command.dto.items.push({...f.command.dto.items[0],sourceItemKey:'extra-position',detailNumber:2});
    const repo=new PgCncTelegramRepository(database),id=(await repo.manualSvgUpload(f.command)).packet.packetId;
    expect((await db.query('SELECT accepted_revision_key FROM mdf_source_heads WHERE source_id=$1',[id])).rows[0].accepted_revision_key).toBeNull();
    const before=await counts();expect((await repo.manualSvgUpload(f.command)).packet.packetId).toBe(id);expect(await counts()).toEqual(before);
    expect(await runner().processOne()).toMatchObject({status:'done'});
    const board=await readMdfPublishedSnapshot(database,user,{focus:{kind:'packet',id}});
    expect(board.cards.find(c=>c.id===id)?.issues).toContain('MDF_COMPOSITION_UNRESOLVED');
    expect((await db.query('SELECT credited_cut,credited_rolled FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({credited_cut:'0',credited_rolled:'0'});
  });
  it.each(['material','filename','comment','detail'])('SVG excludes foreign material in %s without creating MDF evidence',async field=>{
    const f=await svgFixture(),dto=f.command.dto;
    if(field==='material') dto.materialName='HDF 3 mm';
    if(field==='filename') dto.programName='machine-fanera-10.svg';
    if(field==='comment') dto.comments=['ldsp 16 mm'];
    if(field==='detail') await db.query('UPDATE order_details SET sheet_material_type_id=3 WHERE detail_id=$1',[f.detailId]);
    dto.validationMode='lenient';const before=await counts();
    await new PgCncTelegramRepository(database).manualSvgUpload(f.command);
    expect((await counts()).receipts).toBe(before.receipts);
  });
  it('unresolved SVG stays visible but cannot contribute confirmed membership',async()=>{
    const f=await svgFixture();f.command.dto.matchMode='informational';
    const result=await new PgCncTelegramRepository(database).manualSvgUpload(f.command),id=result.packet.packetId;
    expect((await db.query('SELECT accepted_revision_key FROM mdf_source_heads WHERE source_id=$1',[id])).rows[0].accepted_revision_key).toBeNull();
    expect(await runner().processOne()).toMatchObject({status:'done'});
    const board=await readMdfPublishedSnapshot(database,user,{focus:{kind:'packet',id}});
    expect(board.cards.find(c=>c.id===id)).toMatchObject({column:'parsed',issues:expect.arrayContaining(['MDF_COMPOSITION_UNRESOLVED'])});
  });
  it('explicit SVG rework can exceed order quantity but grants no normal production credit',async()=>{
    const f=await svgFixture(3);f.command.dto.rework=true;f.command.dto.validationMode='lenient';
    const id=(await new PgCncTelegramRepository(database).manualSvgUpload(f.command)).packet.packetId;
    expect((await db.query('SELECT quantity,rework FROM mdf_evidence_lines WHERE source_id=$1',[id])).rows).toEqual([{quantity:'3',rework:true}]);
    expect(await runner().processOne()).toMatchObject({status:'done'});
    expect((await db.query('SELECT credited_cut,remaining FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({credited_cut:'0',remaining:'2'});
  });
  it('normal SVG excess is rejected atomically, including receipt/audit/cut result',async()=>{
    const f=await svgFixture(3);f.command.dto.validationMode='lenient';const before=await counts();
    await expect(new PgCncTelegramRepository(database).manualSvgUpload(f.command)).rejects.toMatchObject({code:'MDF_SVG_SOURCE_INVALID'});
    expect(await counts()).toEqual(before);
  });
  it('SVG replay reauthorizes owners; new-key replay cannot promote existing history',async()=>{
    const f=await svgFixture(),repo=new PgCncTelegramRepository(database);await repo.manualSvgUpload(f.command);await runner().processOne();
    const before=await counts();
    await expect(repo.manualSvgUpload({...f.command,dto:{...f.command.dto,idempotencyKey:`E2E-${randomUUID()}`}}))
      .rejects.toMatchObject({code:'MDF_SVG_EXISTING_SOURCE_REQUIRES_REVIEW'});
    const base=rolePolicyForUser(user),restricted={...user,policyScopes:{...base,orders:{...base.orders,view:'own' as const}}};
    await db.query('UPDATE orders SET created_by=999 WHERE order_id=$1',[f.orderId]);
    await expect(repo.manualSvgUpload({...f.command,currentUser:restricted})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect(await counts()).toEqual(before);
  });
  it('SVG read-only and missing permission rejection precede packet or source creation',async()=>{
    const f=await svgFixture(),repo=new PgCncTelegramRepository(database),before=await counts();
    await expect(repo.manualSvgUpload({...f.command,currentUser:{...user,permissions:['cut.manage']}}))
      .rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await db.query("UPDATE mdf_engine_state SET mode='read_only'");
    try { await expect(repo.manualSvgUpload(f.command)).rejects.toMatchObject({code:'MDF_ENGINE_READ_ONLY'}); }
    finally { await db.query("UPDATE mdf_engine_state SET mode='active'"); }
    expect(await counts()).toEqual(before);
  });
  it('SVG nested entry cannot acquire a late boundary',async()=>{
    const f=await svgFixture(),before=await counts();
    await expect(database.transaction(tx=>new PgCncTelegramRepository(database).manualSvgUploadInTransaction(tx,f.command)))
      .rejects.toMatchObject({code:'MDF_COMMAND_BOUNDARY_REQUIRED'});
    expect(await counts()).toEqual(before);
  });
  it('SVG cutover fence waits then observes the new mode before any business write',async()=>{
    const f=await svgFixture(),before=await counts();
    let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
    onQuery=sql=>{if(sql.includes("pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover'")) entered();};
    await db.query("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('mdf-engine-cutover',0))");
    const upload=new PgCncTelegramRepository(database).manualSvgUpload(f.command).then(()=>null,error=>error);
    try {
      await waiting;expect(await counts()).toEqual(before);
      await db.query("UPDATE mdf_engine_state SET mode='read_only'; COMMIT");
      expect(await upload).toMatchObject({code:'MDF_ENGINE_READ_ONLY'});
      expect(await counts()).toEqual(before);
    } finally { onQuery=undefined;await db.query("ROLLBACK; UPDATE mdf_engine_state SET mode='active'");await upload; }
  });
  it('SVG selected mixed owners require access to each owner before creation',async()=>{
    const a=await svgFixture(),b=await svgFixture();a.command.dto.selectedOrderIds.push(b.orderId);
    await db.query('UPDATE orders SET created_by=999 WHERE order_id=$1',[b.orderId]);
    const base=rolePolicyForUser(user),restricted={...user,policyScopes:{...base,orders:{...base.orders,view:'own' as const}}};
    const before=await counts();
    await expect(new PgCncTelegramRepository(database).manualSvgUpload({...a.command,currentUser:restricted}))
      .rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(await counts()).toEqual(before);
  });
  it('non-card SVG still cannot resolve positions outside the locked selection',async()=>{
    const f=await svgFixture();f.command.dto.selectedOrderIds=[];f.command.dto.validationMode='lenient';
    f.command.dto.createMdfMachineFileCard=false;const before=await counts();
    await expect(new PgCncTelegramRepository(database).manualSvgUpload(f.command)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect(await counts()).toEqual(before);
  });
  async function telegramFixture() {
    const f=await svgFixture(),itemId=randomUUID(),requestId=randomUUID(),candidateId=randomUUID(),scanId=randomUUID();
    const chat=`E2E-${itemId}`,worker=randomUUID(),token=randomUUID(),sourceMessageId=String(f.orderId);
    const raw=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2800" height="2070"><!-- ${itemId} --></svg>`);
    const sha=createHash('sha256').update(raw).digest('hex'),fileName=`MDF-${f.orderId}.svg`;
    await db.query(`INSERT INTO cnc_telegram_worker_session_leases(source_chat_id,lease_token,lease_generation,worker_instance_id,worker_image_revision,expires_at)
      VALUES($1,$2,1,$3,'abcdef1',now()+interval '1 hour')`,[chat,token,worker]);
    await db.query(`INSERT INTO cnc_telegram_import_requests(import_request_id,scan_id,requested_by,status,selected_count)
      VALUES($1,$2,1,'processing',1)`,[requestId,scanId]);
    await db.query(`INSERT INTO cnc_telegram_import_candidates(candidate_id,scan_id,source_chat_id,source_message_id,svg_message_id,
      svg_file_name,svg_content_sha256,source_set_fingerprint,parser_version,cut_layout_json,workday)
      VALUES($1,$2,$3,$4,$4,$5,$6,$6,'E2E',$7::jsonb,'2026-09-22')`,
      [candidateId,scanId,chat,sourceMessageId,fileName,sha,JSON.stringify(f.command.dto.cutLayout)]);
    await db.query(`INSERT INTO cnc_telegram_import_items(import_item_id,import_request_id,candidate_id,status,duplicate_match_version,
      lease_token,lease_generation,lease_worker_instance_id,lease_expires_at,source_set_fingerprint)
      VALUES($1,$2,$3,'processing',1,$4,1,$5,now()+interval '1 hour',$6)`,[itemId,requestId,candidateId,token,worker,sha]);
    const input={currentUser:{...user,username:'E2E technical worker'},importItemId:itemId,requestId:'E2E Telegram complete',
      lease:{sourceChatId:chat,leaseToken:token,leaseGeneration:1,workerInstanceId:worker},
      completion:{itemLeaseToken:token,itemLeaseGeneration:1,itemLeaseOwner:worker,sourceSetFingerprint:sha,
        source:{sourceChatId:chat,sourceMessageId,svgMessageId:sourceMessageId,svgFileName:fileName,svgContentSha256:sha},
        sourceFiles:[{kind:'svg' as const,fileName,contentType:'image/svg+xml',sizeBytes:raw.length,sha256:sha,base64Content:raw.toString('base64')}]}};
    return {...f,input,candidateId,itemId,importer:new PgCncTelegramImportRepository(database,new PgCncTelegramRepository(database))};
  }
  it('actual Telegram completion queues membership once under the requester, never machine completion',async()=>{
    const f=await telegramFixture(),result=await f.importer.completeImport(f.input);
    expect(result.status).toBe('imported');const id=result.packetId!;
    expect((await db.query('SELECT stage_code,quantity FROM mdf_evidence_lines WHERE source_id=$1',[id])).rows)
      .toEqual([{stage_code:'membership',quantity:'2'}]);
    expect((await db.query(`SELECT user_id,metadata_json->>'mdfJobId' job FROM audit_log
      WHERE event='cnc.telegram_import.item_imported' AND entity_id=$1`,[f.itemId])).rows[0])
      .toMatchObject({user_id:'1',job:expect.any(String)});
    expect((await db.query(`SELECT payload_json->>'mdfJobId' job FROM outbox_events
      WHERE event_type='cnc.telegram_import.item_imported' AND aggregate_id=$1`,[f.itemId])).rows[0].job).toEqual(expect.any(String));
    const observationTarget = (await db.query(`SELECT t.source_chat_id,t.source_group_message_id::text group_message_id,
      t.message_bindings,t.registered_revision_key,t.accepted_revision_key,p.source_version::text raw_version,
      h.received_revision_key,h.accepted_revision_key head_accepted
      FROM mdf_cnc_observation_targets t JOIN cnc_telegram_packets p USING(packet_id)
      JOIN mdf_source_heads h ON h.source_kind='packet' AND h.source_id=t.packet_id::text WHERE t.packet_id=$1`,[id])).rows[0];
    expect(observationTarget).toMatchObject({ source_chat_id:f.input.completion.source.sourceChatId,
      group_message_id:f.input.completion.source.sourceMessageId, registered_revision_key:observationTarget.head_accepted,
      accepted_revision_key:observationTarget.head_accepted,received_revision_key:observationTarget.head_accepted,
      head_accepted:expect.any(String),raw_version:'1' });
    expect(observationTarget.message_bindings).toEqual([{ messageId:f.input.completion.source.svgMessageId,
      role:'svg',sha256:f.input.completion.source.svgContentSha256 }]);
    const before=await counts();await f.importer.completeImport(f.input);expect(await counts()).toEqual(before);
    expect(await runner().processOne()).toMatchObject({status:'done'});
    expect((await db.query('SELECT credited_cut,remaining FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({credited_cut:'0',remaining:'2'});
  });
  it('fresh CNC completion after real manual completed proof creates an authority receipt without double counting',async()=>{
    const f=await telegramFixture(), imported=await f.importer.completeImport(f.input), packetId=imported.packetId!;
    expect(imported.status).toBe('imported');
    expect(await runner().processOne()).toMatchObject({status:'done'});
    const mover=new PgMdfBoardManualMoveRepository(database);
    const actor={...user,permissions:[...user.permissions,'orders.update','production.tasks.update','orders.change_production_status']} as CurrentUser;
    const board=await readMdfPublishedSnapshot(database,user,{focus:{kind:'packet',id:packetId}});
    const card=board.cards.find(value=>value.kind==='packet'&&value.id===packetId)!;
    await mover.upsert({currentUser:actor,cardKind:'packet',cardId:packetId,targetColumn:'completed',
      sourceToken:card.commandToken!,idempotencyKey:`E2E-${randomUUID()}`,requestId:'E2E manual completed before CNC'});
    expect(await runner().processOne()).toMatchObject({status:'done'});
    const before=(await db.query(`SELECT h.accepted_revision_key,
      (SELECT sum(quantity)::text FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1
        AND revision_key=h.accepted_revision_key AND stage_code='cut' AND evidence_kind='physical') physical_cut,
      p.source_version::text source_version FROM mdf_source_heads h JOIN cnc_telegram_packets p ON p.packet_id=h.source_id::uuid
      WHERE h.source_kind='packet' AND h.source_id=$1`,[packetId])).rows[0];
    expect(before.physical_cut).toBe('2');
    const priorCncSetting=(await db.query(`SELECT is_active,value_json FROM app_settings
      WHERE setting_key='status_automation.cnc_mark_cut_details'`)).rows[0];
    await db.query(`INSERT INTO app_settings(setting_key,is_active,value_json)
      VALUES('status_automation.cnc_mark_cut_details',true,'{"value":true}'::jsonb)
      ON CONFLICT(setting_key) DO UPDATE SET is_active=true,value_json='{"value":true}'::jsonb`);
    try {
    const observations=new PgCncTelegramMdfObservationRepository(database),lease=f.input.lease;
    const claim=await observations.claim({currentUser:user,lease});
    const result=await observations.complete({currentUser:user,lease,requestId:'E2E CNC after manual complete',report:{
      claimId:claim!.claimId,claimToken:claim!.claimToken,claimGeneration:claim!.claimGeneration,
      messages:claim!.messages.map(message=>({messageId:message.messageId,chatId:claim!.sourceChatId,
        role:message.role,sha256:message.sha256,present:true,thumbsUp:true})),
    }});
    expect(result).toMatchObject({status:'recorded',jobId:expect.any(String)});
    const publication=await runner().processOne();
    const publicationError=publication.jobId
      ? (await db.query('SELECT error_code FROM mdf_recalculation_jobs WHERE job_id=$1',[publication.jobId])).rows[0]?.error_code
      : null;
    expect(publication,`CNC authority job ${publication.jobId ?? 'none'} ended ${publication.status}; error=${publicationError ?? 'none'}`)
      .toMatchObject({status:'done',jobId:result.jobId});
    expect(publicationError).toBeNull();
    const after=(await db.query(`SELECT h.accepted_revision_key,
      (SELECT sum(quantity)::text FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1
        AND revision_key=h.accepted_revision_key AND stage_code='cut' AND evidence_kind='physical') physical_cut,
      p.source_version::text source_version FROM mdf_source_heads h JOIN cnc_telegram_packets p ON p.packet_id=h.source_id::uuid
      WHERE h.source_kind='packet' AND h.source_id=$1`,[packetId])).rows[0];
    expect(after.accepted_revision_key).not.toBe(before.accepted_revision_key);
    expect(after.physical_cut).toBe(before.physical_cut);
    expect(after.source_version).toBe(before.source_version);
    expect((await db.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0].production_status_id)
      .toBe(3);
    expect((await db.query('SELECT order_status_id FROM orders WHERE order_id=$1',[f.orderId])).rows[0].order_status_id)
      .toBe(4);
    expect((await db.query(`SELECT a.authority,a.claim_id,r.result->>'jobId' job
      FROM mdf_cnc_observation_job_authorities a JOIN mdf_cnc_observation_receipts r USING(claim_id)
      WHERE a.packet_id=$1 AND a.job_id=$2`,[packetId,result.jobId])).rows)
      .toEqual([{authority:'cnc_autocut',claim_id:claim!.claimId,job:result.jobId}]);
    } finally {
      if (priorCncSetting) {
        await db.query(`UPDATE app_settings SET is_active=$1,value_json=$2::jsonb
          WHERE setting_key='status_automation.cnc_mark_cut_details'`,[priorCncSetting.is_active,JSON.stringify(priorCncSetting.value_json)]);
      } else {
        await db.query(`DELETE FROM app_settings WHERE setting_key='status_automation.cnc_mark_cut_details'`);
      }
    }
  });
  it('executes a CNC authority job when a live bath allocation pins its current accepted revision',async()=>{
    const f=await telegramFixture(),imported=await f.importer.completeImport(f.input),packetId=imported.packetId!;
    expect(imported.status).toBe('imported');
    expect(await runner().processOne()).toMatchObject({status:'done'});
    const mover=new PgMdfBoardManualMoveRepository(database);
    const actor={...user,permissions:[...user.permissions,'orders.update','production.tasks.update','orders.change_production_status']} as CurrentUser;
    const initialBoard=await readMdfPublishedSnapshot(database,user,{focus:{kind:'packet',id:packetId}});
    const initialCard=initialBoard.cards.find(value=>value.kind==='packet'&&value.id===packetId)!;
    const manual=await mover.upsert({currentUser:actor,cardKind:'packet',cardId:packetId,targetColumn:'completed',
      sourceToken:initialCard.commandToken!,idempotencyKey:`E2E-${randomUUID()}`,requestId:'E2E current revision allocation manual proof'});
    expect(manual.jobId).toBeTruthy();
    expect(await runner().processOne()).toMatchObject({status:'done',jobId:manual.jobId});

    const observations=new PgCncTelegramMdfObservationRepository(database),lease=f.input.lease;
    const claim=await observations.claim({currentUser:user,lease});
    expect(claim?.packetId).toBe(packetId);
    const observation=await observations.complete({currentUser:user,lease,requestId:'E2E allocation after current CNC receipt',report:{
      claimId:claim!.claimId,claimToken:claim!.claimToken,claimGeneration:claim!.claimGeneration,
      messages:claim!.messages.map(message=>({messageId:message.messageId,chatId:claim!.sourceChatId,
        role:message.role,sha256:message.sha256,present:true,thumbsUp:true})),
    }});
    expect(observation.status).toBe('recorded');

    // Run a real cut-result bath before the observer job. Its allocator must
    // reserve packet evidence from the observer's exact accepted revision.
    await db.query(`UPDATE mdf_recalculation_jobs SET next_attempt_at=now()+interval '1 hour' WHERE job_id=$1`,[observation.jobId]);
    let bathId='';
    let bathJobId:string|null=null;
    let pinned:Array<{revision:string;accepted:string;state:string;quantity:string}> = [];
    try {
      const cutJobId=2_000_000+f.orderId;
      const params={...await config.getDefaultParams(),layout_mode:'vacuum_table'};
      await db.query(`INSERT INTO cut_job(cut_job_id,name,status,version,source,params,rotation_allowed,combine_films,split_by_material)
        VALUES($1,$2,'draft',1,'manual',$3::jsonb,true,false,true)`,
      [cutJobId,`E2E current pin ${f.orderId}`,JSON.stringify(params)]);
      await db.query(`INSERT INTO cut_job_item(cut_job_id,source_type,order_id,order_detail_id,freecut_item_id,qty,is_active)
        VALUES($1,'order_detail',$2,$3,$4,2,true)`,[cutJobId,f.orderId,f.detailId,`det-${f.detailId}`]);
      await repository.calculate({currentUser:user,cutJobId,version:1,commandId:randomUUID(),requestId:'E2E current revision bath calculation'});
      bathId=`cut-result:${await resultId(cutJobId)}`;
      const bathJob=(await db.query<{job_id:string}>(`SELECT job_id FROM mdf_recalculation_jobs
        WHERE source_kind='bath' AND source_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`,[bathId])).rows[0];
      expect(bathJob).toBeDefined();
      bathJobId=bathJob.job_id;
      expect(await runner().processOne()).toMatchObject({status:'done',jobId:bathJob.job_id});
      pinned=(await db.query<{revision:string;accepted:string;state:string;quantity:string}>(`SELECT e.revision_key revision,
        h.accepted_revision_key accepted,a.state,a.quantity::text quantity FROM mdf_bath_allocations a
        JOIN mdf_evidence_lines e USING(evidence_line_id)
        JOIN mdf_source_heads h ON h.source_kind=e.source_kind AND h.source_id=e.source_id
        WHERE a.bath_id=$1 AND a.state<>'released' AND e.source_kind='packet' AND e.source_id=$2
        ORDER BY e.revision_key`,[bathId,packetId])).rows;
      expect(pinned.length).toBeGreaterThan(0);
      expect(pinned.every(row=>row.revision===row.accepted)).toBe(true);
      await db.query('UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE job_id=$1',[observation.jobId]);
      const priorCncSetting=(await db.query(`SELECT is_active,value_json FROM app_settings
        WHERE setting_key='status_automation.cnc_mark_cut_details'`)).rows[0];
      await db.query(`INSERT INTO app_settings(setting_key,is_active,value_json)
        VALUES('status_automation.cnc_mark_cut_details',true,'{"value":true}'::jsonb)
        ON CONFLICT(setting_key) DO UPDATE SET is_active=true,value_json='{"value":true}'::jsonb`);
      try {
        expect((await db.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0]
          .production_status_id).toBe(1);
        expect(await runner().processOne()).toMatchObject({status:'done',jobId:observation.jobId});
        expect((await db.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0]
          .production_status_id).toBe(3);
        expect((await db.query(`SELECT count(*)::int count FROM audit_log WHERE event='cnc.mdf_observation.auto_cut_status_applied'
          AND entity_id=$1`,[packetId])).rows[0].count).toBe(1);
      } finally {
        if (priorCncSetting) {
          await db.query(`UPDATE app_settings SET is_active=$1,value_json=$2::jsonb
            WHERE setting_key='status_automation.cnc_mark_cut_details'`,[priorCncSetting.is_active,JSON.stringify(priorCncSetting.value_json)]);
        } else {
          await db.query(`DELETE FROM app_settings WHERE setting_key='status_automation.cnc_mark_cut_details'`);
        }
      }
    } finally {
      await db.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now(),error_code='E2E_TEST_CLEANUP'
        WHERE job_id=ANY($1::uuid[]) AND status='pending'`,[[observation.jobId,...(bathJobId?[bathJobId]:[])]]);
    }
    expect((await db.query(`SELECT count(*)::int count FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) JOIN mdf_source_heads h
        ON h.source_kind=e.source_kind AND h.source_id=e.source_id
      WHERE a.bath_id=$1 AND a.state<>'released' AND e.source_kind='packet' AND e.source_id=$2
        AND e.revision_key=h.accepted_revision_key`,[bathId,packetId])).rows[0].count).toBe(pinned.length);
  });
  it('no-fence pending observation returns the durable advanced server version after clearing raw completion',async()=>{
    const f=await telegramFixture(), imported=await f.importer.completeImport(f.input), packetId=imported.packetId!;
    expect(imported.status).toBe('imported');
    const ownJob=(await db.query(`SELECT job_id FROM mdf_recalculation_jobs WHERE source_kind='packet' AND source_id=$1
      AND status='pending' ORDER BY created_at,job_id LIMIT 1`,[packetId])).rows[0];
    expect(ownJob).toBeDefined();
    const processed=await runner().processOne();
    const errorCode=processed.jobId ? (await db.query('SELECT error_code FROM mdf_recalculation_jobs WHERE job_id=$1',[processed.jobId])).rows[0]?.error_code : null;
    expect(processed,`worker job ${processed.jobId ?? 'none'} (expected ${ownJob.job_id}) ended ${processed.status}; error=${errorCode ?? 'none'}`)
      .toMatchObject({status:'done',jobId:ownJob.job_id});
    await db.query(`UPDATE cnc_telegram_packets SET completion_status='completed',thumbs_up=true,completed_at=now()
      WHERE packet_id=$1`,[packetId]);
    const observations=new PgCncTelegramMdfObservationRepository(database),lease=f.input.lease;
    const claim=await observations.claim({currentUser:user,lease});
    const previous=claim!.observationVersion;
    const result=await observations.complete({currentUser:user,lease,requestId:'E2E no-fence pending',report:{
      claimId:claim!.claimId,claimToken:claim!.claimToken,claimGeneration:claim!.claimGeneration,
      messages:claim!.messages.map(message=>({messageId:message.messageId,chatId:claim!.sourceChatId,
        role:message.role,sha256:message.sha256,present:true,thumbsUp:false})),
    }});
    expect(BigInt(result.observationVersion!)).toBeGreaterThan(BigInt(previous));
    const saved=(await db.query(`SELECT r.observation_version::text version,t.last_observation_version::text target_version,
      a.metadata_json->>'observationVersion' audit_version,p.completion_status,p.thumbs_up
      FROM mdf_cnc_observation_receipts r JOIN mdf_cnc_observation_targets t USING(packet_id)
      JOIN audit_log a ON a.entity_type='cnc_telegram_packet' AND a.entity_id=r.packet_id::text
        AND a.event='cnc.mdf_observation.completed' AND a.request_id=$2
      JOIN cnc_telegram_packets p USING(packet_id) WHERE r.claim_id=$1`,[claim!.claimId,'E2E no-fence pending'])).rows[0];
    expect(saved).toEqual({version:result.observationVersion,target_version:result.observationVersion,
      audit_version:result.observationVersion,completion_status:'pending',thumbs_up:false});
  });
  it('manual command after an observation claim makes that report stale and forces a fresh fetch',async()=>{
    const f=await telegramFixture(), imported=await f.importer.completeImport(f.input), packetId=imported.packetId!;
    expect(imported.status).toBe('imported');
    expect(await runner().processOne()).toMatchObject({status:'done'});
    const observations=new PgCncTelegramMdfObservationRepository(database),lease=f.input.lease;
    const claim=await observations.claim({currentUser:user,lease});
    expect(claim?.packetId).toBe(packetId);
    const before=(await db.query(`SELECT accepted_revision_key,version::text version FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0];
    const mover=new PgMdfBoardManualMoveRepository(database);
    const actor={...user,permissions:[...user.permissions,'orders.update','production.tasks.update','orders.change_production_status']} as CurrentUser;
    const board=await readMdfPublishedSnapshot(database,user,{focus:{kind:'packet',id:packetId}});
    const card=board.cards.find(value=>value.kind==='packet'&&value.id===packetId)!;
    const manual=await mover.upsert({currentUser:actor,cardKind:'packet',cardId:packetId,targetColumn:'completed',
      sourceToken:card.commandToken!,idempotencyKey:`E2E-${randomUUID()}`,requestId:'E2E CNC command after claim'});
    expect(manual.changed).toBe(true);
    const after=(await db.query(`SELECT accepted_revision_key,version::text version FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0];
    expect(after.version).not.toBe(before.version);
    expect(after.accepted_revision_key).not.toBe(before.accepted_revision_key);
    await expect(observations.complete({currentUser:user,lease,requestId:'E2E stale CNC report',report:{
      claimId:claim!.claimId,claimToken:claim!.claimToken,claimGeneration:claim!.claimGeneration,
      messages:claim!.messages.map(message=>({messageId:message.messageId,chatId:claim!.sourceChatId,
        role:message.role,sha256:message.sha256,present:true,thumbsUp:true})),
    }})).rejects.toMatchObject({code:'MDF_CNC_OBSERVATION_STALE',statusCode:409});
    expect((await db.query('SELECT 1 FROM mdf_cnc_observation_receipts WHERE claim_id=$1',[claim!.claimId])).rows).toHaveLength(0);
    // Simulate expiry of the now-stale lease, then prove a new claim binds the
    // real current accepted revision instead of reusing cached report facts.
    await db.query('UPDATE mdf_cnc_observation_targets SET claim_expires_at=now()-interval \'1 second\' WHERE packet_id=$1',[packetId]);
    const fresh=await observations.claim({currentUser:user,lease});
    expect(fresh).toMatchObject({packetId,acceptedRevisionKey:after.accepted_revision_key,headVersion:after.version});
    expect(fresh!.claimId).not.toBe(claim!.claimId);
    const pendingManualJob=(await db.query(`SELECT job_id FROM mdf_recalculation_jobs WHERE source_kind='packet' AND source_id=$1
      AND status='pending' ORDER BY created_at,job_id LIMIT 1`,[packetId])).rows[0];
    expect(pendingManualJob).toBeDefined();
    expect(await runner().processOne()).toMatchObject({jobId:pendingManualJob.job_id});
  });
  it.each(['disabled_user','disabled_role','revoked_permission','inactive_permission','restricted_owner','none_scope',
    'session_lease','item_lease','source_hash','file_hash','frozen_source','read_only'] as const)('Telegram %s rejects without source or queue writes',async(kind)=>{
    const f=await telegramFixture(),before=await counts();let undo=async()=>{};
    const change=async(sql:string,restore:string)=>{await db.query(sql);undo=async()=>{await db.query(restore);};};
    if(kind==='disabled_user') await change('UPDATE users SET is_active=false WHERE user_id=1','UPDATE users SET is_active=true WHERE user_id=1');
    if(kind==='disabled_role') await change('UPDATE roles SET is_active=false WHERE role_id=1','UPDATE roles SET is_active=true WHERE role_id=1');
    if(kind==='revoked_permission') await change("UPDATE role_permissions SET is_enabled=false WHERE permission_name='cut.manage'","UPDATE role_permissions SET is_enabled=true WHERE permission_name='cut.manage'");
    if(kind==='inactive_permission') await change("UPDATE permissions_catalog SET is_active=false WHERE permission_name='orders.view'","UPDATE permissions_catalog SET is_active=true WHERE permission_name='orders.view'");
    if(kind==='restricted_owner' || kind==='none_scope') {
      await db.query('UPDATE orders SET created_by=999 WHERE order_id=$1',[f.orderId]);
      await change(`UPDATE role_policy_scopes SET scope_value='${kind==='none_scope'?'none':'own'}'`,"UPDATE role_policy_scopes SET scope_value='all'");
    }
    if(kind==='session_lease') f.input.lease.leaseToken=randomUUID();
    if(kind==='item_lease') f.input.completion.itemLeaseToken=randomUUID();
    if(kind==='source_hash') f.input.completion.source.svgContentSha256='a'.repeat(64);
    if(kind==='file_hash') f.input.completion.sourceFiles[0].base64Content=Buffer.from('bad bytes').toString('base64');
    if(kind==='frozen_source') await db.query("UPDATE cnc_telegram_import_items SET source_set_fingerprint='old' WHERE import_item_id=$1",[f.itemId]);
    if(kind==='read_only') await change("UPDATE mdf_engine_state SET mode='read_only'","UPDATE mdf_engine_state SET mode='active'");
    try {
      await expect(f.importer.completeImport(f.input)).rejects.toBeInstanceOf(ApiError);expect(await counts()).toEqual(before);
      expect((await db.query('SELECT status,packet_id FROM cnc_telegram_import_items WHERE import_item_id=$1',[f.itemId])).rows[0])
        .toEqual({status:'processing',packet_id:null});
    } finally {await undo();}
  });
  it('Telegram terminal replay reauthorizes frozen membership even when current source owners disappear',async()=>{
    const f=await telegramFixture();await f.importer.completeImport(f.input);const before=await counts();
    await db.query('UPDATE orders SET order_name=$2,created_by=999 WHERE order_id=$1',[f.orderId,`renamed-${f.orderId}`]);
    await db.query("UPDATE role_policy_scopes SET scope_value='own'");
    try {await expect(f.importer.completeImport(f.input)).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(await counts()).toEqual(before);}
    finally {await db.query("UPDATE role_policy_scopes SET scope_value='all'");}
    await runner().processOne();
  });
  it.each(['unknown_order','missing_position'] as const)('Telegram %s preserves known own members but publishes no confirmed quantity',async(kind)=>{
    const f=await telegramFixture(),layout=f.command.dto.cutLayout;
    layout.items.push({...layout.items[0],sourceElementId:'unknown',orderName:kind==='unknown_order'?'unknown-order':'',detailNumber:0});
    await db.query('UPDATE cnc_telegram_import_candidates SET cut_layout_json=$2::jsonb WHERE candidate_id=$1',[f.candidateId,JSON.stringify(layout)]);
    const result=await f.importer.completeImport(f.input),id=result.packetId!;
    expect((await db.query('SELECT accepted_revision_key FROM mdf_source_heads WHERE source_id=$1',[id])).rows[0].accepted_revision_key).toBeNull();
    expect((await db.query('SELECT detail_id,quantity FROM mdf_evidence_lines WHERE source_id=$1',[id])).rows)
      .toEqual([{detail_id:String(f.detailId),quantity:'2'}]);
    await runner().processOne();
    const board=await readMdfPublishedSnapshot(database,user,{focus:{kind:'packet',id}});
    expect(board.cards.some(c=>c.kind==='packet' && c.id===id)).toBe(true);
  });
  it('a forged direct intentional-copy policy cannot bypass the verified Telegram transaction',async()=>{
    const f=await svgFixture();f.command.dto.duplicatePolicy={kind:'intentional_copy',approvedByImportItemId:randomUUID()};
    const before=await counts();await expect(new PgCncTelegramRepository(database).manualSvgUpload(f.command))
      .rejects.toMatchObject({code:'CNC_TELEGRAM_DUPLICATE_APPROVAL_INVALID'});expect(await counts()).toEqual(before);
  });
  it('Telegram duplicate drift requires reconfirmation; acknowledged copy stays unaccepted',async()=>{
    const a=await telegramFixture(),original=await a.importer.completeImport(a.input);await runner().processOne();
    const b=await telegramFixture();
    await db.query(`UPDATE cnc_telegram_import_candidates c SET svg_content_sha256=s.svg_content_sha256,
      svg_file_name=s.svg_file_name,cut_layout_json=s.cut_layout_json,source_set_fingerprint=s.source_set_fingerprint
      FROM cnc_telegram_import_candidates s WHERE c.candidate_id=$1 AND s.candidate_id=$2`,[b.candidateId,a.candidateId]);
    b.input.completion.source.svgContentSha256=a.input.completion.source.svgContentSha256;
    b.input.completion.source.svgFileName=a.input.completion.source.svgFileName;
    b.input.completion.sourceSetFingerprint=a.input.completion.sourceSetFingerprint;
    b.input.completion.sourceFiles=a.input.completion.sourceFiles;
    await db.query('UPDATE cnc_telegram_import_items SET source_set_fingerprint=$2 WHERE import_item_id=$1',
      [b.itemId,a.input.completion.sourceSetFingerprint]);
    const before=await counts();expect(await b.importer.completeImport(b.input)).toMatchObject({status:'confirmation_required'});
    expect((await counts()).receipts).toBe(before.receipts);
    await db.query(`UPDATE cnc_telegram_import_items SET duplicate_acknowledged=true,status='processing',
      lease_token=$2,lease_worker_instance_id=$3,lease_expires_at=now()+interval '1 hour' WHERE import_item_id=$1`,
      [b.itemId,b.input.completion.itemLeaseToken,b.input.completion.itemLeaseOwner]);
    const copy=await b.importer.completeImport(b.input),id=copy.packetId!;
    expect(id).not.toBe(original.packetId);
    expect((await db.query('SELECT accepted_revision_key FROM mdf_source_heads WHERE source_id=$1',[id])).rows[0].accepted_revision_key).toBeNull();
    expect((await db.query('SELECT rework FROM cnc_telegram_packets WHERE packet_id=$1',[id])).rows[0].rework).toBe(false);
    await runner().processOne();
    const board=await readMdfPublishedSnapshot(database,user,{focus:{kind:'packet',id}});
    expect(board.cards.find(c=>c.kind==='packet' && c.id===id)?.issues.length).toBeGreaterThan(0);
  });
  it.each(['layout','owner'] as const)('Telegram %s drift while waiting for domain lock rejects the stale preflight',async(kind)=>{
    const f=await telegramFixture(),before=await counts();
    await db.query('BEGIN');await db.query('SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE',[f.orderId]);
    let observed!:()=>void;const waiting=new Promise<void>(resolve=>{observed=resolve;});
    onQuery=sql=>{if(sql.includes('SELECT o.order_id FROM orders o') && sql.includes('FOR UPDATE')) observed();};
    const pending=f.importer.completeImport(f.input);const assertion=expect(pending).rejects.toMatchObject({code:'CNC_TELEGRAM_SOURCE_CHANGED'});
    try {
      await waiting;
      if(kind==='layout') await db.query(`UPDATE cnc_telegram_import_candidates SET cut_layout_json=jsonb_set(cut_layout_json,'{items,0,widthMm}','111') WHERE candidate_id=$1`,[f.candidateId]);
      else await db.query('UPDATE orders SET order_name=$2 WHERE order_id=$1',[f.orderId,`changed-${f.orderId}`]);
      await db.query('COMMIT');await assertion;expect(await counts()).toEqual(before);
    } finally {onQuery=undefined;await db.query('ROLLBACK');}
  });
  it.each(['filename','HDF'] as const)('Telegram %s is imported without MDF credit',async(kind)=>{
    const f=await telegramFixture(),before=await counts();
    if(kind==='filename') {
      const name=`fanera-${f.orderId}.svg`;f.input.completion.source.svgFileName=name;f.input.completion.sourceFiles[0].fileName=name;
      await db.query('UPDATE cnc_telegram_import_candidates SET svg_file_name=$2 WHERE candidate_id=$1',[f.candidateId,name]);
    } else await db.query('UPDATE order_details SET sheet_material_type_id=3 WHERE detail_id=$1',[f.detailId]);
    expect(await f.importer.completeImport(f.input)).toMatchObject({status:'imported'});
    expect((await counts()).receipts).toBe(before.receipts);expect((await counts()).jobs).toBe(before.jobs);
  });
  it('Telegram queued rule failure preserves the completed import; retry advances only its own detail once',async()=>{
    const f=await telegramFixture();
    await db.query(`INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
      VALUES(19,'E2E Telegram present','mdf.order_machine_files_present','change_details_production_status',2,'{}',100,true,1,'{}')`);
    const result=await f.importer.completeImport(f.input),id=result.packetId!;
    await db.query(`CREATE FUNCTION e2e_telegram_fail_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'E2E Telegram rule failure'; END $$;
      CREATE TRIGGER e2e_telegram_fail_rule BEFORE UPDATE ON order_details FOR EACH ROW EXECUTE FUNCTION e2e_telegram_fail_rule()`);
    try {
      expect(await runner().processOne()).toMatchObject({status:'retry'});
      expect((await db.query('SELECT status,packet_id FROM cnc_telegram_import_items WHERE import_item_id=$1',[f.itemId])).rows[0])
        .toEqual({status:'imported',packet_id:id});
      expect((await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[f.orderId])).rows)
        .toEqual([{production_status_id:1},{production_status_id:1}]);
    } finally {await db.query('DROP TRIGGER e2e_telegram_fail_rule ON order_details; DROP FUNCTION e2e_telegram_fail_rule()');}
    try {
      await db.query('UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE source_id=$1',[id]);
      expect(await runner().processOne()).toMatchObject({status:'done'});
      expect((await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[f.orderId])).rows)
        .toEqual([{production_status_id:2},{production_status_id:1}]);
      const before=await counts();await f.importer.completeImport(f.input);expect(await counts()).toEqual(before);
    } finally {await db.query('DELETE FROM status_automation_rules WHERE id=19');}
  });
  it('failed SVG queued rule preserves intake; retry applies once',async()=>{
    const f=await svgFixture();
    await db.query(`INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
      VALUES(19,'E2E SVG retry','mdf.order_machine_files_present','change_details_production_status',2,'{}',100,true,1,'{}');
      CREATE FUNCTION e2e_svg_fail_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'E2E rule failure'; END $$;
      CREATE TRIGGER e2e_svg_fail_rule BEFORE UPDATE ON order_details FOR EACH ROW EXECUTE FUNCTION e2e_svg_fail_rule()`);
    try {
      const id=(await new PgCncTelegramRepository(database).manualSvgUpload(f.command)).packet.packetId,before=await counts();
      expect(await runner().processOne()).toMatchObject({status:'retry'});
      expect((await counts()).receipts).toBe(before.receipts);
      expect((await db.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0].production_status_id).toBe(1);
      await db.query('DROP TRIGGER e2e_svg_fail_rule ON order_details');
      await db.query('UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE source_id=$1',[id]);
      expect(await runner().processOne()).toMatchObject({status:'done'});
      expect((await db.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0].production_status_id).toBe(2);
    } finally { await db.query('DROP TRIGGER IF EXISTS e2e_svg_fail_rule ON order_details; DROP FUNCTION e2e_svg_fail_rule(); DELETE FROM status_automation_rules WHERE id=19'); }
  });
  async function assertSettled(job:number,commandId:string,code:string,before:Awaited<ReturnType<typeof counts>>) {
    const after=await counts(); expect(after).toMatchObject({ results:before.results,receipts:before.receipts,jobs:before.jobs });
    expect(Number(after.audits)).toBe(Number(before.audits)+1); expect(Number(after.outbox)).toBe(Number(before.outbox)+1);
    expect((await db.query('SELECT status FROM cut_job WHERE cut_job_id=$1',[job])).rows[0].status).toBe('draft');
    expect((await db.query('SELECT status,owner_token,failure_code FROM cut_result_command WHERE cut_job_id=$1 AND command_id=$2',[job,commandId])).rows[0])
      .toEqual({ status:'failed',owner_token:null,failure_code:code });
    expect((await db.query('SELECT event,metadata_json FROM audit_log WHERE entity_type=$1 AND entity_id=$2',['cut_job',String(job)])).rows[0])
      .toMatchObject({ event:'cut_job.calculate_rejected',metadata_json:{ code,commandId } });
  }

  it.each([1,2])('actual calculation material %s commits membership, audit and outbox once; worker publishes without physical credit',async material=>{
    const f=await fixture(material),command=f.command();
    await repository.calculate(command);
    const id=await resultId(f.cutJobId),sourceId=`cut-result:${id}`,before=await counts();
    await repository.calculate(command); expect(await counts()).toEqual(before);
    expect((await db.query('SELECT stage_code,evidence_kind,quantity FROM mdf_evidence_lines WHERE source_id=$1',[sourceId])).rows)
      .toEqual([{ stage_code: 'membership',evidence_kind: 'derived',quantity: '2' }]);
    expect((await db.query("SELECT metadata_json->>'mdfJobId' job FROM audit_log WHERE event='cut_job.calculated' AND entity_id=$1",[String(f.cutJobId)])).rows[0]?.job)
      .toEqual(expect.any(String));
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    const board=await readMdfPublishedSnapshot(database,user,{ focus: { kind: 'bath',id: sourceId } });
    expect(board.cards.find(c=>c.kind==='bath' && c.id===sourceId)).toMatchObject({ column: 'baths',issues: [],acceptedRevision: `bath-created:${id}` });
    expect((await db.query('SELECT credited_cut,credited_rolled FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({ credited_cut: '0',credited_rolled: '0' });
    expect((await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[f.orderId])).rows)
      .toEqual([{ production_status_id: 1 },{ production_status_id: 1 }]);
    expect((await db.query('SELECT count(*) FROM cnc_telegram_packets WHERE svg_cut_result_id=$1',[id])).rows[0].count).toBe('0');
  });
  it.each([3,4])('non-MDF material %s keeps the calculated result but creates no MDF receipt',async material=>{
    const f=await fixture(material),before=await counts(); await repository.calculate(f.command());
    expect((await counts()).receipts).toBe(before.receipts);
  });
  it('ordinary non-vacuum calculation creates no bath',async()=>{
    const f=await fixture(1,false),before=await counts(); await repository.calculate(f.command()); expect((await counts()).receipts).toBe(before.receipts);
  });
  it('recalculation quarantines new membership and preserves the old accepted source',async()=>{
    const f=await fixture(),command=f.command(); await repository.calculate(command); await runner().processOne();
    const old=await resultId(f.cutJobId);
    const version=Number((await db.query('SELECT version FROM cut_job WHERE cut_job_id=$1',[f.cutJobId])).rows[0].version);
    await repository.calculate({ ...command,commandId: randomUUID(),version });
    const id=await resultId(f.cutJobId); expect(id).not.toBe(old);
    expect((await db.query("SELECT accepted_revision_key FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1",[`cut-result:${id}`])).rows[0].accepted_revision_key).toBeNull();
    expect((await db.query("SELECT accepted_revision_key FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1",[`cut-result:${old}`])).rows[0].accepted_revision_key).toBe(`bath-created:${old}`);
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    const board=await readMdfPublishedSnapshot(database,user,{ focus: { kind: 'bath',id: `cut-result:${id}` } });
    expect(board.cards.find(c=>c.id===`cut-result:${id}`)?.issues.length).toBeGreaterThan(0);
  });
  it('replay reauthorizes frozen result owners after the current basket is empty',async()=>{
    const f=await fixture(),command=f.command(); await repository.calculate(command); await runner().processOne();
    await db.query('UPDATE cut_job_item SET is_active=false WHERE cut_job_id=$1',[f.cutJobId]);
    await db.query('UPDATE orders SET created_by=999 WHERE order_id=$1',[f.orderId]);
    const base=rolePolicyForUser(user),restricted={ ...user,policyScopes: { ...base,orders: { ...base.orders,view: 'own' as const } } };
    const before=await counts(); await expect(repository.calculate({ ...command,currentUser: restricted })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await counts()).toEqual(before);
  });
  it('detail changes during freecut reject persistence without a failed-job mutation or receipt',async()=>{
    const f=await fixture(),before=await counts(),command=f.command();
    duringOptimize=async()=>{ await db.query('UPDATE order_details SET quantity=7 WHERE detail_id=$1',[f.detailId]); };
    try { await expect(repository.calculate(command)).rejects.toMatchObject({ code: 'MDF_CUT_SCOPE_CHANGED' }); }
    finally { duringOptimize=undefined; }
    await assertSettled(f.cutJobId,command.commandId,'MDF_CUT_SCOPE_CHANGED',before);
  });
  it('read-only rejection precedes every domain write and never marks calculation failed',async()=>{
    const f=await fixture(),before=await counts(); await db.query("UPDATE mdf_engine_state SET mode='read_only'");
    try { await expect(repository.calculate(f.command())).rejects.toMatchObject({ code: 'MDF_ENGINE_READ_ONLY' }); }
    finally { await db.query("UPDATE mdf_engine_state SET mode='active'"); }
    expect(await counts()).toEqual(before);
    expect((await db.query('SELECT status FROM cut_job WHERE cut_job_id=$1',[f.cutJobId])).rows[0].status).toBe('draft');
  });
  it('real BASIS cut supply readies the new bath; lamination updates only its own position',async()=>{
    const f=await fixture(); await repository.calculate(f.command()); await runner().processOne();
    const bathId=`cut-result:${await resultId(f.cutJobId)}`;
    const set=await new PgBazisCutRepository(database).create({ currentUser:user,orderId:f.orderId,detailIds:[f.detailId],
      idempotencyKey:`E2E-${randomUUID()}`,requestId:'E2E real cutting supply' });
    await runner().processOne();
    const mover=new PgMdfBoardManualMoveRepository(database);
    const actor={ ...user,permissions:[...user.permissions,'orders.update','production.tasks.update','orders.change_production_status'] } as CurrentUser;
    const setId=String(set.set.bazisCutSetId);
    const setBoard=await readMdfPublishedSnapshot(database,user,{ focus:{ kind:'bazisCutSet',id:setId } });
    await mover.upsert({ currentUser:actor,cardKind:'bazisCutSet',cardId:setId,targetColumn:'completed',
      sourceToken:setBoard.cards.find(c=>c.kind==='bazisCutSet' && c.id===setId)!.commandToken!,idempotencyKey:`E2E-${randomUUID()}`,requestId:'E2E cut supply' });
    expect(await runner().processOne()).toMatchObject({ status:'done' });
    const board=await readMdfPublishedSnapshot(database,user,{ focus:{ kind:'bath',id:bathId } });
    const bath=board.cards.find(c=>c.kind==='bath' && c.id===bathId)!; expect(bath.column).toBe('baths_ready');
    await mover.upsert({ currentUser:actor,cardKind:'bath',cardId:bathId,targetColumn:'baths_laminated',sourceToken:bath.commandToken!,
      idempotencyKey:`E2E-${randomUUID()}`,requestId:'E2E own bath lamination' });
    expect(await runner().processOne()).toMatchObject({ status:'done' });
    expect((await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',[f.orderId])).rows)
      .toEqual([{ production_status_id:4 },{ production_status_id:1 }]);
    expect((await db.query('SELECT credited_cut,credited_rolled FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({ credited_cut:'0',credited_rolled:'2' }); // Exclusive stage counters: rolled leaves the cut-only bucket.
  });
  it.each(['legacy','active'])('typed-HDF calculation in %s saves exact projection without MDF evidence',async mode=>{
    const f=await fixture();
    await db.query(`INSERT INTO order_hdf_details(order_hdf_detail_id,order_id,hdf_sheet_material_name,hdf_sheet_material_type_id,
      source_detail_number,source_detail_name,hdf_height_mm,hdf_width_mm,quantity,delete_flag,status,config_revision)
      VALUES($1,$1,'MDF 10 mm',1,1,'E2E typed HDF',200,100,2,false,'ok',1)`,[f.orderId]);
    await db.query(`UPDATE cut_job_item SET source_type='order_hdf_detail',order_hdf_detail_id=$2,order_detail_id=NULL,
      freecut_item_id=$3 WHERE cut_job_id=$1`,[f.cutJobId,f.orderId,`hdf-${f.orderId}`]);
    const before=await counts(); await db.query('UPDATE mdf_engine_state SET mode=$1',[mode]);
    try { await repository.calculate(f.command()); }
    finally { await db.query("UPDATE mdf_engine_state SET mode='active'"); }
    const id=await resultId(f.cutJobId);
    expect((await db.query('SELECT item_id,order_detail_id,order_hdf_detail_id FROM cut_result_placement WHERE cut_result_id=$1',[id])).rows)
      .toEqual(Array.from({length:2},()=>({item_id:`hdf-${f.orderId}`,order_detail_id:null,order_hdf_detail_id:String(f.orderId)})));
    expect((await db.query('SELECT cut_result_snapshot_is_complete(snapshot_job,snapshot_manifest,snapshot_digest) valid FROM cut_result WHERE cut_result_id=$1',[id])).rows[0].valid).toBe(true);
    expect((await counts()).receipts).toBe(before.receipts);
  });
  it('mixed MDF/HDF with the same numeric ID publishes only ordinary MDF membership',async()=>{
    const f=await fixture();
    await db.query(`INSERT INTO order_hdf_details(order_hdf_detail_id,order_id,hdf_sheet_material_name,hdf_sheet_material_type_id,
      source_detail_number,source_detail_name,hdf_height_mm,hdf_width_mm,quantity,delete_flag,status,config_revision)
      VALUES($1,$2,'MDF 10 mm',1,1,'E2E typed HDF collision',200,100,2,false,'ok',1)`,[f.detailId,f.orderId]);
    await db.query(`INSERT INTO cut_job_item(cut_job_id,source_type,order_id,order_hdf_detail_id,freecut_item_id,qty,is_active)
      VALUES($1,'order_hdf_detail',$2,$3,$4,2,true)`,[f.cutJobId,f.orderId,f.detailId,`hdf-${f.detailId}`]);
    await repository.calculate(f.command());const id=await resultId(f.cutJobId),sourceId=`cut-result:${id}`;
    expect((await db.query('SELECT item_id,order_detail_id,order_hdf_detail_id FROM cut_result_placement WHERE cut_result_id=$1 ORDER BY item_id,instance',[id])).rows)
      .toEqual([...Array.from({length:2},()=>({item_id:`det-${f.detailId}`,order_detail_id:String(f.detailId),order_hdf_detail_id:null})),
        ...Array.from({length:2},()=>({item_id:`hdf-${f.detailId}`,order_detail_id:null,order_hdf_detail_id:String(f.detailId)}))]);
    expect((await db.query('SELECT line_key,detail_id,quantity FROM mdf_evidence_lines WHERE source_id=$1',[sourceId])).rows)
      .toEqual([{line_key:`det-${f.detailId}`,detail_id:String(f.detailId),quantity:'2'}]);
    expect(await runner().processOne()).toMatchObject({status:'done'});
    expect((await db.query('SELECT credited_cut,credited_rolled,remaining FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({credited_cut:'0',credited_rolled:'0',remaining:'2'});
  });
  it('a position split across baths is valid membership, never full-order readiness',async()=>{
    const f=await fixture(); await db.query('UPDATE order_details SET quantity=4 WHERE detail_id=$1',[f.detailId]);
    await repository.calculate(f.command()); expect(await runner().processOne()).toMatchObject({ status:'done' });
    const id=await resultId(f.cutJobId),sourceId=`cut-result:${id}`;
    expect((await db.query('SELECT quantity FROM mdf_evidence_lines WHERE source_id=$1',[sourceId])).rows).toEqual([{ quantity:'2' }]);
    expect((await db.query('SELECT quantity FROM mdf_revision_demand WHERE source_id=$1 AND detail_id=$2',[sourceId,f.detailId])).rows).toEqual([{ quantity:'4' }]);
    expect((await db.query('SELECT credited_cut,credited_rolled,remaining FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0])
      .toEqual({ credited_cut:'0',credited_rolled:'0',remaining:'4' });
  });
  it('mixed-owner denial is atomic and happens before external calculation',async()=>{
    const a=await fixture(),b=await fixture();
    await db.query(`UPDATE cut_job_item SET cut_job_id=$1 WHERE cut_job_id=$2`,[a.cutJobId,b.cutJobId]);
    await db.query('UPDATE orders SET created_by=999 WHERE order_id=$1',[b.orderId]);
    const base=rolePolicyForUser(user),restricted={ ...user,policyScopes:{ ...base,orders:{ ...base.orders,view:'own' as const } } };
    const before=await counts(); duringOptimize=async()=>{ throw new Error('Must not call Freecut'); };
    try { await expect(repository.calculate({ ...a.command(),currentUser:restricted })).rejects.toMatchObject({ code:'PERMISSION_DENIED' }); }
    finally { duringOptimize=undefined; }
    expect(await counts()).toEqual(before);
    expect((await db.query('SELECT status FROM cut_job WHERE cut_job_id=$1',[a.cutJobId])).rows[0].status).toBe('draft');
  });
  it('receipt storage failure rolls back result, successful audit, outbox and job',async()=>{
    const f=await fixture(),before=await counts();
    await db.query(`CREATE FUNCTION e2e_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'E2E receipt failure'; END $$;
      CREATE TRIGGER e2e_reject_receipt BEFORE INSERT ON mdf_evidence_revisions FOR EACH ROW EXECUTE FUNCTION e2e_reject_receipt()`);
    try { await expect(repository.calculate(f.command())).rejects.toMatchObject({ code:'CUT_CALCULATE_FAILED' }); }
    finally { await db.query('DROP TRIGGER e2e_reject_receipt ON mdf_evidence_revisions'); }
    const after=await counts(); expect(after).toMatchObject({ results:before.results,receipts:before.receipts,jobs:before.jobs,outbox:before.outbox });
    expect((await db.query('SELECT event FROM audit_log WHERE entity_type=$1 AND entity_id=$2',['cut_job',String(f.cutJobId)])).rows)
      .toEqual([{ event:'cut_job.calculate_failed' }]);
  });
  it('incomplete projection rejects the result atomically without marking the job failed',async()=>{
    const f=await fixture(),before=await counts(),command=f.command();
    await db.query(`CREATE FUNCTION e2e_incomplete_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE cut_result_label_map_projection SET placement_count=placement_count+1 WHERE cut_result_id=NEW.cut_result_id; RETURN NEW; END $$;
      CREATE TRIGGER z_e2e_incomplete_projection AFTER INSERT ON cut_result FOR EACH ROW EXECUTE FUNCTION e2e_incomplete_projection()`);
    try { await expect(repository.calculate(command)).rejects.toMatchObject({ code:'MDF_CUT_SOURCE_INVALID' }); }
    finally { await db.query('DROP TRIGGER z_e2e_incomplete_projection ON cut_result'); }
    await assertSettled(f.cutJobId,command.commandId,'MDF_CUT_SOURCE_INVALID',before);
  });
  it.each([false,true])('read_only during external calculation settles only the owned lease, optimizer failure=%s',async optimizerFails=>{
    const f=await fixture(),command=f.command(),before=await counts();
    duringOptimize=async()=>{
      await db.query(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('mdf-engine-cutover',0));
        UPDATE mdf_engine_state SET mode='read_only'; COMMIT`);
      if(optimizerFails) throw new ApiError(504,'FREECUT_TIMEOUT','E2E original timeout');
    };
    const code=optimizerFails?'FREECUT_TIMEOUT':'MDF_ENGINE_READ_ONLY';
    try { await expect(repository.calculate(command)).rejects.toMatchObject({ code }); }
    finally { duringOptimize=undefined; await db.query("UPDATE mdf_engine_state SET mode='active'"); }
    await assertSettled(f.cutJobId,command.commandId,code,before);
    expect((await db.query('SELECT count(*) FROM cut_group WHERE cut_job_id=$1',[f.cutJobId])).rows[0].count).toBe('0');
  });
  it('settlement cannot close another executor owner token',async()=>{
    const f=await fixture(),command=f.command(),before=await counts(),otherToken=randomUUID();
    duringOptimize=async()=>{ await db.query('UPDATE cut_result_command SET owner_token=$2 WHERE cut_job_id=$1',[f.cutJobId,otherToken]); };
    try { await expect(repository.calculate(command)).rejects.toMatchObject({ code:'CUT_RESULT_COMMAND_ABANDONED' }); }
    finally { duringOptimize=undefined; }
    expect(await counts()).toEqual(before);
    expect((await db.query('SELECT owner_token,status FROM cut_result_command WHERE cut_job_id=$1',[f.cutJobId])).rows[0])
      .toEqual({ owner_token:otherToken,status:'in_progress' });
  });
  it('detail writer racing owner acquisition causes a Phase 1 rejection, not a manufactured failure',async()=>{
    const f=await fixture(),before=await counts(); await db.query('BEGIN');
    await db.query('UPDATE order_details SET quantity=5 WHERE detail_id=$1',[f.detailId]);
    let timer:ReturnType<typeof setTimeout>|undefined;
    const reached=new Promise<void>((resolve,reject)=>{ timer=setTimeout(()=>reject(new Error('E2E detail lock not reached')),2500);
      onQuery=sql=>{ if(sql.includes('SELECT detail_id FROM order_details') && sql.includes('FOR UPDATE')) resolve(); }; });
    const pending=repository.calculate(f.command()); const assertion=expect(pending).rejects.toMatchObject({ code:'MDF_CUT_SCOPE_CHANGED' });
    try { await reached; await db.query('COMMIT'); await assertion; }
    finally { clearTimeout(timer); onQuery=undefined; await db.query('ROLLBACK'); await pending.catch(()=>undefined); }
    expect(await counts()).toEqual(before);
    expect((await db.query('SELECT status FROM cut_job WHERE cut_job_id=$1',[f.cutJobId])).rows[0].status).toBe('draft');
  });
  it('worker failure cannot erase the committed calculated result; retry publishes it',async()=>{
    const f=await fixture(); await repository.calculate(f.command()); const id=await resultId(f.cutJobId);
    const failed=new MdfJobRunner(database,async()=>{ throw new Error('E2E executor unavailable'); });
    expect(await failed.processOne()).toMatchObject({ status:'retry' });
    expect(await resultId(f.cutJobId)).toBe(id);
    await db.query("UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE source_kind='bath' AND source_id=$1",[`cut-result:${id}`]);
    expect(await runner().processOne()).toMatchObject({ status:'done' });
  });
});
