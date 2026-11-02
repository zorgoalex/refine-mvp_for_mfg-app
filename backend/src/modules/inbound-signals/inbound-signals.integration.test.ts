import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../database/database.service';
import type { BackendEnv } from '../../config/env.validation';
import type { PerformanceQueryTelemetryService } from '../../performance/performance-query-telemetry.service';
import type { CurrentUser } from '../../permissions/current-user';
import { ROLE_POLICIES } from '../../permissions/policies/role-policies';
import { InboundSignalsService } from './inbound-signals.service';
import type { InboundMessage, SignalConfiguration } from './inbound-signals.domain';

const suite = process.env.INBOUND_SIGNALS_DOCKER_TEST === 'true' ? describe : describe.skip;
const admin: CurrentUser = { id: '1', username: 'test-admin', role: 'admin', roleId: 1,
  permissions: ['orders.view','message_signals.view','message_signals.resolve','message_signals.manage_config','message_signals.technical'] };
const manager: CurrentUser = { id: '2', username: 'test-manager', role: 'manager', roleId: 10,
  permissions: ['orders.view','message_signals.view'], policyScopes: { ...ROLE_POLICIES.manager, orders: { ...ROLE_POLICIES.manager.orders, view: 'own' } } };
const configuration: SignalConfiguration = {
  version: 1, sources: [{ code: 'shop', name: 'Цех', channel: 'whatsapp', connection: 'erp', chatId: '123@g.us', enabled: true }],
  signals: [{ code: 'ready', name: 'Готов' }, { code: 'packed', name: 'Упакован' }],
  resolvers: [{ code: 'order', name: 'Заказ', target: 'order_id', prefixes: ['заказ'], format: 'digits' }],
  rules: [{ code: 'ready', name: 'Готов', sourceCodes: ['shop'], signalCode: 'ready', resolverCode: 'order', keywords: ['готов'], exclusions: ['не готов'], matchMode: 'phrase', enabled: true, priority: 100 }],
};
const incoming = (text = 'Заказ 1 готов'): InboundMessage => ({ channel: 'whatsapp', connection: 'erp', chatId: '123@g.us',
  sender: 'private-sender@lid', externalId: randomUUID(), text, sentAt: new Date() });

suite('Inbound signals — real PostgreSQL transactions, scopes, retention', () => {
  const schema = `e2e_inbound_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool, db: DatabaseService, service: InboundSignalsService;
  let owner: 'none'|'in_process' = 'in_process';
  beforeAll(async () => {
    const [container] = JSON.parse(execFileSync('docker', ['inspect', 'erp_test-postgresdb-1'], { encoding: 'utf8' }));
    const env = Object.fromEntries(container.Config.Env.map((entry: string) => { const i = entry.indexOf('='); return [entry.slice(0,i), entry.slice(i+1)]; }));
    const network = Object.values(container.NetworkSettings.Networks)[0] as { IPAddress: string };
    const url = new URL(`postgresql://${network.IPAddress}:5432/${env.POSTGRES_DB ?? 'erpdb'}`);
    url.username = env.POSTGRES_USER; url.password = env.POSTGRES_PASSWORD;
    // No public fallback: a missing fixture table/function must fail, never touch operational data.
    url.searchParams.set('options', `-c search_path=${schema},pg_catalog -c max_parallel_workers_per_gather=0 -c jit=off -c lock_timeout=5000`);
    pool = new Pool({ connectionString: url.toString(), max: 4, statement_timeout: 10000 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE users(user_id bigint PRIMARY KEY,employee_id bigint,is_active boolean DEFAULT true);
      INSERT INTO users(user_id) VALUES(1),(2),(3);
      CREATE TABLE orders(order_id bigint PRIMARY KEY,order_name text,client_id bigint,project_id bigint,created_by bigint,manager_id bigint,
        delete_flag boolean DEFAULT false,order_status_id integer DEFAULT 4,payment_status_id integer DEFAULT 1,
        production_status_id smallint,production_status_from_details_enabled boolean DEFAULT true,
        version integer DEFAULT 1,order_kind text DEFAULT 'production_order',order_date date DEFAULT CURRENT_DATE,
        planned_completion_date date,final_amount numeric DEFAULT 0,paid_amount numeric DEFAULT 0,updated_at timestamptz DEFAULT now());
      CREATE TABLE order_workshops(order_id bigint,responsible_employee_id bigint,delete_flag boolean DEFAULT false);
      CREATE TABLE order_details(detail_id bigint PRIMARY KEY,order_id bigint,production_status_id smallint,delete_flag boolean DEFAULT false,updated_at timestamptz);
      CREATE TABLE order_hdf_details(hdf_detail_id bigint,order_id bigint,production_status_id smallint);
      CREATE TABLE production_statuses(production_status_id smallint PRIMARY KEY,sort_order integer,production_status_name text,production_status_code text,is_active boolean DEFAULT true);
      CREATE TABLE order_statuses(order_status_id integer PRIMARY KEY,order_status_name text,is_active boolean DEFAULT true,order_status_code text);
      CREATE TABLE bazis_order_links(order_id bigint);
      CREATE TABLE order_import_entity_map(local_order_id bigint);
      CREATE TABLE cut_job_item(order_id bigint,cut_job_id bigint,is_active boolean DEFAULT true);
      CREATE TABLE projects(project_id bigint PRIMARY KEY,code text,delete_flag boolean DEFAULT false);
      CREATE TABLE status_automation_rules(LIKE public.status_automation_rules INCLUDING ALL);
      CREATE TABLE audit_log(LIKE public.audit_log INCLUDING ALL);
      CREATE TABLE audit_log_related_entity(LIKE public.audit_log_related_entity INCLUDING ALL);
      CREATE TABLE outbox_events(LIKE public.outbox_events INCLUDING ALL);
      CREATE VIEW orders_view AS SELECT order_id,order_name FROM orders;
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY,domain text,label text,description text,sort_order integer,is_dangerous boolean,is_active boolean);
      CREATE TABLE roles(role_id bigint PRIMARY KEY,role_code text);
      INSERT INTO roles VALUES(1,'admin'),(2,'superadmin'),(10,'manager'),(15,'top_manager');
      CREATE TABLE role_permissions(role_id bigint,permission_name text,is_enabled boolean,PRIMARY KEY(role_id,permission_name));
      CREATE TABLE permissions_state(id boolean PRIMARY KEY,version integer,updated_at timestamptz);
      INSERT INTO permissions_state VALUES(true,1,now());
      INSERT INTO order_statuses VALUES(4,'В работе',true),(6,'Готов',true);
    `);
    for (const file of ['155_order_production_composition.sql','173_inbound_signals.sql','289_inbound_signal_segments.sql']) {
      await pool.query(readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 10000, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 4, DATABASE_SSL: false, BACKEND_ENABLE_INBOUND_SIGNALS: true };
    const config = { get: (key: keyof BackendEnv) => key === 'BACKEND_INBOUND_SIGNALS_RELAY_OWNER' ? owner : values[key] } as ConfigService<BackendEnv,true>;
    db = new DatabaseService(config, { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService);
    service = new InboundSignalsService(db, config);
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true');
  }, 30000);
  afterAll(async () => {
    vi.unstubAllEnvs(); service?.onModuleDestroy(); await db?.onModuleDestroy();
    if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); } }
  });
  beforeEach(async () => {
    owner = 'in_process';
    await pool.query(`TRUNCATE inbound_messages,inbound_signal_occurrences,inbound_signal_steps,inbound_message_receipts,inbound_signal_commands RESTART IDENTITY CASCADE;
      DELETE FROM status_automation_rules; DELETE FROM audit_log_related_entity; DELETE FROM audit_log; DELETE FROM outbox_events;
      DELETE FROM orders;
      INSERT INTO orders(order_id,order_name,created_by,manager_id) VALUES(1,'Own',2,2),(2,'Other',3,3);
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version)
      OVERRIDING SYSTEM VALUE VALUES(901,'Ready','message.signal_detected','change_order_status',6,'{"signalCodeIn":["ready"]}',100,true,1);`);
    const { version, ...document } = configuration;
    await pool.query(`UPDATE message_processing_configuration SET version=$1,document=$2,source_activation=$3`, [version,document,{ shop: new Date(Date.now()-60000).toISOString() }]);
  });
  const row = async () => (await pool.query('SELECT * FROM inbound_signal_occurrences ORDER BY id LIMIT 1')).rows[0];
  it('provides names and codes to automation readers without exposing group configuration', async () => {
    const reader: CurrentUser = { ...manager, permissions: ['status_automation.view'] };
    expect(await service.signalOptions(reader)).toEqual(configuration.signals);
    await expect(service.getConfiguration(reader)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.signalOptions(manager)).rejects.toMatchObject({ statusCode: 403 });
    await pool.query(`UPDATE message_processing_configuration SET document=jsonb_set(document,'{signals}','[]')`);
    expect(await service.signalOptions(reader)).toEqual([]);
  });
  it('deduplicates concurrent deliveries and executes status/audit/outbox/job exactly once', async () => {
    const message = incoming();
    await Promise.all([service.accept(message,'test-1'),service.accept(message,'test-2')]);
    expect((await pool.query('SELECT * FROM inbound_messages')).rowCount).toBe(1);
    await Promise.all([service.processBatch(),service.processBatch()]);
    expect((await row()).state).toBe('succeeded');
    expect((await pool.query('SELECT order_status_id,version FROM orders WHERE order_id=1')).rows[0]).toEqual({ order_status_id: 6, version: 2 });
    expect((await pool.query('SELECT * FROM outbox_events')).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM audit_log WHERE event='orders.status_change' AND user_id IS NULL")).rowCount).toBe(1);
    const durable = JSON.stringify((await pool.query('SELECT metadata_json FROM audit_log')).rows) + JSON.stringify((await pool.query('SELECT payload_json FROM outbox_events')).rows);
    expect(durable).not.toContain(message.text); expect(durable).not.toContain(message.sender); expect(durable).not.toContain(message.chatId);
    await service.processBatch(); expect((await pool.query('SELECT version FROM orders WHERE order_id=1')).rows[0].version).toBe(2);
  });
  it('scopes list, counts, search and detail; unresolved/diagnostic never leak to manager', async () => {
    await service.accept(incoming(),'own'); await service.accept(incoming('Заказ 2 готов'),'other');
    await service.accept(incoming('Готов'),'unresolved'); await service.accept(incoming('no-keywords'),'unmatched');
    expect((await service.list({},admin)).total).toBe(3);
    expect((await service.list({ diagnostic:'true' },admin)).total).toBe(4);
    const list = await service.list({ diagnostic:'true' },manager);
    expect(list.total).toBe(1); expect(list.attention).toBe(0);
    expect((await service.list({ q:'Заказ 2' },manager)).total).toBe(0);
    await expect(service.detail('2',manager)).rejects.toMatchObject({ statusCode: 404 });
    const detail = await service.detail('1',manager); expect(detail.technical).toBeUndefined();
    expect((await service.detail('1',admin)).technical).toBeDefined();
  });
  it('does not act on unknown sources, pre-activation messages, ambiguous or partially unknown references', async () => {
    await service.accept({ ...incoming(), chatId:'999@g.us' },'unknown');
    await service.accept({ ...incoming(), sentAt:new Date(0) },'old');
    expect((await pool.query('SELECT * FROM inbound_messages')).rowCount).toBe(0);
    // Several numbers in one line: a signal per order (decision of the user 02.11); one unknown number → the whole line to review.
    await service.accept(incoming('Заказ 1 готов; заказ 2 готов'),'two-orders');
    await service.accept(incoming('Заказ 1 готов; заказ 999 готов'),'partial');
    expect((await pool.query('SELECT state,order_id FROM inbound_signal_occurrences ORDER BY id')).rows)
      .toEqual([{ state:'pending', order_id:'1' },{ state:'pending', order_id:'2' },{ state:'needs_review', order_id:null }]);
  });
  it('queue owner none pauses actions while intake remains available', async () => {
    owner='none'; await service.accept(incoming(),'paused'); await service.processBatch();
    expect((await row()).state).toBe('pending'); expect((await row()).attempt_count).toBe(0);
  });
  it('leaves unconfigured groups to existing webhook ignore logging', async () => {
    expect(await service.acceptWaha({ event:'message',session:'erp',payload:{ id:'unknown-group',from:'999@g.us',fromMe:false,timestamp:Date.now()/1000,body:'готов' } },'erp','ignore')).toBe(false);
  });
  it('project resolver rejects multiple orders; unique non-deleted project resolves', async () => {
    await pool.query("INSERT INTO projects VALUES(1,'mp-1',false); UPDATE orders SET project_id=1 WHERE order_id IN (1,2)");
    const projectConfig = { ...configuration, resolvers:[{ ...configuration.resolvers[0],target:'project_code',prefixes:['проект'],format:'code' }] };
    await pool.query('UPDATE message_processing_configuration SET document=$1',[projectConfig]);
    await service.accept(incoming('Проект MP-1 готов'),'project-many'); expect((await row()).state).toBe('needs_review');
    await pool.query('UPDATE orders SET project_id=NULL WHERE order_id=2');
    await service.accept(incoming('Проект MP-1 готов'),'project-one');
    expect((await pool.query('SELECT order_id FROM inbound_signal_occurrences ORDER BY id DESC LIMIT 1')).rows[0].order_id).toBe('1');
    await pool.query('DELETE FROM projects');
  });
  it('cut resolver ignores inactive links and refuses multi-order cuts', async () => {
    await pool.query('INSERT INTO cut_job_item VALUES(1,50,true),(2,50,true)');
    await pool.query('UPDATE message_processing_configuration SET document=$1',[
      { ...configuration,resolvers:[{ ...configuration.resolvers[0],target:'cut_id',prefixes:['раскрой'] }] },
    ]);
    try {
      await service.accept(incoming('Раскрой 50 готов'),'cut-many');
      expect((await row()).state).toBe('needs_review');
      await pool.query('UPDATE cut_job_item SET is_active=false WHERE order_id=2');
      await service.accept(incoming('Раскрой 50 готов'),'cut-one');
      expect((await pool.query('SELECT order_id FROM inbound_signal_occurrences ORDER BY id DESC LIMIT 1')).rows[0].order_id).toBe('1');
    } finally { await pool.query('DELETE FROM cut_job_item'); }
  });
  it('creates all distinct signal codes while folding rules for the same code', async () => {
    await pool.query('UPDATE message_processing_configuration SET document=$1',[{ ...configuration,rules:[
      configuration.rules[0],{ ...configuration.rules[0],code:'ready-also' },
      { ...configuration.rules[0],code:'packed',signalCode:'packed' },
    ] }]);
    await service.accept(incoming(),'many-signals');
    const signals=(await pool.query('SELECT signal_code,rule_codes FROM inbound_signal_occurrences ORDER BY signal_code')).rows;
    expect(signals).toEqual([{ signal_code:'packed',rule_codes:['packed'] },{ signal_code:'ready',rule_codes:['ready','ready-also'] }]);
  });
  it('disabled source after intake requires review without business writes', async () => {
    await service.accept(incoming(),'source-disabled');
    await pool.query('UPDATE message_processing_configuration SET version=version+1,document=$1',[
      { ...configuration,sources:[{ ...configuration.sources[0],enabled:false }] },
    ]);
    await service.processBatch();
    expect((await row()).state).toBe('needs_review');
    expect((await pool.query('SELECT * FROM outbox_events')).rowCount).toBe(0);
  });
  it('requires fresh manual preview; resolves idempotently; completed cannot retarget', async () => {
    await service.accept(incoming('готов'),'manual');
    const signal = await row();
    const preview = await service.previewResolve(signal.id,{ version:signal.version,orderId:1 },admin);
    const body = { version:signal.version,orderId:1,previewHash:preview.previewHash }, key=randomUUID();
    const first = await service.command(signal.id,'resolve',body,key,admin,'manual-command');
    expect(await service.command(signal.id,'resolve',body,key,admin,'manual-replay')).toEqual(first);
    await service.processBatch(); expect((await row()).state).toBe('succeeded');
    await expect(service.command(signal.id,'retry',{ version:(await row()).version },randomUUID(),admin,'bad-retry')).rejects.toMatchObject({ statusCode:409 });
  });
  it('changed order after confirmation moves queued manual action back to review', async () => {
    await service.accept(incoming('готов'),'manual'); const signal=await row();
    const preview=await service.previewResolve(signal.id,{ version:signal.version,orderId:1 },admin);
    await service.command(signal.id,'resolve',{ version:signal.version,orderId:1,previewHash:preview.previewHash },randomUUID(),admin,'manual-command');
    await pool.query('UPDATE orders SET version=version+1 WHERE order_id=1');
    await service.processBatch(); expect((await row()).reason_code).toBe('preview_changed');
    expect((await pool.query('SELECT * FROM outbox_events')).rowCount).toBe(0);
  });
  it('manual retry preserves approval fingerprint and rejects changed rules', async () => {
    await service.accept(incoming('готов'),'manual'); const signal=await row();
    const preview=await service.previewResolve(signal.id,{ version:signal.version,orderId:1 },admin);
    await service.command(signal.id,'resolve',{ version:signal.version,orderId:1,previewHash:preview.previewHash },randomUUID(),admin,'manual-command');
    await pool.query("UPDATE inbound_signal_occurrences SET state='failed',attempt_count=5");
    const failed=await row();
    await service.command(failed.id,'retry',{ version:failed.version },randomUUID(),admin,'retry');
    expect((await row()).execution_guard).toBe(failed.execution_guard);
    await pool.query('UPDATE status_automation_rules SET version=version+1');
    await service.processBatch(); expect((await row()).reason_code).toBe('preview_changed');
  });
  it('recovers abandoned claims with a new token and respects retry limit', async () => {
    await service.accept(incoming(),'stale');
    await pool.query("UPDATE inbound_signal_occurrences SET state='processing',lock_token=$1,locked_at=now()-interval '6 minutes',attempt_count=1",[randomUUID()]);
    await service.processBatch(); expect((await row()).state).toBe('succeeded');
  });
  it('rollback after business write leaves no order change, audit or outbox; safe retry completes', async () => {
    await service.accept(incoming(),'rollback');
    await pool.query(`CREATE FUNCTION reject_signal_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='succeeded' THEN RAISE EXCEPTION 'test fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_signal_finish BEFORE UPDATE ON inbound_signal_occurrences FOR EACH ROW EXECUTE FUNCTION reject_signal_finish();`);
    try {
      await service.processBatch(); expect((await row()).state).toBe('retry_wait');
      expect((await pool.query('SELECT order_status_id FROM orders WHERE order_id=1')).rows[0].order_status_id).toBe(4);
      expect((await pool.query('SELECT * FROM outbox_events')).rowCount).toBe(0);
      expect((await pool.query("SELECT * FROM audit_log WHERE event='orders.status_change'")).rowCount).toBe(0);
    } finally { await pool.query('DROP TRIGGER reject_signal_finish ON inbound_signal_occurrences; DROP FUNCTION reject_signal_finish()'); }
    await pool.query('UPDATE inbound_signal_occurrences SET next_attempt_at=now()');
    await service.processBatch(); expect((await row()).state).toBe('succeeded');
  });
  describe('several signals in one message', () => {
    const units = async () => (await pool.query(`SELECT order_id,state,reason_code,segment_index,segment_text,visible_text,group_references
      FROM inbound_signal_occurrences ORDER BY id`)).rows;
    it('a multi-line message becomes one signal per order and each is applied to its own order', async () => {
      await service.accept(incoming('Заказ 1 готов\nЗаказ 2 готов'),'two-lines');
      expect((await units()).map(u => [u.order_id, u.state, u.segment_index])).toEqual([['1','pending',0],['2','pending',1]]);
      await service.processBatch();
      expect((await units()).map(u => u.state)).toEqual(['succeeded','succeeded']);
      expect((await pool.query('SELECT order_id,order_status_id FROM orders ORDER BY order_id')).rows).toEqual([{ order_id:'1', order_status_id:6 },{ order_id:'2', order_status_id:6 }]);
      expect((await pool.query('SELECT * FROM outbox_events')).rowCount).toBe(2);
    });
    it('a header with number lines; a footer; an unknown number sends the whole group to review', async () => {
      await service.accept(incoming('Заказчик готов, заказ\n1\n2'),'header');
      await service.accept(incoming('Заказ 1\nЗаказ 999\nГотов'),'footer-unknown');
      expect((await units()).map(u => [u.order_id, u.state, u.reason_code])).toEqual([['1','pending',null],['2','pending',null],[null,'needs_review','reference_not_found']]);
    });
    it('a sibling reference of the same group that changed before the worker sends the unit to review; the own order is untouched', async () => {
      // One group (one line, two numbers); separate lines are separate groups and do not depend on each other.
      await service.accept(incoming('Заказ 1, 2 готов'),'changed');
      await pool.query('UPDATE orders SET delete_flag=true WHERE order_id=2');
      await service.processBatch();
      expect((await units()).map(u => [u.order_id, u.state, u.reason_code])).toEqual([['1','needs_review','reference_changed'],['2','needs_review','order_unavailable']]);
      expect((await pool.query('SELECT order_status_id FROM orders WHERE order_id=1')).rows[0].order_status_id).toBe(4);
      await pool.query('UPDATE orders SET delete_flag=false WHERE order_id=2');
    });
    it('a redelivered message creates no duplicates; an old single-line message keeps the old shape', async () => {
      const message = incoming('Заказ 1 готов\nЗаказ 2 готов');
      await Promise.all([service.accept(message,'a'),service.accept(message,'b')]);
      await service.accept(incoming('Заказ 1 готов'),'single');
      expect((await units()).map(u => [u.order_id, u.segment_text === null])).toEqual([['1',false],['2',false],['1',true]]);
    });
    it('a scoped user sees only the own masked fragment: list, search, count, detail and history', async () => {
      await service.accept(incoming('Заказ 1, 2 готов\nЗаказ 2 әлі дайын емес'),'mixed');
      const list = await service.list({},manager);
      expect(list.total).toBe(1);
      expect(list.items[0].message_text).toBe('Заказ 1, … готов');
      expect(JSON.stringify(list)).not.toContain('дайын');
      expect((await service.list({ q:'дайын' },manager)).total).toBe(0);
      const detail = await service.detail(String(list.items[0].id),{ ...manager, permissions:[...manager.permissions,'message_signals.technical'] });
      expect(JSON.stringify(detail)).not.toMatch(/дайын|"2"|, 2/);
      expect(detail.fragment).toBe('Заказ 1, … готов');
      const full = await service.detail(String(list.items[0].id),admin);
      expect(full.message.message_text).toContain('әлі дайын емес');
    });
    it('a re-assigned unit is re-projected for its new order; history hides the earlier order', async () => {
      await service.accept(incoming('Заказ 2 готов\nЗаказ 999 готов'),'review');
      // The unit of order 2 goes to review (e.g. after a configuration change) and is re-assigned to order 1.
      await pool.query("UPDATE inbound_signal_occurrences SET state='needs_review',reason_code='configuration_changed',version=version+1 WHERE order_id=2");
      const signal = (await pool.query('SELECT * FROM inbound_signal_occurrences WHERE order_id=2')).rows[0];
      const preview = await service.previewResolve(signal.id,{ version:signal.version,orderId:1 },admin);
      await service.command(signal.id,'resolve',{ version:signal.version,orderId:1,previewHash:preview.previewHash },randomUUID(),admin,'reassign');
      expect((await pool.query('SELECT visible_text FROM inbound_signal_occurrences WHERE id=$1',[signal.id])).rows[0].visible_text).toBe('Заказ … готов');
      for (const permissions of [manager.permissions, [...manager.permissions,'message_signals.technical']]) {
        const detail = await service.detail(signal.id,{ ...manager, permissions: permissions as CurrentUser['permissions'] });
        // requestId is a random UUID (it may contain «999» by chance).
        const json = JSON.stringify(detail, (key, value) => key === 'requestId' ? undefined : value);
        expect(json).not.toContain('Заказ 2'); expect(json).not.toContain('"orderId":"2"'); expect(json).not.toContain('999');
      }
    });
    it('review r1: a repeated order joins the first unit; a change of an added reference stops it', async () => {
      await service.accept(incoming('Заказ 1 готов\nЗаказ 1, 2 готов'),'repeat');
      const rows = await units();
      expect(rows.map(u => [u.order_id, u.state, u.segment_index])).toEqual([['1','pending',0],['2','pending',1]]);
      expect(rows[0].group_references.map((r: { reference: string }) => r.reference)).toEqual(['1','2']);
      expect(rows[0].segment_text).toBe('Заказ 1 готов\nЗаказ 1, 2 готов');
      expect(rows[0].visible_text).toBe('Заказ 1 готов\nЗаказ 1, … готов');
      await pool.query('UPDATE orders SET delete_flag=true WHERE order_id=2');
      await service.processBatch();
      expect((await units()).map(u => [u.order_id, u.state, u.reason_code])).toEqual([['1','needs_review','reference_changed'],['2','needs_review','order_unavailable']]);
      expect((await pool.query('SELECT order_status_id FROM orders WHERE order_id=1')).rows[0].order_status_id).toBe(4);
      await pool.query('UPDATE orders SET delete_flag=false WHERE order_id=2');
    });
    it('review r1: an unknown number with a full stop sends its group to review', async () => {
      await service.accept(incoming('Заказ 1 готов\nЗаказ 999.'),'dot');
      expect((await units()).map(u => [u.order_id, u.state, u.reason_code])).toEqual([[null,'needs_review','reference_not_found']]);
      await service.processBatch();
      expect((await pool.query('SELECT order_status_id FROM orders WHERE order_id=1')).rows[0].order_status_id).toBe(4);
    });
    it('review r1: a number line the group did not accept is never shown to a scoped user', async () => {
      await service.accept(incoming('Заказ 1 готов\n2'),'bare');
      const list = await service.list({},manager);
      expect(list.items.map(i => i.message_text)).toEqual(['Заказ 1 готов']);
      expect((await service.list({ q:'2' },manager)).total).toBe(0);
      const detail = await service.detail(String(list.items[0].id),{ ...manager, permissions:[...manager.permissions,'message_signals.technical'] });
      expect(detail.fragment).toBe('Заказ 1 готов');
    });
    it('rollback barrier: a split message accepted before the switch is counted; the switched-off module takes and shows nothing', async () => {
      await service.accept(incoming('Заказ 1 готов\nЗаказ 2 готов'),'before-switch');
      const off = { get: (key: keyof BackendEnv) => key === 'BACKEND_ENABLE_INBOUND_SIGNALS' ? false : key === 'BACKEND_INBOUND_SIGNALS_RELAY_OWNER' ? 'none' : undefined } as ConfigService<BackendEnv,true>;
      const disabled = new InboundSignalsService(db, off);
      for (const call of [() => disabled.accept(incoming('Заказ 1 готов\nЗаказ 2 готов'),'after-switch'), () => disabled.list({},admin), () => disabled.detail('1',admin)]) {
        await expect(call()).rejects.toMatchObject({ code:'INBOUND_SIGNALS_DISABLED' });
      }
      expect(await disabled.acceptWaha({}, 'erp', 'x')).toBe(false);
      expect((await pool.query('SELECT count(*)::int AS n FROM inbound_signal_occurrences WHERE segment_text IS NOT NULL')).rows[0].n).toBe(2);
    });
    it('review r2: a code of another order written with a combining letter is never shown to a scoped user', async () => {
      await pool.query("INSERT INTO projects VALUES(1,'AA',false),(2,'МАЙ',false); UPDATE orders SET project_id=order_id");
      const projectConfig = { ...configuration, resolvers:[{ ...configuration.resolvers[0],target:'project_code',prefixes:['проект'],format:'code' }] };
      const { version, ...document } = projectConfig;
      await pool.query('UPDATE message_processing_configuration SET version=$1,document=$2',[version,document]);
      await service.accept(incoming('Проект AA, МАИ\u0306 готов'),'combining');
      expect((await units()).map(u => [u.order_id, u.state])).toEqual([['1','pending'],['2','pending']]);
      const list = await service.list({},manager);
      expect(list.items.map(i => i.message_text)).toEqual(['Проект AA, … готов']);
      for (const q of ['май', 'МАИ\u0306', 'маи']) expect((await service.list({ q },manager)).total).toBe(0);
      const detail = await service.detail(String(list.items[0].id),{ ...manager, permissions:[...manager.permissions,'message_signals.technical'] });
      expect(JSON.stringify(detail).normalize('NFKC').toLowerCase()).not.toContain('май');
      expect(detail.fragment).toBe('Проект AA, … готов');
      await pool.query('UPDATE orders SET project_id=NULL; DELETE FROM projects');
    });
    it('review r3: a fragment whose letters cannot be mapped back is hidden whole', async () => {
      await pool.query("INSERT INTO projects VALUES(1,'AA',false),(2,'BB',false); UPDATE orders SET project_id=order_id");
      const { version, ...document } = { ...configuration, resolvers:[{ ...configuration.resolvers[0],target:'project_code' as const,prefixes:['проект'],format:'code' as const }] };
      await pool.query('UPDATE message_processing_configuration SET version=$1,document=$2',[version,document]);
      await service.accept(incoming('Проект AA, ⒷⒷ готов ΟΔΟΣ'),'symbols');
      expect((await units()).map(u => [u.order_id, u.state])).toEqual([['1','pending'],['2','pending']]);
      const list = await service.list({},manager);
      expect(list.items.map(i => i.message_text)).toEqual(['…']);
      for (const q of ['ⒷⒷ', 'bb', 'ΟΔΟΣ']) expect((await service.list({ q },manager)).total).toBe(0);
      const detail = await service.detail(String(list.items[0].id),{ ...manager, permissions:[...manager.permissions,'message_signals.technical'] });
      // requestId is a random UUID (hex may contain «bb» by chance).
      expect(JSON.stringify(detail, (key, value) => key === 'requestId' ? undefined : value).normalize('NFKC').toLowerCase()).not.toMatch(/bb|οδο/);
      expect(detail.fragment).toBe('…');
      await pool.query('UPDATE orders SET project_id=NULL; DELETE FROM projects');
    });
    it('the template check keeps its array and adds units on request', async () => {
      const body = { configuration, text:'Заказ 1 готов\nЗаказ 2 готов', source:'shop' };
      expect(Array.isArray(await service.testTemplate(body,admin))).toBe(true);
      expect(await service.testTemplate({ ...body, units:true },admin)).toMatchObject({ split:true,
        units:[{ segmentIndex:0, signalCode:'ready', references:['1'] },{ segmentIndex:1, signalCode:'ready', references:['2'] }] });
    });
  });
  it('TTL removes matched and unmatched message details but dedupe survives', async () => {
    const message=incoming(); await service.accept(message,'ttl'); await service.accept(incoming('no match'),'ttl-unmatched');
    await pool.query("UPDATE inbound_messages SET expires_at=now()-interval '1 second'");
    expect((await service.list({ diagnostic:'true' },admin)).total).toBe(0);
    await service.cleanup(); expect((await pool.query('SELECT * FROM inbound_messages')).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM inbound_signal_steps')).rowCount).toBe(0);
    expect(await service.accept(message,'replay')).toEqual({ duplicate:true });
  });
});
