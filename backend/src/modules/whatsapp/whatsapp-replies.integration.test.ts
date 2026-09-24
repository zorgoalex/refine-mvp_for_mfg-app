import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../database/database.service';
import type { BackendEnv } from '../../config/env.validation';
import type { PerformanceQueryTelemetryService } from '../../performance/performance-query-telemetry.service';
import type { CurrentUser } from '../../permissions/current-user';
import { WhatsAppRepository } from './whatsapp.repository';
import { parseRuleInput, parseTemplateInput } from './whatsapp.dto';

const suite = process.env.WHATSAPP_REPLIES_DOCKER_TEST === 'true' ? describe : describe.skip;
const actor: CurrentUser = { id: '1', username: 'E2E-Тест', role: 'admin', roleId: 1, permissions: ['whatsapp.manage'] };
suite('WhatsApp reply snapshots — isolated PostgreSQL', () => {
  const schema = `e2e_wa_reply_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool, db: DatabaseService, repo: WhatsAppRepository;
  beforeAll(async () => {
    const [container] = JSON.parse(execFileSync('docker', ['inspect', 'erp_test-postgresdb-1'], { encoding: 'utf8' }));
    const env = Object.fromEntries(container.Config.Env.map((entry: string) => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
    const network = Object.values(container.NetworkSettings.Networks)[0] as { IPAddress: string };
    const url = new URL(`postgresql://${network.IPAddress}:5432/${env.POSTGRES_DB ?? 'erpdb'}`);
    url.username = env.POSTGRES_USER; url.password = env.POSTGRES_PASSWORD;
    url.searchParams.set('options', `-c search_path=${schema},pg_catalog -c max_parallel_workers_per_gather=0 -c jit=off -c lock_timeout=5000`);
    pool = new Pool({ connectionString: url.toString(), max: 4, statement_timeout: 10000 });
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE users(user_id bigint PRIMARY KEY); INSERT INTO users VALUES(1);
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY,domain text,label text,description text,sort_order integer,is_dangerous boolean,is_active boolean,updated_at timestamptz);
      CREATE TABLE roles(role_id bigint,role_code text); CREATE TABLE role_permissions(role_id bigint,permission_name text,is_enabled boolean,PRIMARY KEY(role_id,permission_name));
      CREATE TABLE permissions_state(id boolean,version integer,updated_at timestamptz);
      CREATE TABLE audit_log(LIKE public.audit_log INCLUDING ALL);
      CREATE TABLE audit_log_related_entity(LIKE public.audit_log_related_entity INCLUDING ALL);`);
    for (const file of ['152_whatsapp_admin.sql', '176_whatsapp_reply_templates.sql'])
      await pool.query(readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 10000, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 4, DATABASE_SSL: false };
    db = new DatabaseService({ get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService);
    repo = new WhatsAppRepository(db);
  }, 30000);
  afterAll(async () => {
    await db?.onModuleDestroy();
    if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); } }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE whatsapp_delivery_jobs,whatsapp_webhook_events,whatsapp_keyword_rules,whatsapp_message_templates RESTART IDENTITY CASCADE; DELETE FROM audit_log_related_entity; DELETE FROM audit_log;');
  });
  const setup = async (body = 'Заказ {id}. Ответ {counter}', bodyMode: 'text' | 'template' = 'template') => {
    const template = await repo.createTemplate(parseTemplateInput({ code: 'test_reply', name: 'Тест ответ', body, bodyMode }), actor, 'e2e-create');
    const rule = await repo.createRule(parseRuleInput({ code: 'test_rule', name: 'Тест правило', templateId: template.id,
      matchMode: 'pattern_exact', keywords: ['Заказ {id:number} готов'], replyMode: 'quote' }), actor, 'e2e-rule');
    return { template, rule };
  };
  const incoming = (id = randomUUID()) => ({ externalEventId: `h1:${id}`, providerMessageId: 'false_123@lid_private', sessionName: 'erp', chatId: '123@lid', text: 'Заказ 0022 готов', requestId: 'e2e-webhook' });
  const jobs = async () => (await pool.query('SELECT * FROM whatsapp_delivery_jobs ORDER BY delivery_job_id')).rows;
  it('allocates once under concurrent duplicates and preserves raw quote only in job', async () => {
    await setup(); const message = incoming();
    const results = await Promise.all([repo.acceptInbound(message), repo.acceptInbound(message)]);
    expect(results.filter(r => r.duplicate)).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
    expect((await jobs())[0]).toMatchObject({ body: 'Заказ 0022. Ответ 1', reply_to: message.providerMessageId, counter_value: '1', reply_mode: 'quote', state: 'pending' });
    const log = JSON.stringify((await pool.query('SELECT metadata_json,before_json,after_json FROM audit_log')).rows);
    expect(log).not.toContain('false_123'); expect(log).not.toContain('0022');
  });
  it('allocates unique counters across different concurrent messages', async () => {
    await setup(); await Promise.all([repo.acceptInbound(incoming()), repo.acceptInbound(incoming()), repo.acceptInbound(incoming())]);
    expect((await jobs()).map(j => j.counter_value)).toEqual(['1', '2', '3']);
  });
  it('keeps snapshot unchanged across rule edits and manual retries', async () => {
    const { template, rule } = await setup(); await repo.acceptInbound(incoming()); const before = (await jobs())[0];
    await repo.updateTemplate(template.id, { version: 1, body: 'Новый {id} {counter}' }, actor, 'e2e-edit');
    await repo.updateRule(rule.id, { version: 1, replyMode: 'plain' }, actor, 'e2e-edit');
    await pool.query("UPDATE whatsapp_delivery_jobs SET state='failed'");
    await repo.retryJob(Number(before.delivery_job_id), actor, 'e2e-retry');
    const after = (await jobs())[0];
    for (const key of ['body', 'reply_to', 'reply_mode', 'counter_value', 'rendered_at']) expect(after[key]).toEqual(before[key]);
  });
  it('rejects incompatible template/rule updates and retains version', async () => {
    const { template, rule } = await setup();
    await expect(repo.updateTemplate(template.id, { version: 1, body: '{other}' }, actor, 'e2e-invalid')).rejects.toMatchObject({ code: 'WHATSAPP_TEMPLATE_INVALID' });
    await expect(repo.updateRule(rule.id, { version: 1, keywords: ['готов'] }, actor, 'e2e-invalid')).rejects.toMatchObject({ code: 'WHATSAPP_TEMPLATE_INVALID' });
    expect((await repo.listTemplates())[0].version).toBe(1);
    expect((await repo.listRules())[0].version).toBe(1);
  });
  it('validates against every linked rule, including disabled rules', async () => {
    const { template } = await setup('ok', 'text');
    await repo.createRule(parseRuleInput({ code: 'test_second', name: 'Тест другое', templateId: template.id, matchMode: 'exact_any', keywords: ['готов'], enabled: false }), actor, 'e2e-other');
    await expect(repo.updateTemplate(template.id, { version: 1, body: '{id}', bodyMode: 'template' }, actor, 'e2e-invalid')).rejects.toMatchObject({ code: 'WHATSAPP_TEMPLATE_INVALID' });
  });
  it('records rendering failures once without consuming counter or sending partial response', async () => {
    await setup('{id}'.repeat(1024)); const message = { ...incoming(), text: 'Заказ 12345 готов' };
    expect(await repo.acceptInbound(message)).toEqual({ duplicate: false, result: 'failed' });
    expect((await jobs())[0]).toMatchObject({ state: 'failed', body: null, error_code: 'WHATSAPP_TEMPLATE_INVALID' });
    expect(await repo.acceptInbound(message)).toMatchObject({ duplicate: true });
    expect((await pool.query('SELECT result_code FROM whatsapp_webhook_events')).rows[0].result_code).toBe('failed');
  });
  it('fails closed when original quote ID is absent; plain mode does not store it', async () => {
    const { rule } = await setup(); await repo.acceptInbound({ ...incoming(), providerMessageId: undefined });
    expect((await jobs())[0].error_code).toBe('WHATSAPP_REPLY_TARGET_MISSING');
    await repo.updateRule(rule.id, { version: 1, replyMode: 'plain' }, actor, 'e2e-plain');
    await repo.acceptInbound(incoming());
    expect((await jobs())[1]).toMatchObject({ reply_to: null, reply_mode: 'plain', counter_value: '1' });
  });
  it('cleans raw quote IDs with expired terminal bodies, retains pending jobs', async () => {
    await setup(); await repo.acceptInbound(incoming()); await repo.acceptInbound(incoming());
    await pool.query("UPDATE whatsapp_delivery_jobs SET body_expires_at=now()-interval '1 second'; UPDATE whatsapp_delivery_jobs SET state='sent' WHERE delivery_job_id=1");
    await repo.cleanupExpired();
    expect((await jobs())[0]).toMatchObject({ reply_to: null, body: null, destination: null });
    expect((await jobs())[1].reply_to).toBe('false_123@lid_private');
  });
  it('legacy defaults retain literal braces and do not allocate counter', async () => {
    const template = await repo.createTemplate(parseTemplateInput({ code: 'test_legacy', name: 'Тест', body: '{counter}' }), actor, 'e2e');
    await repo.createRule(parseRuleInput({ code: 'test_legacy', name: 'Тест', templateId: template.id, matchMode: 'contains_any', keywords: ['готов'] }), actor, 'e2e');
    await repo.acceptInbound(incoming());
    expect((await jobs())[0]).toMatchObject({ body: '{counter}', reply_mode: 'plain', reply_to: null, counter_value: null });
  });
  it('rolls back counter and dedup receipt if durable job insertion fails', async () => {
    await setup(); const message = incoming();
    await pool.query(`CREATE FUNCTION reject_test_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'E2E fault'; END $$;
      CREATE TRIGGER reject_test_job BEFORE INSERT ON whatsapp_delivery_jobs FOR EACH ROW EXECUTE FUNCTION reject_test_job();`);
    try {
      await expect(repo.acceptInbound(message)).rejects.toThrow('E2E fault');
      expect((await pool.query('SELECT counter_value FROM whatsapp_keyword_rules')).rows[0].counter_value).toBe('0');
      expect((await pool.query('SELECT * FROM whatsapp_webhook_events')).rowCount).toBe(0);
    } finally { await pool.query('DROP TRIGGER reject_test_job ON whatsapp_delivery_jobs; DROP FUNCTION reject_test_job()'); }
    await repo.acceptInbound(message);
    expect((await jobs())[0].counter_value).toBe('1');
  });
  it('concurrent incompatible config writes cannot commit an invalid pair', async () => {
    const { template, rule } = await setup('OK', 'text');
    const results = await Promise.allSettled([
      repo.updateTemplate(template.id, { version: 1, body: '{id}', bodyMode: 'template' }, actor, 'e2e-template'),
      repo.updateRule(rule.id, { version: 1, keywords: ['Готов'] }, actor, 'e2e-rule'),
    ]);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
});
