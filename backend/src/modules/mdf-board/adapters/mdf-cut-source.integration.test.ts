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
import { PgCncTelegramMediaRepository } from '../../cnc-telegram/adapters/pg-cnc-telegram-media-repository';
import { PgCncTelegramMdfObservationRepository } from '../../cnc-telegram/adapters/pg-cnc-telegram-mdf-observation-repository';
import { PgCncManualSendObservationRegistration } from '../../cnc-telegram/adapters/pg-cnc-manual-send-observation-registration';
import type { ManualSvgUploadCommand } from '../../cnc-telegram/application/cnc-telegram.types';
import { PgMdfBoardManualMoveRepository } from '../../orders/adapters/pg-mdf-board-manual-move-repository';
import { StaticCutConfig } from '../../cut/application/cut-config';
import type { OptimizeRequest, FreecutOptimizeResponse } from '../../cut/application/cut-freecut-mapping';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { recordMdfLineageReceipt, recordMdfReceipt, type MdfReceiptLine } from '../application/mdf-receipt';
import type { MdfPhysicalLineageManifest } from '../application/mdf-physical-lineage';
import type { MdfExecutionContext } from '../domain/mdf-execution-context';
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
  async function processJob(jobId: string) {
    for (let attempt=0;attempt<10;attempt++) {
      const result=await runner().processOne();
      if (result.jobId===jobId) { expect(result).toMatchObject({status:'done'}); return result; }
      expect(result.status).not.toBe('idle');
    }
    throw new Error('E2E_EXPECTED_MDF_JOB_NOT_PROCESSED');
  }
  const databaseWithQueryHook=(hook:(sql:string)=>Promise<void>|void)=>({
    transaction:(work:any,options:any)=>database.transaction(async tx=>{
      const original=tx.query.bind(tx);
      tx.query=async(...args:any[])=>{
        const sql=typeof args[0]==='string'?args[0]:String(args[0]?.text??'');
        await hook(sql);
        return original(args[0],args[1],args[2]);
      };
      try { return await work(tx); }
      finally { tx.query=original; }
    },options),
  }) as any;
  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true'); vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE','false');
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE','true'); vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH','true');
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql','174_mdf_execution_context.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql', '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql']) {
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
    await db.query(`ALTER TABLE cnc_manual_svg_telegram_send_requests ADD PRIMARY KEY(request_id);
      CREATE UNIQUE INDEX e2e_manual_upload_kind ON cnc_manual_svg_upload_files(packet_id,file_kind);
      CREATE UNIQUE INDEX e2e_manual_send_key ON cnc_manual_svg_telegram_send_requests(send_idempotency_key);
      CREATE UNIQUE INDEX e2e_manual_send_active ON cnc_manual_svg_telegram_send_requests(packet_id)
        WHERE status IN ('pending','processing');
      ALTER TABLE cnc_manual_svg_telegram_send_request_files ADD PRIMARY KEY(request_id,file_id);
      CREATE UNIQUE INDEX e2e_manual_send_order ON cnc_manual_svg_telegram_send_request_files(request_id,send_order)`);
    await db.query(readFileSync(new URL('../../../../db/migrations/181_cnc_manual_send_observation.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL('../../../../db/migrations/182_mdf_physical_lineage.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL('../../../../db/migrations/185_mdf_bazis_composition.sql',import.meta.url),'utf8'));
    const expectedLocal = ['bazis_cut_set_details','bazis_cut_sets','mdf_bazis_assignment_states','mdf_bazis_composition_intents'];
    expect((await db.query<{relname:string}>(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY c.relname`,[schema,expectedLocal]))
      .rows.map(r=>r.relname)).toEqual(expectedLocal);
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
  async function manualSvgSendFixture(quantity=2) {
    const f=await svgFixture(quantity),svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!-- e2e-${f.orderId} --></svg>`),
      gcode=Buffer.from(`G0 X${f.orderId} Y0\n`),
      image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aekAAAAASUVORK5CYII=','base64');
    const file=(kind:'svg'|'gcode'|'screenshot',fileName:string,contentType:string,bytes:Buffer)=>({
      kind,fileName,contentType,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
      base64Content:bytes.toString('base64'),
    });
    f.command.dto.svgContentHash=createHash('sha256').update(svg).digest('hex');
    f.command.dto.requestedCutJobId=30000+f.orderId;
    f.command.dto.telegramSend={enabled:true,message:`E2E send ${f.orderId}`};
    f.command.dto.sourceFiles=[file('svg',`E2E-${f.orderId}.svg`,'image/svg+xml',svg),
      file('gcode',`E2E-${f.orderId}.nc`,'text/plain',gcode),file('screenshot',`E2E-${f.orderId}.png`,'image/png',image)];
    f.command.telegramDestinationChatId=`-100${30000+f.orderId}`;
    const worker=randomUUID(),leaseToken=`session-${randomUUID()}-${randomUUID()}`;
    await db.query(`INSERT INTO cnc_telegram_worker_session_leases(source_chat_id,lease_token,lease_generation,
      worker_instance_id,worker_image_revision,expires_at) VALUES($1,$2,1,$3,'abcdef1',now()+interval '1 hour')`,
      [f.command.telegramDestinationChatId,leaseToken,worker]);
    return {...f,worker,sessionLease:{sourceChatId:f.command.telegramDestinationChatId,leaseToken,leaseGeneration:1,workerInstanceId:worker}};
  }
  async function claimManualSvgSend() {
    const f=await manualSvgSendFixture(),uploaded=await new PgCncTelegramRepository(database).manualSvgUpload(f.command);
    if (!uploaded.telegramSendRequestId) throw new Error('E2E_MANUAL_SEND_REQUEST_MISSING');
    expect(uploaded.telegramSendStatus).toBe('pending');
    expect(await runner().processOne()).toMatchObject({status:'done'});
    const media=new PgCncTelegramMediaRepository(database);
    const [task]=await media.claimManualSvgTelegramSends({currentUser:user,limit:1,requestTraceId:'E2E manual send claim',sessionLease:f.sessionLease});
    if (!task) throw new Error('E2E_MANUAL_SEND_TASK_MISSING');
    return {f,uploaded,media,task};
  }
  function manualSendCompletion(task:any, mediaSha256?:(kind:string)=>string) {
    const idsByKind:Record<string,string>={svg:'7002',gcode:'7001',screenshot:'7003'};
    const sentFiles=[...task.files].reverse().map((file:any)=>({fileId:file.fileId,messageId:idsByKind[file.kind],
        sourceSha256:file.sha256,mediaSha256:mediaSha256?.(file.kind)??file.sha256})),
      sentMessageIds=[...new Set([...sentFiles.map((file:any)=>file.messageId),'7999'])].sort((a,b)=>Number(a)-Number(b));
    return {sentChatId:task.destinationChatId,sentMessageIds,
      sentFiles,
      itemLeaseToken:task.itemLeaseToken,itemLeaseGeneration:task.itemLeaseGeneration,itemLeaseOwner:task.itemLeaseOwner};
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
  it('manual SVG send freezes exact requested files and settles explicit non-positional media bindings',async()=>{
    const {f,uploaded,media,task}=await claimManualSvgSend();
    expect(task).toMatchObject({requestId:uploaded.telegramSendRequestId,observationBindingVersion:1,
      destinationChatId:f.command.telegramDestinationChatId,files:[
        expect.objectContaining({kind:'svg'}),expect.objectContaining({kind:'gcode'}),expect.objectContaining({kind:'screenshot'}),
      ]});
    const expectedByKind=Object.fromEntries(task.files.map(file=>[file.kind,file]));
    const completion=manualSendCompletion(task,kind=>kind==='screenshot'?'f'.repeat(64):
      task.files.find(file=>file.kind===kind)!.sha256);
    await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion,
      requestTraceId:'E2E manual send complete',sessionLease:f.sessionLease});
    const saved=(await db.query(`SELECT s.files_qualified,s.source_eligible,s.files_snapshot,w.work_state,w.reason,
      b.sent_chat_id,b.transport_message_ids,b.sent_files,b.binding_error
      FROM cnc_manual_svg_observation_claim_snapshots s
      JOIN cnc_manual_svg_observation_send_bindings b USING(send_request_id,lease_generation)
      JOIN cnc_manual_svg_observation_registration_work w USING(send_request_id,lease_generation)
      WHERE s.send_request_id=$1 AND s.lease_generation=$2`,[task.requestId,task.itemLeaseGeneration])).rows[0];
    expect(saved).toMatchObject({files_qualified:true,source_eligible:true,work_state:'pending',reason:null,
      sent_chat_id:f.command.telegramDestinationChatId,binding_error:null});
    expect(saved.transport_message_ids).toEqual(completion.sentMessageIds);
    expect(saved.files_snapshot).toHaveLength(3);
    expect(saved.files_snapshot.map((file:any)=>file.kind)).toEqual(['svg','gcode','screenshot']);
    expect(saved.files_snapshot.map((file:any)=>file.fileId)).toEqual(task.files.map(file=>file.fileId));
    expect(saved.sent_files.map((file:any)=>file.fileId)).toEqual(task.files.map(file=>file.fileId));
    expect(saved.sent_files.map((file:any)=>file.messageId)).toEqual(['7002','7001','7003']);
    expect(saved.sent_files.find((file:any)=>file.fileId===expectedByKind.screenshot.fileId))
      .toMatchObject({sourceSha256:expectedByKind.screenshot.sha256,mediaSha256:'f'.repeat(64)});
    const completedAuditCount=Number((await db.query(`SELECT count(*)::text count FROM audit_log
      WHERE event='cnc.manual_svg_upload.telegram_send_completed' AND entity_id=$1`,[task.requestId])).rows[0].count);
    expect(completedAuditCount).toBe(1);
    await expect(media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion,
      requestTraceId:'E2E exact send replay',sessionLease:f.sessionLease})).resolves.toMatchObject({status:'sent'});
    expect(Number((await db.query(`SELECT count(*)::text count FROM audit_log
      WHERE event='cnc.manual_svg_upload.telegram_send_completed' AND entity_id=$1`,[task.requestId])).rows[0].count))
      .toBe(completedAuditCount);
    await expect(media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,
      completion:{...completion,sentFiles:completion.sentFiles.map((file,index)=>index===0?{...file,sourceSha256:'a'.repeat(64)}:file)},
      requestTraceId:'E2E conflicting send replay',sessionLease:f.sessionLease}))
      .rejects.toMatchObject({code:'CNC_TELEGRAM_SEND_COMPLETION_CONFLICT'});

    // The upload row is mutable/reusable; neither frozen claim data nor actual
    // transport bindings may be reconstructed from this later state.
    const overwritten=await db.query(`UPDATE cnc_manual_svg_upload_files SET content_sha256=$2,size_bytes=1,content_bytes=decode($3,'hex')
      WHERE packet_id=$1`,[uploaded.packet.packetId,'e'.repeat(64),'00']);
    expect(overwritten.rowCount).toBe(3);
    expect((await db.query('SELECT count(*)::int count FROM cnc_manual_svg_upload_files WHERE packet_id=$1 AND content_sha256=$2',
      [uploaded.packet.packetId,'e'.repeat(64)])).rows[0].count).toBe(3);
    const afterOverwrite=(await db.query(`SELECT s.files_snapshot,b.sent_files
      FROM cnc_manual_svg_observation_claim_snapshots s JOIN cnc_manual_svg_observation_send_bindings b
      USING(send_request_id,lease_generation) WHERE s.send_request_id=$1 AND s.lease_generation=$2`,
      [task.requestId,task.itemLeaseGeneration])).rows[0];
    expect(afterOverwrite.files_snapshot).toEqual(saved.files_snapshot);
    expect(afterOverwrite.sent_files).toEqual(saved.sent_files);
  });
  it('registers a durable settled snapshot after worker restart before the independent CNC observation claim',async()=>{
    const {f,uploaded,media,task}=await claimManualSvgSend();
    const completion=manualSendCompletion(task,kind=>kind==='screenshot'?'f'.repeat(64):
      task.files.find(file=>file.kind===kind)!.sha256);
    await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion,
      requestTraceId:'E2E manual send before observer',sessionLease:f.sessionLease});
    expect((await db.query(`SELECT count(*)::int count FROM mdf_cnc_observation_targets WHERE packet_id=$1`,
      [uploaded.packet.packetId])).rows[0].count).toBe(0);

    const newWorker=randomUUID(),newToken=`session-${randomUUID()}-${randomUUID()}`;
    await db.query(`UPDATE cnc_telegram_worker_session_leases SET lease_token=$2,lease_generation=2,
      worker_instance_id=$3,claimed_at=now(),heartbeat_at=now(),expires_at=now()+interval '1 hour'
      WHERE source_chat_id=$1`,[f.sessionLease.sourceChatId,newToken,newWorker]);
    const activeLease={...f.sessionLease,leaseToken:newToken,leaseGeneration:2,workerInstanceId:newWorker};
    const observations=new PgCncTelegramMdfObservationRepository(database);
    const claim=await observations.claim({currentUser:user,lease:activeLease});
    expect(claim?.packetId).toBe(uploaded.packet.packetId);
    const registered=(await db.query(`SELECT t.registration_kind,t.manual_send_request_id::text,
      t.source_chat_id,t.source_group_message_id::text,t.message_bindings,w.work_state,w.reason
      FROM mdf_cnc_observation_targets t JOIN cnc_manual_svg_observation_registration_work w
        ON w.send_request_id=t.manual_send_request_id
      WHERE t.packet_id=$1`,[uploaded.packet.packetId])).rows[0];
    expect(registered).toMatchObject({registration_kind:'manual_send',manual_send_request_id:task.requestId,
      source_chat_id:f.command.telegramDestinationChatId,source_group_message_id:'7002',work_state:'registered',reason:null});
    expect(registered.message_bindings).toEqual([
      expect.objectContaining({messageId:'7002',role:'svg',sha256:task.files.find(file=>file.kind==='svg')!.sha256}),
      expect.objectContaining({messageId:'7001',role:'gcode',sha256:task.files.find(file=>file.kind==='gcode')!.sha256}),
      expect.objectContaining({messageId:'7003',role:'image',sha256:'f'.repeat(64)}),
    ]);
    expect(claim?.messages).toEqual([
      {messageId:7001,role:'gcode',sha256:task.files.find(file=>file.kind==='gcode')!.sha256},
      {messageId:7002,role:'svg',sha256:task.files.find(file=>file.kind==='svg')!.sha256},
      {messageId:7003,role:'image',sha256:'f'.repeat(64)},
    ]);
    const result=await observations.complete({currentUser:user,lease:activeLease,requestId:'E2E bound manual observer',report:{
      claimId:claim!.claimId,claimToken:claim!.claimToken,claimGeneration:claim!.claimGeneration,
      messages:claim!.messages.map(message=>({messageId:message.messageId,chatId:claim!.sourceChatId,
        role:message.role,sha256:message.sha256,present:true,thumbsUp:true})),
    }});
    expect(result).toMatchObject({status:'recorded',jobId:expect.any(String)});
    expect(await runner().processOne()).toMatchObject({status:'done',jobId:result.jobId});
    expect((await db.query(`SELECT stage_code,evidence_kind,sum(quantity)::text quantity FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=(SELECT accepted_revision_key FROM mdf_source_heads
        WHERE source_kind='packet' AND source_id=$1) AND stage_code='cut' AND evidence_kind='physical'
      GROUP BY stage_code,evidence_kind`,[uploaded.packet.packetId])).rows)
      .toEqual([{stage_code:'cut',evidence_kind:'physical',quantity:'2'}]);
  });
  it.each(['registration_audit','registration_outbox'] as const)(
    'rolls manual-send registration back after %s failure and retries from bounded durable work',async failurePoint=>{
      const {f,uploaded,media,task}=await claimManualSvgSend(),completion=manualSendCompletion(task);
      await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion,
        requestTraceId:`E2E ${failurePoint} send`,sessionLease:f.sessionLease});
      if(failurePoint==='registration_audit') {
        await db.query(`CREATE FUNCTION e2e_fail_manual_send_registration_audit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.event='cnc.mdf_observation.manual_send_registered' AND NEW.entity_id='${uploaded.packet.packetId}' THEN
            RAISE EXCEPTION 'E2E_REGISTRATION_AUDIT_FAILURE' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER e2e_fail_manual_send_registration_audit BEFORE INSERT ON audit_log
            FOR EACH ROW EXECUTE FUNCTION e2e_fail_manual_send_registration_audit()`);
      } else {
        await db.query(`CREATE FUNCTION e2e_fail_manual_send_registration_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.event_type='cnc.mdf_observation.manual_send_registered' AND NEW.aggregate_id='${uploaded.packet.packetId}' THEN
            RAISE EXCEPTION 'E2E_REGISTRATION_OUTBOX_FAILURE' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER e2e_fail_manual_send_registration_outbox BEFORE INSERT ON outbox_events
            FOR EACH ROW EXECUTE FUNCTION e2e_fail_manual_send_registration_outbox()`);
      }
      try {
        const observations=new PgCncTelegramMdfObservationRepository(database);
        expect(await observations.claim({currentUser:user,lease:f.sessionLease})).toBeNull();
        expect((await db.query(`SELECT count(*)::int count FROM mdf_cnc_observation_targets WHERE packet_id=$1`,
          [uploaded.packet.packetId])).rows[0].count).toBe(0);
        const work=(await db.query(`SELECT work_state,reason,attempt_count,next_attempt_at>now() backoff
          FROM cnc_manual_svg_observation_registration_work WHERE send_request_id=$1`,[task.requestId])).rows[0];
        expect(work).toMatchObject({work_state:'pending',reason:null,attempt_count:1,backoff:true});
        expect((await db.query(`SELECT count(*)::int count FROM audit_log
          WHERE event='cnc.mdf_observation.manual_send_registered' AND entity_id=$1`,[uploaded.packet.packetId])).rows[0].count).toBe(0);
        expect((await db.query(`SELECT count(*)::int count FROM outbox_events
          WHERE event_type='cnc.mdf_observation.manual_send_registered' AND aggregate_id=$1`,[uploaded.packet.packetId])).rows[0].count).toBe(0);
        expect((await db.query(`SELECT status FROM cnc_manual_svg_telegram_send_requests WHERE request_id=$1`,
          [task.requestId])).rows[0].status).toBe('sent');
        expect((await db.query(`SELECT count(*)::int count FROM cnc_manual_svg_observation_send_bindings
          WHERE send_request_id=$1 AND lease_generation=$2`,[task.requestId,task.itemLeaseGeneration])).rows[0].count).toBe(1);
      } finally {
        const suffix=failurePoint==='registration_audit'?'audit':'outbox';
        await db.query(`DROP TRIGGER IF EXISTS e2e_fail_manual_send_registration_${suffix} ON ${failurePoint==='registration_audit'?'audit_log':'outbox_events'};
          DROP FUNCTION IF EXISTS e2e_fail_manual_send_registration_${suffix}()`);
      }
      await db.query(`UPDATE cnc_manual_svg_observation_registration_work SET next_attempt_at=now()
        WHERE send_request_id=$1 AND work_state='pending'`,[task.requestId]);
      const observations=new PgCncTelegramMdfObservationRepository(database);
      const claim=await observations.claim({currentUser:user,lease:f.sessionLease});
      expect(claim?.packetId).toBe(uploaded.packet.packetId);
      expect((await db.query(`SELECT work_state,reason,attempt_count FROM cnc_manual_svg_observation_registration_work
        WHERE send_request_id=$1`,[task.requestId])).rows[0]).toEqual({work_state:'registered',reason:null,attempt_count:2});
      expect((await db.query(`SELECT source_group_message_id::text message_id FROM mdf_cnc_observation_targets WHERE packet_id=$1`,
        [uploaded.packet.packetId])).rows[0].message_id).toBe('7002');
    });
  it('does not rebind a packet that already has an observation target',async()=>{
    const {f,uploaded,media,task}=await claimManualSvgSend(),completion=manualSendCompletion(task);
    await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion,
      requestTraceId:'E2E preexisting target send',sessionLease:f.sessionLease});
    const fence=(await db.query(`SELECT source_fence FROM cnc_manual_svg_observation_claim_snapshots
      WHERE send_request_id=$1 AND lease_generation=$2`,[task.requestId,task.itemLeaseGeneration])).rows[0].source_fence;
    await db.query(`INSERT INTO mdf_cnc_observation_targets(packet_id,source_chat_id,source_group_message_id,
      message_bindings,registered_revision_key,registered_membership_digest,accepted_revision_key,
      last_observation_version,registration_kind,manual_send_request_id)
      VALUES($1,$2,8999,$3::jsonb,$4,$5,$4,$6,'manual_send',$7)`,[uploaded.packet.packetId,
      f.command.telegramDestinationChatId,JSON.stringify([{messageId:'8999',role:'svg',sha256:'a'.repeat(64)}]),
      fence.acceptedRevisionKey,fence.membershipDigest,fence.packetSourceVersion,task.requestId]);
    const result=await new PgCncManualSendObservationRegistration(database).registerOne({currentUser:user,
      requestTraceId:'E2E existing target registration',sessionLease:f.sessionLease});
    expect(result).toMatchObject({status:'parked',packetId:uploaded.packet.packetId,reason:'TARGET_ALREADY_BOUND'});
    expect((await db.query(`SELECT source_group_message_id::text,message_bindings FROM mdf_cnc_observation_targets
      WHERE packet_id=$1`,[uploaded.packet.packetId])).rows[0]).toEqual({source_group_message_id:'8999',
        message_bindings:[{messageId:'8999',role:'svg',sha256:'a'.repeat(64)}]});
    expect((await db.query(`SELECT work_state,reason FROM cnc_manual_svg_observation_registration_work WHERE send_request_id=$1`,
      [task.requestId])).rows[0]).toEqual({work_state:'ineligible',reason:'TARGET_ALREADY_BOUND'});
  });
  it('parks a settled binding as SOURCE_STALE when an accepted correction advances the source epoch',async()=>{
    const {f,uploaded,media,task}=await claimManualSvgSend();
    await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion:manualSendCompletion(task),
      requestTraceId:'E2E stale correction send',sessionLease:f.sessionLease});
    const packetId=uploaded.packet.packetId;
    const frozen=(await db.query<{source_fence:any}>(`SELECT source_fence FROM cnc_manual_svg_observation_claim_snapshots
      WHERE send_request_id=$1 AND lease_generation=$2`,[task.requestId,task.itemLeaseGeneration])).rows[0].source_fence;
    const head=(await db.query<{accepted_revision_key:string;received_revision_key:string;version:string;correction_epoch:string}>(`
      SELECT accepted_revision_key,received_revision_key,version::text,correction_epoch::text
      FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0];
    expect(frozen).toMatchObject({acceptedRevisionKey:head.accepted_revision_key,receivedRevisionKey:head.received_revision_key,
      headVersion:head.version,correctionEpoch:head.correction_epoch});
    const storedContext=(await db.query<{source_created_at:string;display_name:string;prior_column:string|null;composition_complete:boolean}>(`
      SELECT source_created_at::text,display_name,prior_column,composition_complete FROM mdf_revision_context
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2`,[packetId,head.accepted_revision_key])).rows[0];
    const demand=(await db.query<{orderId:number;detailId:number;quantity:number}>(`SELECT order_id::int "orderId",
      detail_id::int "detailId",quantity::int quantity FROM mdf_revision_demand
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 ORDER BY order_id,detail_id`,
    [packetId,head.accepted_revision_key])).rows;
    const lines=(await db.query<{lineKey:string;orderId:number;detailId:number;quantity:number;stageCode:string;
      evidenceKind:'physical'|'declaration'|'derived';rework:boolean}>(`SELECT line_key "lineKey",order_id::int "orderId",
      detail_id::int "detailId",quantity::int quantity,stage_code "stageCode",evidence_kind "evidenceKind",rework
      FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 ORDER BY line_key`,
    [packetId,head.accepted_revision_key])).rows;
    const executionContext:MdfExecutionContext={sourceCreatedAt:storedContext.source_created_at,
      displayName:storedContext.display_name,priorColumn:storedContext.prior_column as MdfExecutionContext['priorColumn'],
      compositionComplete:storedContext.composition_complete,demand};
    const receipt=await database.transaction(tx=>recordMdfReceipt(tx,{sourceKind:'packet',sourceId:packetId,
      revisionKey:`E2E-correction-${randomUUID()}`,origin:'manual',actorUserId:Number(user.id),requestId:'E2E source epoch bump',
      causeKey:`E2E source epoch bump:${task.requestId}`,expectedFence:{version:head.version,correctionEpoch:head.correction_epoch},
      accept:true,correction:true,rules:[],executionContext,lines}),
      {mdf:{writer:'test.cnc_manual_send_stale_fence',capability:'queued'}});
    expect(receipt.accepted).toBe(true);
    expect(receipt.correctionEpoch).toBe(String(BigInt(head.correction_epoch)+1n));
    expect(receipt.version).toBe(String(BigInt(head.version)+1n));
    try {
      expect(await new PgCncTelegramMdfObservationRepository(database).claim({currentUser:user,lease:f.sessionLease})).toBeNull();
      expect((await db.query(`SELECT work_state,reason FROM cnc_manual_svg_observation_registration_work
        WHERE send_request_id=$1 AND lease_generation=$2`,[task.requestId,task.itemLeaseGeneration])).rows[0])
        .toEqual({work_state:'needs_reconciliation',reason:'SOURCE_STALE'});
      expect((await db.query('SELECT count(*)::int count FROM mdf_cnc_observation_targets WHERE packet_id=$1',[packetId])).rows[0].count)
        .toBe(0);
      expect(await runner().processOne()).toMatchObject({status:'done',jobId:receipt.jobId});
    } finally {
      await db.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now(),error_code='E2E_TEST_CLEANUP'
        WHERE job_id=$1 AND status='pending'`,[receipt.jobId]);
    }
  });
  it('backs off transient DATABASE_TIMEOUT from registration and continues the ordinary observer claim path',async()=>{
    const {f,uploaded,media,task}=await claimManualSvgSend();
    await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion:manualSendCompletion(task),
      requestTraceId:'E2E transient registration timeout send',sessionLease:f.sessionLease});
    let injected=false,ordinaryClaimQueried=false;
    const timeoutDatabase=databaseWithQueryHook(sql=>{
      if(!injected&&sql.includes('SELECT order_id::text id FROM orders')) {
        injected=true;throw new ApiError(503,'DATABASE_TIMEOUT','synthetic registrar timeout');
      }
      if(sql.includes('SELECT t.packet_id::text packet_id,t.accepted_revision_key')
        &&sql.includes('FROM mdf_cnc_observation_targets t')) ordinaryClaimQueried=true;
    });
    const observations=new PgCncTelegramMdfObservationRepository(timeoutDatabase);
    expect(await observations.claim({currentUser:user,lease:f.sessionLease})).toBeNull();
    expect(injected).toBe(true);
    expect(ordinaryClaimQueried).toBe(true);
    expect((await db.query(`SELECT work_state,attempt_count,next_attempt_at>now() backoff
      FROM cnc_manual_svg_observation_registration_work WHERE send_request_id=$1`,[task.requestId])).rows[0])
      .toEqual({work_state:'pending',attempt_count:1,backoff:true});
    expect((await db.query('SELECT count(*)::int count FROM mdf_cnc_observation_targets WHERE packet_id=$1',
      [uploaded.packet.packetId])).rows[0].count).toBe(0);
  });
  it('does not let an already-selected concurrent registrar bypass a newly scheduled retry delay',async()=>{
    const {f,uploaded,media,task}=await claimManualSvgSend();
    await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion:manualSendCompletion(task),
      requestTraceId:'E2E due-race send',sessionLease:f.sessionLease});
    let markCandidateWait!:()=>void,releaseCandidate!:()=>void;
    const candidateWait=new Promise<void>(resolve=>{markCandidateWait=resolve;});
    const holdCandidate=new Promise<void>(resolve=>{releaseCandidate=resolve;});
    let failedOnce=false,releaseTimer:ReturnType<typeof setTimeout>|undefined;
    const failingDb=databaseWithQueryHook(sql=>{
      if(!failedOnce&&sql.includes('SELECT order_id::text id FROM orders')){
        failedOnce=true;throw new ApiError(503,'DATABASE_TIMEOUT','synthetic first registrar timeout');
      }
    });
    const delayedDb=databaseWithQueryHook(async sql=>{
      if(sql.includes('SELECT order_id::text id FROM orders')){markCandidateWait();await holdCandidate;}
    });
    let firstRegistration:Promise<unknown>|undefined,secondRegistration:Promise<unknown>|undefined;
    try {
      secondRegistration=new PgCncManualSendObservationRegistration(delayedDb)
        .registerOne({currentUser:user,requestTraceId:'E2E stale candidate registrar',sessionLease:f.sessionLease});
      void secondRegistration.catch(()=>undefined);
      await Promise.race([candidateWait,new Promise<never>((_,reject)=>{
        releaseTimer=setTimeout(()=>reject(new Error('E2E_CANDIDATE_WAIT_TIMEOUT')),3000);
      })]);
      firstRegistration=new PgCncManualSendObservationRegistration(failingDb)
        .registerOne({currentUser:user,requestTraceId:'E2E first registrar attempt',sessionLease:f.sessionLease});
      void firstRegistration.catch(()=>undefined);
      await expect(firstRegistration).resolves.toMatchObject({status:'idle'});
      const afterFirst=(await db.query(`SELECT work_state,reason,attempt_count,next_attempt_at::text retry_at,next_attempt_at>now() backoff
        FROM cnc_manual_svg_observation_registration_work WHERE send_request_id=$1 AND lease_generation=$2`,
      [task.requestId,task.itemLeaseGeneration])).rows[0];
      expect(afterFirst).toMatchObject({work_state:'pending',reason:null,attempt_count:1,backoff:true});
      releaseCandidate();
      await expect(secondRegistration).resolves.toMatchObject({status:'idle'});
      const afterSecond=(await db.query(`SELECT work_state,reason,attempt_count,next_attempt_at::text retry_at
        FROM cnc_manual_svg_observation_registration_work WHERE send_request_id=$1 AND lease_generation=$2`,
      [task.requestId,task.itemLeaseGeneration])).rows[0];
      expect(afterSecond).toEqual({work_state:afterFirst.work_state,reason:afterFirst.reason,
        attempt_count:afterFirst.attempt_count,retry_at:afterFirst.retry_at});
      expect((await db.query('SELECT count(*)::int count FROM mdf_cnc_observation_targets WHERE packet_id=$1',
        [uploaded.packet.packetId])).rows[0].count).toBe(0);
    } finally {
      if(releaseTimer)clearTimeout(releaseTimer);
      releaseCandidate();
      if(secondRegistration)await secondRegistration.catch(()=>undefined);
      if(firstRegistration)await firstRegistration.catch(()=>undefined);
    }
  });
  it('locks owners before worker-session revalidation so a session renewal is not held behind an owner waiter',async()=>{
    const {f,uploaded,media,task}=await claimManualSvgSend();
    await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion:manualSendCompletion(task),
      requestTraceId:'E2E owner-first registrar send',sessionLease:f.sessionLease});
    const holder=new Client(connection);await holder.connect();
    let markOwnerWait!:()=>void;const ownerWait=new Promise<void>(resolve=>{markOwnerWait=resolve;});
    const raceDatabase=databaseWithQueryHook(sql=>{
      if(sql.includes('SELECT order_id::text id FROM orders')) markOwnerWait();
    });
    let claim:Promise<unknown>|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await holder.query(`SET search_path=${schema},public`);
      await holder.query('BEGIN');
      const lockedOwner=await holder.query('SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE',[f.orderId]);
      expect(lockedOwner.rowCount).toBe(1);
      claim=new PgCncTelegramMdfObservationRepository(raceDatabase).claim({currentUser:user,lease:f.sessionLease});
      void claim.catch(()=>undefined);
      await Promise.race([ownerWait,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('E2E_OWNER_WAIT_TIMEOUT')),3000);})]);
      const renewedToken=`session-${randomUUID()}-${randomUUID()}`,renewedWorker=randomUUID();
      await db.query(`UPDATE cnc_telegram_worker_session_leases SET lease_token=$2,lease_generation=2,
        worker_instance_id=$3,claimed_at=now(),heartbeat_at=now(),expires_at=now()+interval '1 hour'
        WHERE source_chat_id=$1`,[f.sessionLease.sourceChatId,renewedToken,renewedWorker]);
      await holder.query('COMMIT');
      await expect(claim).rejects.toMatchObject({code:'CNC_TELEGRAM_SESSION_LEASE_STALE'});
      expect((await db.query(`SELECT work_state,attempt_count FROM cnc_manual_svg_observation_registration_work
        WHERE send_request_id=$1`,[task.requestId])).rows[0]).toEqual({work_state:'pending',attempt_count:0});
      expect((await db.query('SELECT count(*)::int count FROM mdf_cnc_observation_targets WHERE packet_id=$1',
        [uploaded.packet.packetId])).rows[0].count).toBe(0);
    } finally {
      if(timer)clearTimeout(timer);
      await holder.query('ROLLBACK').catch(()=>undefined);
      await holder.end();
      if(claim) await claim.catch(()=>undefined);
    }
  });
  it('settles legitimate pre-181 in-flight sends without fabricating observation bindings and rejects an expired old lease',async()=>{
    for (const expired of [false,true]) {
      const f=await manualSvgSendFixture(),uploaded=await new PgCncTelegramRepository(database).manualSvgUpload(f.command);
      expect(await runner().processOne()).toMatchObject({status:'done'});
      const itemToken=`old-worker-${randomUUID()}-${randomUUID()}`;
      await db.query(`UPDATE cnc_manual_svg_telegram_send_requests SET status='processing',attempt_count=1,
        claimed_at=now(),lease_token=$2,lease_generation=1,lease_worker_instance_id=$3,
        lease_expires_at=CASE WHEN $4 THEN now()-interval '1 second' ELSE now()+interval '1 minute' END
        WHERE request_id=$1`,[uploaded.telegramSendRequestId,itemToken,f.worker,expired]);
      const completion={sentChatId:f.command.telegramDestinationChatId,sentMessageIds:['8101','8102','8103'],
        itemLeaseToken:itemToken,itemLeaseGeneration:1,itemLeaseOwner:f.worker};
      const media=new PgCncTelegramMediaRepository(database);
      if (expired) {
        await expect(media.completeManualSvgTelegramSend({requestId:uploaded.telegramSendRequestId,currentUser:user,
          completion,requestTraceId:'E2E expired pre-181 send',sessionLease:f.sessionLease}))
          .rejects.toMatchObject({code:'CNC_TELEGRAM_ITEM_LEASE_STALE'});
        expect((await db.query('SELECT status FROM cnc_manual_svg_telegram_send_requests WHERE request_id=$1',
          [uploaded.telegramSendRequestId])).rows[0].status).toBe('processing');
      } else {
        await expect(media.completeManualSvgTelegramSend({requestId:uploaded.telegramSendRequestId,currentUser:user,
          completion,requestTraceId:'E2E legacy in-flight send',sessionLease:f.sessionLease}))
          .resolves.toMatchObject({status:'sent'});
        expect((await db.query(`SELECT count(*)::int count FROM cnc_manual_svg_observation_claim_snapshots
          WHERE send_request_id=$1`,[uploaded.telegramSendRequestId])).rows[0].count).toBe(0);
        expect((await db.query(`SELECT count(*)::int count FROM cnc_manual_svg_observation_send_bindings
          WHERE send_request_id=$1`,[uploaded.telegramSendRequestId])).rows[0].count).toBe(0);
        expect((await db.query(`SELECT count(*)::int count FROM cnc_manual_svg_observation_registration_work
          WHERE send_request_id=$1`,[uploaded.telegramSendRequestId])).rows[0].count).toBe(0);
      }
    }
  });
  it('settles legacy-unbound and post-send media-verification failures without creating observation eligibility',async()=>{
    for (const mode of ['legacy','verification_error'] as const) {
      const {f,uploaded,media,task}=await claimManualSvgSend();
      const completion=mode==='legacy'
        ? {sentChatId:task.destinationChatId,sentMessageIds:['7101','7102','7199'],itemLeaseToken:task.itemLeaseToken,
          itemLeaseGeneration:task.itemLeaseGeneration,itemLeaseOwner:task.itemLeaseOwner}
        : {sentChatId:task.destinationChatId,sentMessageIds:['7101','7102','7199'],observationBindingError:'MEDIA_VERIFICATION_FAILED' as const,
          itemLeaseToken:task.itemLeaseToken,itemLeaseGeneration:task.itemLeaseGeneration,itemLeaseOwner:task.itemLeaseOwner};
      await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion,
        requestTraceId:`E2E unbound ${mode}`,sessionLease:f.sessionLease});
      const rows=(await db.query(`SELECT r.status,b.sent_files,b.binding_error,w.work_state,w.reason
        FROM cnc_manual_svg_telegram_send_requests r
        JOIN cnc_manual_svg_observation_send_bindings b ON b.send_request_id=r.request_id
        JOIN cnc_manual_svg_observation_registration_work w USING(send_request_id)
        WHERE r.request_id=$1`,[uploaded.telegramSendRequestId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({status:'sent',sent_files:null,work_state:'ineligible',
        reason:mode==='legacy'?'SENT_BINDING_MISSING':'MEDIA_VERIFICATION_FAILED',
        binding_error:mode==='legacy'?null:'MEDIA_VERIFICATION_FAILED'});
      expect((await db.query('SELECT count(*)::int count FROM mdf_cnc_observation_targets WHERE packet_id=$1',
        [uploaded.packet.packetId])).rows[0].count).toBe(0);
    }
  });
  it('parks an incomplete requested file set instead of promoting the surviving SVG/G-code subset',async()=>{
    const f=await manualSvgSendFixture(),uploaded=await new PgCncTelegramRepository(database).manualSvgUpload(f.command);
    expect(await runner().processOne()).toMatchObject({status:'done'});
    await db.query(`UPDATE cnc_manual_svg_upload_files SET expires_at=now()-interval '1 second'
      WHERE packet_id=$1 AND file_kind='screenshot'`,[uploaded.packet.packetId]);
    const media=new PgCncTelegramMediaRepository(database);
    const [task]=await media.claimManualSvgTelegramSends({currentUser:user,limit:1,requestTraceId:'E2E incomplete claim',sessionLease:f.sessionLease});
    expect(task?.files.map(file=>file.kind)).toEqual(['svg','gcode']);
    expect(task?.observationBindingVersion).toBeUndefined();
    const completion=manualSendCompletion(task);
    await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion,
      requestTraceId:'E2E incomplete completion',sessionLease:f.sessionLease});
    expect((await db.query(`SELECT s.requested_file_count,s.files_qualified,s.ineligible_reason,w.work_state,w.reason
      FROM cnc_manual_svg_observation_claim_snapshots s JOIN cnc_manual_svg_observation_registration_work w
      USING(send_request_id,lease_generation) WHERE s.send_request_id=$1`,[task.requestId])).rows[0])
      .toMatchObject({requested_file_count:3,files_qualified:false,ineligible_reason:'FILES_INCOMPLETE',
        work_state:'ineligible',reason:'FILES_INCOMPLETE'});
    expect((await db.query('SELECT count(*)::int count FROM mdf_cnc_observation_targets WHERE packet_id=$1',
      [uploaded.packet.packetId])).rows[0].count).toBe(0);
  });
  it('settles a valid send but parks it when the claim-time MDF source is not yet accepted',async()=>{
    const f=await manualSvgSendFixture(1);
    f.command.dto.validationMode='lenient';f.command.dto.items[0].quantity=2;
    const uploaded=await new PgCncTelegramRepository(database).manualSvgUpload(f.command);
    expect((await db.query(`SELECT accepted_revision_key FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
      [uploaded.packet.packetId])).rows[0].accepted_revision_key).toBeNull();
    try {
      const media=new PgCncTelegramMediaRepository(database);
      const [task]=await media.claimManualSvgTelegramSends({currentUser:user,limit:1,requestTraceId:'E2E unaccepted source claim',
        sessionLease:f.sessionLease});
      expect(task?.requestId).toBe(uploaded.telegramSendRequestId);
      expect(task?.observationBindingVersion).toBe(1);
      const sourceSnapshot=(await db.query(`SELECT source_eligible,ineligible_reason,source_fence
        FROM cnc_manual_svg_observation_claim_snapshots WHERE send_request_id=$1 AND lease_generation=$2`,
        [task.requestId,task.itemLeaseGeneration])).rows[0];
      expect(sourceSnapshot).toMatchObject({source_eligible:false,ineligible_reason:'SOURCE_UNACCEPTED'});
      await media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,
        completion:manualSendCompletion(task),requestTraceId:'E2E unaccepted source sent',sessionLease:f.sessionLease});
      expect((await db.query(`SELECT work_state,reason FROM cnc_manual_svg_observation_registration_work
        WHERE send_request_id=$1`,[task.requestId])).rows[0])
        .toEqual({work_state:'ineligible',reason:'SOURCE_UNACCEPTED'});
      expect((await db.query('SELECT count(*)::int count FROM mdf_cnc_observation_targets WHERE packet_id=$1',
        [uploaded.packet.packetId])).rows[0].count).toBe(0);
    } finally {
      await db.query(`UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now(),error_code='E2E_TEST_CLEANUP'
        WHERE source_kind='packet' AND source_id=$1 AND status='pending'`,[uploaded.packet.packetId]);
    }
  });
  it('allows same-session late settlement after processing is reaped to unknown, but rejects an older item generation',async()=>{
    const {f,uploaded,media,task}=await claimManualSvgSend();
    await db.query(`UPDATE cnc_manual_svg_telegram_send_requests SET claimed_at=now()-interval '16 minutes',
      lease_expires_at=now()-interval '1 second' WHERE request_id=$1`,[task.requestId]);
    expect(await media.claimManualSvgTelegramSends({currentUser:user,limit:1,requestTraceId:'E2E reaper unknown settlement',
      sessionLease:f.sessionLease})).toEqual([]);
    expect((await db.query('SELECT status FROM cnc_manual_svg_telegram_send_requests WHERE request_id=$1',
      [task.requestId])).rows[0].status).toBe('unknown');
    const lateCompletion=manualSendCompletion(task);
    await expect(media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion:lateCompletion,
      requestTraceId:'E2E late settlement',sessionLease:f.sessionLease})).resolves.toMatchObject({status:'sent'});
    expect((await db.query(`SELECT work_state FROM cnc_manual_svg_observation_registration_work WHERE send_request_id=$1`,
      [uploaded.telegramSendRequestId])).rows[0].work_state).toBe('pending');

    const second=await claimManualSvgSend();
    await db.query(`UPDATE cnc_manual_svg_telegram_send_requests SET status='pending',claimed_at=NULL,finished_at=NULL,
      sent_chat_id=NULL,sent_message_ids_json='[]'::jsonb,last_error=NULL,lease_token=NULL,lease_worker_instance_id=NULL,
      lease_expires_at=NULL WHERE request_id=$1`,[second.task.requestId]);
    const [newTask]=await second.media.claimManualSvgTelegramSends({currentUser:user,limit:1,requestTraceId:'E2E new item generation',
      sessionLease:second.f.sessionLease});
    expect(newTask.itemLeaseGeneration).toBe(second.task.itemLeaseGeneration+1);
    await expect(second.media.completeManualSvgTelegramSend({requestId:newTask.requestId,currentUser:user,
      completion:manualSendCompletion(second.task),requestTraceId:'E2E stale old generation',sessionLease:second.f.sessionLease}))
      .rejects.toMatchObject({code:'CNC_TELEGRAM_ITEM_LEASE_STALE'});
    expect((await db.query(`SELECT status FROM cnc_manual_svg_telegram_send_requests WHERE request_id=$1`,[newTask.requestId])).rows[0].status)
      .toBe('processing');
    const renewedToken=`session-${randomUUID()}-${randomUUID()}`;
    await db.query(`UPDATE cnc_telegram_worker_session_leases SET lease_token=$2,lease_generation=2,
      expires_at=now()+interval '1 hour' WHERE source_chat_id=$1`,[second.f.sessionLease.sourceChatId,renewedToken]);
    await expect(second.media.completeManualSvgTelegramSend({requestId:newTask.requestId,currentUser:user,
      completion:manualSendCompletion(newTask),requestTraceId:'E2E revoked global session',sessionLease:second.f.sessionLease}))
      .rejects.toMatchObject({code:'CNC_TELEGRAM_SESSION_LEASE_STALE'});
    await expect(second.media.completeManualSvgTelegramSend({requestId:newTask.requestId,currentUser:user,
      completion:manualSendCompletion(newTask),requestTraceId:'E2E newer global session',
      sessionLease:{...second.f.sessionLease,leaseToken:renewedToken,leaseGeneration:2}}))
      .rejects.toMatchObject({code:'CNC_TELEGRAM_ITEM_LEASE_STALE'});
    expect((await db.query('SELECT status FROM cnc_manual_svg_telegram_send_requests WHERE request_id=$1',
      [newTask.requestId])).rows[0].status).toBe('processing');
  });
  it('rolls completion receipt and work back with the request update if audit fails, then accepts an exact retry',async()=>{
    const {f,uploaded,media,task}=await claimManualSvgSend(),completion=manualSendCompletion(task);
    await db.query(`CREATE FUNCTION e2e_fail_manual_send_completion_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event='cnc.manual_svg_upload.telegram_send_completed' AND NEW.entity_id='${task.requestId}' THEN
        RAISE EXCEPTION 'E2E_COMPLETION_AUDIT_FAILURE' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER e2e_fail_manual_send_completion_audit BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION e2e_fail_manual_send_completion_audit()`);
    try {
      await expect(media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion,
        requestTraceId:'E2E fail manual settlement audit',sessionLease:f.sessionLease})).rejects.toMatchObject({code:'P0001'});
      expect((await db.query('SELECT status FROM cnc_manual_svg_telegram_send_requests WHERE request_id=$1',
        [task.requestId])).rows[0].status).toBe('processing');
      expect((await db.query('SELECT count(*)::int count FROM cnc_manual_svg_observation_send_bindings WHERE send_request_id=$1',
        [task.requestId])).rows[0].count).toBe(0);
      expect((await db.query('SELECT count(*)::int count FROM cnc_manual_svg_observation_registration_work WHERE send_request_id=$1',
        [task.requestId])).rows[0].count).toBe(0);
      expect((await db.query(`SELECT count(*)::int count FROM audit_log WHERE event='cnc.manual_svg_upload.telegram_send_completed'
        AND entity_id=$1`,[task.requestId])).rows[0].count).toBe(0);
    } finally {
      await db.query('DROP TRIGGER IF EXISTS e2e_fail_manual_send_completion_audit ON audit_log; DROP FUNCTION IF EXISTS e2e_fail_manual_send_completion_audit()');
    }
    await db.query(`CREATE FUNCTION e2e_suppress_manual_send_completion_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event='cnc.manual_svg_upload.telegram_send_completed' AND NEW.entity_id='${task.requestId}' THEN
        RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER e2e_suppress_manual_send_completion_audit BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION e2e_suppress_manual_send_completion_audit()`);
    try {
      await expect(media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion,
        requestTraceId:'E2E suppressed manual settlement audit',sessionLease:f.sessionLease}))
        .rejects.toThrow('CNC_MANUAL_SVG_SEND_COMPLETION_AUDIT_REQUIRED');
      expect((await db.query('SELECT status FROM cnc_manual_svg_telegram_send_requests WHERE request_id=$1',
        [task.requestId])).rows[0].status).toBe('processing');
      expect((await db.query('SELECT count(*)::int count FROM cnc_manual_svg_observation_send_bindings WHERE send_request_id=$1',
        [task.requestId])).rows[0].count).toBe(0);
      expect((await db.query('SELECT count(*)::int count FROM cnc_manual_svg_observation_registration_work WHERE send_request_id=$1',
        [task.requestId])).rows[0].count).toBe(0);
      expect((await db.query(`SELECT count(*)::int count FROM audit_log WHERE event='cnc.manual_svg_upload.telegram_send_completed'
        AND entity_id=$1`,[task.requestId])).rows[0].count).toBe(0);
    } finally {
      await db.query('DROP TRIGGER IF EXISTS e2e_suppress_manual_send_completion_audit ON audit_log; DROP FUNCTION IF EXISTS e2e_suppress_manual_send_completion_audit()');
    }
    await expect(media.completeManualSvgTelegramSend({requestId:task.requestId,currentUser:user,completion,
      requestTraceId:'E2E retry manual settlement',sessionLease:f.sessionLease})).resolves.toMatchObject({status:'sent'});
    expect((await db.query(`SELECT work_state,reason FROM cnc_manual_svg_observation_registration_work WHERE send_request_id=$1`,
      [uploaded.telegramSendRequestId])).rows[0]).toEqual({work_state:'pending',reason:null});
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
  async function addPartialV2ManualProof(packetId: string, f: Awaited<ReturnType<typeof telegramFixture>>) {
    const head=(await db.query<{accepted:string;version:string;epoch:string}>(`SELECT accepted_revision_key accepted,
      version::text,correction_epoch::text epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0];
    const lines=(await db.query<{lineKey:string;orderId:number;detailId:number;quantity:number;stageCode:string;
      evidenceKind:'physical'|'declaration'|'derived';rework:boolean}>(`SELECT line_key "lineKey",order_id::int "orderId",
      detail_id::int "detailId",quantity::int quantity,stage_code "stageCode",evidence_kind "evidenceKind",rework
      FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 ORDER BY line_key`,
    [packetId,head.accepted])).rows.map(line=>({...line,stageCode:line.stageCode as MdfReceiptLine['stageCode']}));
    expect(lines).toEqual([{lineKey:expect.any(String),orderId:f.orderId,detailId:f.detailId,quantity:2,
      stageCode:'membership',evidenceKind:'derived',rework:false}]);
    const context=(await db.query<{sourceCreatedAt:string;displayName:string;priorColumn:string|null;compositionComplete:boolean}>(`
      SELECT source_created_at::text "sourceCreatedAt",display_name "displayName",prior_column "priorColumn",composition_complete "compositionComplete"
      FROM mdf_revision_context WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2`,[packetId,head.accepted])).rows[0];
    const demand=(await db.query<{orderId:number;detailId:number;quantity:number}>(`SELECT order_id::int "orderId",
      detail_id::int "detailId",quantity::int quantity FROM mdf_revision_demand
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 ORDER BY order_id,detail_id`,[packetId,head.accepted])).rows;
    const physical: MdfReceiptLine={lineKey:'manual-partial-root',orderId:f.orderId,detailId:f.detailId,
      quantity:1,stageCode:'cut',evidenceKind:'physical',rework:false};
    const lineage:MdfPhysicalLineageManifest={operation:'production',authority:'manual_production',
      actions:[{lineKey:physical.lineKey,action:'root'}],droppedPredecessorEvidenceLineIds:[]};
    const saved=await database.transaction(tx=>recordMdfLineageReceipt(tx,{sourceKind:'packet',sourceId:packetId,
      revisionKey:`E2E-partial-manual-${randomUUID()}`,origin:'manual',actorUserId:1,requestId:'E2E partial authenticated v2 root',
      causeKey:`E2E partial authenticated v2 root ${packetId}`,expectedFence:{version:head.version,correctionEpoch:head.epoch},
      accept:true,rules:[],lines:[...lines,physical],lineage,
      executionContext:{sourceCreatedAt:context.sourceCreatedAt,displayName:context.displayName,priorColumn:context.priorColumn,
        compositionComplete:context.compositionComplete,demand}}));
    await processJob(saved.jobId);
    const proof=(await db.query<{evidenceLineId:string;revisionKey:string}>(`SELECT evidence_line_id::text "evidenceLineId",
      revision_key "revisionKey" FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2
        AND line_key=$3 AND evidence_kind='physical'`,[packetId,(await db.query<{received:string}>(
      `SELECT received_revision_key received FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].received,
      physical.lineKey])).rows[0];
    expect(proof).toBeDefined();
    return {saved,proof};
  }
  async function addLaminatedBathPin(f: Awaited<ReturnType<typeof telegramFixture>>, laminated: boolean) {
    const cutJobId=2_000_000+f.orderId;
    const params={...await config.getDefaultParams(),layout_mode:'vacuum_table'};
    await db.query(`INSERT INTO cut_job(cut_job_id,name,status,version,source,params,rotation_allowed,combine_films,split_by_material)
      VALUES($1,$2,'draft',1,'manual',$3::jsonb,true,false,true)`,
    [cutJobId,`E2E pre-observation pin ${f.orderId}`,JSON.stringify(params)]);
    await db.query(`INSERT INTO cut_job_item(cut_job_id,source_type,order_id,order_detail_id,freecut_item_id,qty,is_active)
      VALUES($1,'order_detail',$2,$3,$4,2,true)`,[cutJobId,f.orderId,f.detailId,`det-${f.detailId}`]);
    await repository.calculate({currentUser:user,cutJobId,version:1,commandId:randomUUID(),requestId:'E2E pre-observation bath calculation'});
    const bathId=`cut-result:${await resultId(cutJobId)}`;
    const bathJob=(await db.query<{job_id:string}>(`SELECT job_id FROM mdf_recalculation_jobs
      WHERE source_kind='bath' AND source_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`,[bathId])).rows[0];
    expect(bathJob).toBeDefined();
    await processJob(bathJob.job_id);
    if (laminated) {
      const mover=new PgMdfBoardManualMoveRepository(database);
      const actor={...user,permissions:[...user.permissions,'orders.update','production.tasks.update','orders.change_production_status']} as CurrentUser;
      const board=await readMdfPublishedSnapshot(database,user,{focus:{kind:'bath',id:bathId}});
      const card=board.cards.find(value=>value.kind==='bath'&&value.id===bathId)!;
      await mover.upsert({currentUser:actor,cardKind:'bath',cardId:bathId,targetColumn:'baths_laminated',
        sourceToken:card.commandToken!,idempotencyKey:`E2E-${randomUUID()}`,requestId:'E2E CNC v2 pin lamination'});
      const laminationJob=(await db.query<{job_id:string}>(`SELECT job_id FROM mdf_recalculation_jobs
        WHERE source_kind='bath' AND source_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`,[bathId])).rows[0];
      expect(laminationJob).toBeDefined();
      await processJob(laminationJob.job_id);
    }
    return {bathId,bathJobId:bathJob.job_id};
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
    const priorPhysical=(await db.query<{evidenceLineId:string;action:string;origin:string;lineKey:string}>(`SELECT
      l.evidence_line_id::text "evidenceLineId",t.action,t.canonical_origin_evidence_line_id::text origin,l.line_key "lineKey"
      FROM mdf_evidence_lines l JOIN mdf_physical_lineage_transitions t USING(evidence_line_id)
      WHERE l.source_kind='packet' AND l.source_id=$1 AND l.revision_key=$2 AND l.evidence_kind='physical'`,
    [packetId,before.accepted_revision_key])).rows;
    expect(priorPhysical).toHaveLength(1);
    expect(priorPhysical[0].action).toBe('root');
    expect(priorPhysical[0].origin).toBe(priorPhysical[0].evidenceLineId);
    const priorCncSetting=(await db.query(`SELECT is_active,value_json FROM app_settings
      WHERE setting_key='status_automation.cnc_mark_cut_details'`)).rows[0];
    await db.query(`INSERT INTO app_settings(setting_key,is_active,value_json)
      VALUES('status_automation.cnc_mark_cut_details',true,'{"value":true}'::jsonb)
      ON CONFLICT(setting_key) DO UPDATE SET is_active=true,value_json='{"value":true}'::jsonb`);
    try {
    const observations=new PgCncTelegramMdfObservationRepository(database),lease=f.input.lease;
    const claim=await observations.claim({currentUser:user,lease});
    const report={
      claimId:claim!.claimId,claimToken:claim!.claimToken,claimGeneration:claim!.claimGeneration,
      messages:claim!.messages.map(message=>({messageId:message.messageId,chatId:claim!.sourceChatId,
        role:message.role,sha256:message.sha256,present:true,thumbsUp:true})),
    };
    const result=await observations.complete({currentUser:user,lease,requestId:'E2E CNC after manual complete',report});
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
    expect((await db.query(`SELECT operation,production_authority,predecessor_accepted_revision_key
      FROM mdf_physical_lineage_contracts WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2`,
    [packetId,after.accepted_revision_key])).rows).toEqual([{operation:'production',
      production_authority:'cnc_observation',predecessor_accepted_revision_key:before.accepted_revision_key}]);
    expect((await db.query(`SELECT t.action,t.predecessor_evidence_line_id::text predecessor,
      t.canonical_origin_evidence_line_id::text origin,l.evidence_line_id::text evidence_id,
      l.quantity::text quantity FROM mdf_physical_lineage_transitions t JOIN mdf_evidence_lines l USING(evidence_line_id)
      WHERE t.source_kind='packet' AND t.source_id=$1 AND t.revision_key=$2 AND l.evidence_kind='physical'`,
    [packetId,after.accepted_revision_key])).rows).toEqual([{action:'carry',predecessor:priorPhysical[0].evidenceLineId,
      origin:priorPhysical[0].origin,evidence_id:expect.any(String),quantity:'2'}]);
    expect((await db.query('SELECT production_status_id FROM order_details WHERE detail_id=$1',[f.detailId])).rows[0].production_status_id)
      .toBe(3);
    expect((await db.query('SELECT order_status_id FROM orders WHERE order_id=$1',[f.orderId])).rows[0].order_status_id)
      .toBe(4);
    expect((await db.query(`SELECT a.authority,a.claim_id,r.result->>'jobId' job
      FROM mdf_cnc_observation_job_authorities a JOIN mdf_cnc_observation_receipts r USING(claim_id)
      WHERE a.packet_id=$1 AND a.job_id=$2`,[packetId,result.jobId])).rows)
      .toEqual([{authority:'cnc_autocut',claim_id:claim!.claimId,job:result.jobId}]);
    const revisionCount=Number((await db.query(`SELECT count(*)::text count FROM mdf_evidence_revisions
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].count);
    expect(await observations.complete({currentUser:user,lease,requestId:'E2E CNC after manual complete',report})).toEqual(result);
    expect(Number((await db.query(`SELECT count(*)::text count FROM mdf_evidence_revisions
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].count)).toBe(revisionCount);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_cnc_observation_job_authorities
      WHERE packet_id=$1 AND claim_id=$2`,[packetId,claim!.claimId])).rows[0].count).toBe(1);
    } finally {
      if (priorCncSetting) {
        await db.query(`UPDATE app_settings SET is_active=$1,value_json=$2::jsonb
          WHERE setting_key='status_automation.cnc_mark_cut_details'`,[priorCncSetting.is_active,JSON.stringify(priorCncSetting.value_json)]);
      } else {
        await db.query(`DELETE FROM app_settings WHERE setting_key='status_automation.cnc_mark_cut_details'`);
      }
    }
  });
  it('adds only the uncovered CNC quantity as a new root while carrying the authenticated partial v2 root',async()=>{
    const f=await telegramFixture(),imported=await f.importer.completeImport(f.input),packetId=imported.packetId!;
    expect(imported.status).toBe('imported');
    const importJob=(await db.query<{job_id:string}>(`SELECT job_id FROM mdf_recalculation_jobs
      WHERE source_kind='packet' AND source_id=$1 ORDER BY created_at LIMIT 1`,[packetId])).rows[0];
    await processJob(importJob.job_id);
    const partial=await addPartialV2ManualProof(packetId,f);
    const before=(await db.query<{accepted:string;physical:string;membership:string}>(`SELECT h.accepted_revision_key accepted,
      (SELECT sum(quantity)::text FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1
        AND revision_key=h.accepted_revision_key AND stage_code='cut' AND evidence_kind='physical') physical,
      (SELECT sum(quantity)::text FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1
        AND revision_key=h.accepted_revision_key AND stage_code='membership' AND evidence_kind='derived') membership
      FROM mdf_source_heads h WHERE h.source_kind='packet' AND h.source_id=$1`,[packetId])).rows[0];
    expect(before).toMatchObject({accepted:partial.proof.revisionKey,physical:'1',membership:'2'});

    const observations=new PgCncTelegramMdfObservationRepository(database),lease=f.input.lease;
    const claim=await observations.claim({currentUser:user,lease});
    expect(claim?.packetId).toBe(packetId);
    const report={claimId:claim!.claimId,claimToken:claim!.claimToken,claimGeneration:claim!.claimGeneration,
      messages:claim!.messages.map(message=>({messageId:message.messageId,chatId:claim!.sourceChatId,
        role:message.role,sha256:message.sha256,present:true,thumbsUp:true}))};
    const requestId='E2E CNC remaining v2 quantity';
    const result=await observations.complete({currentUser:user,lease,requestId,report});
    expect(result).toMatchObject({status:'recorded',jobId:expect.any(String)});
    const after=(await db.query<{accepted:string;received:string;physical:string}>(`SELECT h.accepted_revision_key accepted,
      h.received_revision_key received,(SELECT sum(quantity)::text FROM mdf_evidence_lines
        WHERE source_kind='packet' AND source_id=$1 AND revision_key=h.accepted_revision_key
          AND stage_code='cut' AND evidence_kind='physical') physical
      FROM mdf_source_heads h WHERE h.source_kind='packet' AND h.source_id=$1`,[packetId])).rows[0];
    expect(after).toEqual({accepted:after.received,received:after.received,physical:'2'});
    expect((await db.query(`SELECT operation,production_authority,predecessor_accepted_revision_key
      FROM mdf_physical_lineage_contracts WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2`,
    [packetId,after.accepted])).rows).toEqual([{operation:'production',production_authority:'cnc_observation',
      predecessor_accepted_revision_key:before.accepted}]);
    const transitions=(await db.query<{lineKey:string;action:string;predecessor:string|null;origin:string;evidenceId:string;quantity:string}>(`
      SELECT l.line_key "lineKey",t.action,t.predecessor_evidence_line_id::text predecessor,
        t.canonical_origin_evidence_line_id::text origin,l.evidence_line_id::text "evidenceId",l.quantity::text quantity
      FROM mdf_physical_lineage_transitions t JOIN mdf_evidence_lines l USING(evidence_line_id)
      WHERE t.source_kind='packet' AND t.source_id=$1 AND t.revision_key=$2 AND l.evidence_kind='physical'
      ORDER BY t.action,l.line_key`,[packetId,after.accepted])).rows;
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toEqual({lineKey:'manual-partial-root',action:'carry',predecessor:partial.proof.evidenceLineId,
      origin:partial.proof.evidenceLineId,evidenceId:expect.any(String),quantity:'1'});
    expect(transitions[1]).toMatchObject({lineKey:`cnc-cut:${f.orderId}:${f.detailId}:0:${claim!.claimId}`,
      action:'root',predecessor:null,origin:expect.any(String),evidenceId:expect.any(String),quantity:'1'});
    expect(transitions[1].origin).toBe(transitions[1].evidenceId);
    expect(await runner().processOne()).toMatchObject({status:'done',jobId:result.jobId});
    const revisionCount=Number((await db.query(`SELECT count(*)::text count FROM mdf_evidence_revisions
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].count);
    expect(await observations.complete({currentUser:user,lease,requestId,report})).toEqual(result);
    expect(Number((await db.query(`SELECT count(*)::text count FROM mdf_evidence_revisions
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].count)).toBe(revisionCount);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_cnc_observation_job_authorities
      WHERE packet_id=$1 AND claim_id=$2`,[packetId,claim!.claimId])).rows[0].count).toBe(1);
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
    const manualHead=(await db.query<{revision:string}>(`SELECT accepted_revision_key revision FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].revision;
    const manualPhysical=(await db.query<{evidenceLineId:string;origin:string}>(`SELECT
      l.evidence_line_id::text "evidenceLineId",t.canonical_origin_evidence_line_id::text origin
      FROM mdf_evidence_lines l JOIN mdf_physical_lineage_transitions t USING(evidence_line_id)
      WHERE l.source_kind='packet' AND l.source_id=$1 AND l.revision_key=$2 AND l.evidence_kind='physical'`,
    [packetId,manualHead])).rows;
    expect(manualPhysical).toHaveLength(1);
    expect(manualPhysical[0].origin).toBe(manualPhysical[0].evidenceLineId);

    const observations=new PgCncTelegramMdfObservationRepository(database),lease=f.input.lease;
    const claim=await observations.claim({currentUser:user,lease});
    expect(claim?.packetId).toBe(packetId);
    const report={
      claimId:claim!.claimId,claimToken:claim!.claimToken,claimGeneration:claim!.claimGeneration,
      messages:claim!.messages.map(message=>({messageId:message.messageId,chatId:claim!.sourceChatId,
        role:message.role,sha256:message.sha256,present:true,thumbsUp:true})),
    };
    const observation=await observations.complete({currentUser:user,lease,requestId:'E2E allocation after current CNC receipt',report});
    expect(observation.status).toBe('recorded');
    const cncRevision=(await db.query<{revision:string}>(`SELECT accepted_revision_key revision FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].revision;
    expect(cncRevision).not.toBe(manualHead);
    expect((await db.query(`SELECT operation,production_authority,predecessor_accepted_revision_key
      FROM mdf_physical_lineage_contracts WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2`,
    [packetId,cncRevision])).rows).toEqual([{operation:'production',production_authority:'cnc_observation',
      predecessor_accepted_revision_key:manualHead}]);
    expect((await db.query(`SELECT t.action,t.predecessor_evidence_line_id::text predecessor,
      t.canonical_origin_evidence_line_id::text origin,l.evidence_line_id::text evidence_id,l.quantity::text quantity
      FROM mdf_physical_lineage_transitions t JOIN mdf_evidence_lines l USING(evidence_line_id)
      WHERE t.source_kind='packet' AND t.source_id=$1 AND t.revision_key=$2 AND l.evidence_kind='physical'`,
    [packetId,cncRevision])).rows).toEqual([{action:'carry',predecessor:manualPhysical[0].evidenceLineId,
      origin:manualPhysical[0].origin,evidence_id:expect.any(String),quantity:'2'}]);

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
    expect(await observations.complete({currentUser:user,lease,requestId:'E2E allocation after current CNC receipt',report}))
      .toEqual(observation);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_cnc_observation_job_authorities
      WHERE packet_id=$1 AND claim_id=$2`,[packetId,claim!.claimId])).rows[0].count).toBe(1);
  });
  it.each([{laminated:false,state:'reserved'},{laminated:true,state:'consumed'}] as const)(
  'rebases an existing $state v2 bath pin on a distinct no-delta CNC authority receipt',async({laminated,state})=>{
    const f=await telegramFixture(),imported=await f.importer.completeImport(f.input),packetId=imported.packetId!;
    expect(imported.status).toBe('imported');
    const importJob=(await db.query<{job_id:string}>(`SELECT job_id FROM mdf_recalculation_jobs
      WHERE source_kind='packet' AND source_id=$1 ORDER BY created_at LIMIT 1`,[packetId])).rows[0];
    await processJob(importJob.job_id);

    const mover=new PgMdfBoardManualMoveRepository(database);
    const actor={...user,permissions:[...user.permissions,'orders.update','production.tasks.update','orders.change_production_status']} as CurrentUser;
    const board=await readMdfPublishedSnapshot(database,user,{focus:{kind:'packet',id:packetId}});
    const card=board.cards.find(value=>value.kind==='packet'&&value.id===packetId)!;
    const manual=await mover.upsert({currentUser:actor,cardKind:'packet',cardId:packetId,targetColumn:'completed',
      sourceToken:card.commandToken!,idempotencyKey:`E2E-${randomUUID()}`,requestId:'E2E pin before CNC observation'});
    await processJob(manual.jobId!);
    const manualHead=(await db.query<{revision:string}>(`SELECT accepted_revision_key revision FROM mdf_source_heads
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].revision;
    const parent=(await db.query<{evidenceLineId:string;origin:string;quantity:string}>(`SELECT
      l.evidence_line_id::text "evidenceLineId",t.canonical_origin_evidence_line_id::text origin,l.quantity::text quantity
      FROM mdf_evidence_lines l JOIN mdf_physical_lineage_transitions t USING(evidence_line_id)
      WHERE l.source_kind='packet' AND l.source_id=$1 AND l.revision_key=$2 AND l.evidence_kind='physical'`,
    [packetId,manualHead])).rows[0];
    expect(parent).toMatchObject({evidenceLineId:expect.any(String),origin:expect.any(String),quantity:'2'});
    const {bathId}=await addLaminatedBathPin(f,laminated);
    const pinsBefore=(await db.query<{allocationId:string;state:string;quantity:string;bathRevision:string;
      evidenceLineId:string;revision:string;orderId:number;detailId:number}>(`SELECT a.allocation_id::text "allocationId",a.state,
        a.quantity::text quantity,a.bath_revision "bathRevision",a.evidence_line_id::text "evidenceLineId",
        e.revision_key revision,a.order_id::int "orderId",a.detail_id::int "detailId"
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=$1 AND a.state<>'released' AND e.source_kind='packet' AND e.source_id=$2`,[bathId,packetId])).rows;
    expect(pinsBefore).toHaveLength(1);
    expect(pinsBefore[0]).toMatchObject({state,quantity:'2',evidenceLineId:parent.evidenceLineId,
      revision:manualHead,orderId:f.orderId,detailId:f.detailId});

    const observations=new PgCncTelegramMdfObservationRepository(database),lease=f.input.lease;
    const claim=await observations.claim({currentUser:user,lease});
    expect(claim?.packetId).toBe(packetId);
    const report={claimId:claim!.claimId,claimToken:claim!.claimToken,claimGeneration:claim!.claimGeneration,
      messages:claim!.messages.map(message=>({messageId:message.messageId,chatId:claim!.sourceChatId,
        role:message.role,sha256:message.sha256,present:true,thumbsUp:true}))};
    const requestId='E2E CNC preserves v2 pin';
    const headBefore=(await db.query(`SELECT version::text,correction_epoch::text,accepted_revision_key,received_revision_key
      FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0];
    const revisionsBefore=Number((await db.query(`SELECT count(*)::text count FROM mdf_evidence_revisions
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].count);
    const pinHistoryBefore=(await db.query(`SELECT a.allocation_id::text "allocationId",a.state,a.quantity::text quantity,
      a.bath_id "bathId",a.bath_revision "bathRevision",a.evidence_line_id::text "evidenceLineId",
      e.revision_key revision,a.order_id::int "orderId",a.detail_id::int "detailId"
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=$1 AND e.source_kind='packet' AND e.source_id=$2 ORDER BY a.allocation_id`,[bathId,packetId])).rows;
    const lineageBefore=(await db.query(`SELECT c.revision_key,c.operation,c.production_authority,t.action,
      t.evidence_line_id::text evidence_id,t.predecessor_evidence_line_id::text predecessor,
      t.canonical_origin_evidence_line_id::text origin FROM mdf_physical_lineage_contracts c
      JOIN mdf_physical_lineage_transitions t USING(source_kind,source_id,revision_key)
      WHERE c.source_kind='packet' AND c.source_id=$1 ORDER BY c.revision_key,t.evidence_line_id`,[packetId])).rows;
    const rollbackTables=['cnc_telegram_packets','mdf_source_heads','mdf_evidence_revisions','mdf_evidence_lines',
      'mdf_revision_context','mdf_revision_demand','mdf_revision_seals','mdf_published_sources','mdf_recalculation_job_rules',
      'mdf_physical_lineage_contracts','mdf_physical_lineage_transitions','mdf_bath_allocations','mdf_recalculation_jobs',
      'mdf_cnc_observation_targets','mdf_cnc_observation_receipts','mdf_cnc_observation_job_authorities',
      'audit_log','audit_log_related_entity','outbox_events'];
    const snapshotRollback=async()=>Promise.all(rollbackTables.map(async table=>[table,
      (await db.query<{row:string}>(`SELECT to_jsonb(t)::text row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(row=>row.row)]));
    const rollbackBefore=await snapshotRollback();
    await db.query(`ALTER TABLE mdf_cnc_observation_receipts ADD CONSTRAINT e2e_reject_cnc_v2_observation_receipt
      CHECK(claim_id<>'${claim!.claimId}'::uuid)`);
    try {
      await expect(observations.complete({currentUser:user,lease,requestId,report})).rejects.toMatchObject({code:'23514'});
    } finally {
      await db.query('ALTER TABLE mdf_cnc_observation_receipts DROP CONSTRAINT e2e_reject_cnc_v2_observation_receipt');
    }
    expect((await db.query(`SELECT version::text,correction_epoch::text,accepted_revision_key,received_revision_key
      FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0]).toEqual(headBefore);
    expect(Number((await db.query(`SELECT count(*)::text count FROM mdf_evidence_revisions
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].count)).toBe(revisionsBefore);
    expect((await db.query(`SELECT c.revision_key,c.operation,c.production_authority,t.action,
      t.evidence_line_id::text evidence_id,t.predecessor_evidence_line_id::text predecessor,
      t.canonical_origin_evidence_line_id::text origin FROM mdf_physical_lineage_contracts c
      JOIN mdf_physical_lineage_transitions t USING(source_kind,source_id,revision_key)
      WHERE c.source_kind='packet' AND c.source_id=$1 ORDER BY c.revision_key,t.evidence_line_id`,[packetId])).rows)
      .toEqual(lineageBefore);
    expect((await db.query(`SELECT a.allocation_id::text "allocationId",a.state,a.quantity::text quantity,
      a.bath_id "bathId",a.bath_revision "bathRevision",a.evidence_line_id::text "evidenceLineId",
      e.revision_key revision,a.order_id::int "orderId",a.detail_id::int "detailId"
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=$1 AND e.source_kind='packet' AND e.source_id=$2 ORDER BY a.allocation_id`,[bathId,packetId])).rows)
      .toEqual(pinHistoryBefore);
    expect((await db.query('SELECT 1 FROM mdf_cnc_observation_receipts WHERE claim_id=$1',[claim!.claimId])).rows).toHaveLength(0);
    expect(await snapshotRollback()).toEqual(rollbackBefore);
    const result=await observations.complete({currentUser:user,lease,requestId,report});
    expect(result).toMatchObject({status:'recorded',jobId:expect.any(String)});
    await processJob(result.jobId);
    const head=(await db.query<{accepted:string;received:string}>(`SELECT accepted_revision_key accepted,
      received_revision_key received FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0];
    expect(head).toEqual({accepted:head.received,received:head.received});
    expect((await db.query(`SELECT operation,production_authority,predecessor_accepted_revision_key
      FROM mdf_physical_lineage_contracts WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2`,
    [packetId,head.accepted])).rows).toEqual([{operation:'production',production_authority:'cnc_observation',
      predecessor_accepted_revision_key:manualHead}]);
    const transition=(await db.query<{evidenceId:string;action:string;predecessor:string;origin:string;quantity:string}>(`
      SELECT l.evidence_line_id::text "evidenceId",t.action,t.predecessor_evidence_line_id::text predecessor,
        t.canonical_origin_evidence_line_id::text origin,l.quantity::text quantity
      FROM mdf_physical_lineage_transitions t JOIN mdf_evidence_lines l USING(evidence_line_id)
      WHERE t.source_kind='packet' AND t.source_id=$1 AND t.revision_key=$2 AND l.evidence_kind='physical'`,
    [packetId,head.accepted])).rows;
    expect(transition).toEqual([{evidenceId:expect.any(String),action:'carry',predecessor:parent.evidenceLineId,
      origin:parent.origin,quantity:'2'}]);
    const pinHistory=(await db.query(`SELECT a.allocation_id::text "allocationId",a.state,a.quantity::text quantity,
      a.bath_id "bathId",a.bath_revision "bathRevision",a.evidence_line_id::text "evidenceLineId",
      e.revision_key revision,a.order_id::int "orderId",a.detail_id::int "detailId"
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.bath_id=$1 AND e.source_kind='packet' AND e.source_id=$2 ORDER BY a.allocation_id`,[bathId,packetId])).rows;
    expect(pinHistory).toHaveLength(pinHistoryBefore.length+1);
    for (const previousPin of pinHistoryBefore) {
      const expectedPrevious=previousPin.allocationId===pinsBefore[0].allocationId
        ? {...previousPin,state:'released'} : previousPin;
      expect(pinHistory.find(row=>row.allocationId===previousPin.allocationId)).toEqual(expectedPrevious);
    }
    const newPins=pinHistory.filter(row=>!pinHistoryBefore.some(previous=>previous.allocationId===row.allocationId));
    expect(newPins).toEqual([expect.objectContaining({state,quantity:'2',
      bathId,bathRevision:pinsBefore[0].bathRevision,evidenceLineId:transition[0].evidenceId,revision:head.accepted,
      orderId:f.orderId,detailId:f.detailId})]);
    const revisionCount=Number((await db.query(`SELECT count(*)::text count FROM mdf_evidence_revisions
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].count);
    expect(await observations.complete({currentUser:user,lease,requestId,report})).toEqual(result);
    expect(Number((await db.query(`SELECT count(*)::text count FROM mdf_evidence_revisions
      WHERE source_kind='packet' AND source_id=$1`,[packetId])).rows[0].count)).toBe(revisionCount);
    expect((await db.query(`SELECT count(*)::int count FROM mdf_cnc_observation_job_authorities
      WHERE packet_id=$1 AND claim_id=$2`,[packetId,claim!.claimId])).rows[0].count).toBe(1);
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
