import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { PerformanceQueryTelemetryService } from '../../performance/performance-query-telemetry.service';
import type { CurrentUser } from '../../permissions/current-user';
import { PgOnecCommandRepository } from './adapters/pg-onec-command-repository';
import { PgOnecEtlRepository } from './adapters/pg-onec-etl-repository';
import { PgOnecRepository } from './adapters/pg-onec-repository';
import { OnecAlertProjector } from './application/onec-alert-projector';
import { OnecAuditWriter, type OnecAgentContext } from './application/onec-audit';
import { OnecCommandWakeups } from './application/onec-command-wakeups';
import { OnecCommandsService } from './application/onec-commands.service';
import { OnecAdminService } from './application/onec-admin.service';
import { OnecEtlAdminService } from './application/onec-etl-admin.service';
import { OnecEtlRevocationService } from './application/onec-etl-revocation.service';
import { OnecEtlCompletionService } from './application/onec-etl-completion.service';
import { OnecEtlIngestService } from './application/onec-etl-ingest.service';
import { OnecEtlParserService } from './application/onec-etl-parser.service';
import { OnecMonitorService } from './application/onec-monitor.service';
import type { OnecRuntimeConfig, OnecRuntimeConfigService } from './onec-runtime-config.service';

const actor = { id: '1', username: 'E2E-Тест', role: 'admin', roleId: 1, permissions: ['onec.manage', 'onec.view'] } as CurrentUser;
const actx = (requestId: string) => ({ requestId, correlationId: null });

const suite = process.env.ONEC_AGENT_DOCKER_TEST === 'true' ? describe : describe.skip;

const DB_ID = '11111111-1111-4111-8111-111111111111';
const EPOCH = '22222222-2222-4222-8222-222222222222';
const NAMESPACE = `1c-identity:v1:${DB_ID}:${EPOCH}:test`;

suite('1C agent E3a ETL — isolated PostgreSQL + real spool', () => {
  const schema = `e2e_onec_etl_${randomUUID().replaceAll('-', '')}`;
  const spoolDir = mkdtempSync(path.join(tmpdir(), 'onec-etl-test-'));
  const runtimeConfig = {
    enabled: true, agentPort: 3901, ingressSecrets: ['x'.repeat(40)], clientCertHeader: 'x-forwarded-tls-client-cert',
    sessionTtlMs: 600000, heartbeatIntervalMs: 60000, monitorOwner: 'none', monitorIntervalMs: 60000,
    etlWorkerOwner: 'none', etlSpoolDir: spoolDir, etlSpoolMinFreeBytes: 0,
  } as OnecRuntimeConfig;
  const runtime = { get: () => runtimeConfig, requireEnabled: () => undefined } as unknown as OnecRuntimeConfigService;
  let pool: Pool;
  let db: DatabaseService;
  let repo: PgOnecRepository;
  let etlRepo: PgOnecEtlRepository;
  let parser: OnecEtlParserService;
  let ingest: OnecEtlIngestService;
  let completion: OnecEtlCompletionService;
  let commands: OnecCommandsService;
  let monitor: OnecMonitorService;
  let admin: OnecEtlAdminService;
  let onecAdmin: OnecAdminService;
  let revocation: OnecEtlRevocationService;
  let generationRef = '';
  const agentA: OnecAgentContext = { agentId: 'agent-a', sourceId: 1, certId: 1, requestId: 'r-a', correlationId: null };
  const agentB: OnecAgentContext = { agentId: 'agent-b', sourceId: 2, certId: 2, requestId: 'r-b', correlationId: null };

  beforeAll(async () => {
    const [container] = JSON.parse(execFileSync('docker', ['inspect', 'erp_test-postgresdb-1'], { encoding: 'utf8' }));
    const env = Object.fromEntries(container.Config.Env.map((entry: string) => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
    const network = Object.values(container.NetworkSettings.Networks)[0] as { IPAddress: string };
    const url = new URL(`postgresql://${network.IPAddress}:5432/${env.POSTGRES_DB ?? 'erpdb'}`);
    url.username = env.POSTGRES_USER;
    url.password = env.POSTGRES_PASSWORD;
    url.searchParams.set('options', `-c search_path=${schema},pg_catalog -c jit=off -c lock_timeout=5000`);
    pool = new Pool({ connectionString: url.toString(), max: 6, statement_timeout: 20000 });
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE users(user_id bigint PRIMARY KEY, username text); INSERT INTO users VALUES (1, 'E2E-Тест');
      CREATE TABLE roles(role_id bigint, role_code text); INSERT INTO roles VALUES (1, 'admin');
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, domain text, label text, description text, sort_order integer, is_dangerous boolean, is_active boolean, updated_at timestamptz);
      CREATE TABLE role_permissions(role_id bigint, permission_name text, is_enabled boolean, PRIMARY KEY(role_id, permission_name));
      CREATE TABLE permissions_state(id boolean, version integer, updated_at timestamptz); INSERT INTO permissions_state VALUES (true, 1, now());
      CREATE TABLE audit_log(LIKE public.audit_log INCLUDING ALL);
      CREATE TABLE audit_log_related_entity(LIKE public.audit_log_related_entity INCLUDING ALL);`);
    for (const file of ['193_onec_agent_foundation.sql', '196_onec_agent_commands.sql', '198_onec_etl.sql', '200_onec_etl_snapshots_revocation.sql']) {
      await pool.query(readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 20000, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 6, DATABASE_SSL: false };
    db = new DatabaseService(
      { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService,
    );
    repo = new PgOnecRepository(db);
    etlRepo = new PgOnecEtlRepository(db);
    parser = new OnecEtlParserService(etlRepo, repo, runtime);
    ingest = new OnecEtlIngestService(etlRepo, repo, runtime, parser);
    const audit = new OnecAuditWriter(repo);
    completion = new OnecEtlCompletionService(etlRepo, repo, audit, parser);
    const commandsRepo = new PgOnecCommandRepository(db);
    commands = new OnecCommandsService(commandsRepo, repo, audit, new OnecCommandWakeups(db, runtime), runtime, etlRepo);
    revocation = new OnecEtlRevocationService(etlRepo, runtime);
    monitor = new OnecMonitorService(runtime, repo, db, new OnecAlertProjector(repo), commandsRepo, etlRepo, audit, revocation);
    onecAdmin = new OnecAdminService(repo, audit, runtime, etlRepo, revocation);
    admin = new OnecEtlAdminService(etlRepo, repo, runtime);
  }, 60000);

  afterAll(async () => {
    await db?.onModuleDestroy();
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    }
    rmSync(spoolDir, { recursive: true, force: true });
  });

  let sessionA = '';
  beforeEach(async () => {
    await pool.query(`TRUNCATE onec_etl_staging_rows, onec_etl_mirror_rows, onec_etl_entity_state, onec_etl_batches, onec_etl_runs,
      onec_agent_commands, onec_alerts, onec_outbox_events, onec_audit_links, onec_agent_incidents,
      onec_agent_sessions, onec_agent_certificates, onec_agents, onec_sources RESTART IDENTITY CASCADE;
      DELETE FROM audit_log_related_entity; DELETE FROM audit_log;
      INSERT INTO onec_sources (code, display_name, identity, identity_status)
        VALUES ('a', 'Тест A', '{"databaseId":"${DB_ID}","exportEpoch":"${EPOCH}","environment":"test"}', 'bound'), ('b', 'Тест B', NULL, 'unverified');
      INSERT INTO onec_agents (agent_id, source_id, site_id, display_name) VALUES ('agent-a', 1, 's', 'E2E A'), ('agent-b', 2, 's', 'E2E B');`);
    generationRef = (await pool.query(`SELECT generation_ref FROM onec_sources WHERE source_id = 1`)).rows[0].generation_ref;
    sessionA = (await pool.query(`INSERT INTO onec_agent_sessions (agent_id, agent_version, accepted) VALUES ('agent-a', '1.0.0', true) RETURNING session_id`)).rows[0].session_id;
    for (const file of readdirSync(spoolDir)) unlinkSync(path.join(spoolDir, file));
  });

  const status = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return 'ok';
    } catch (error) {
      if (error instanceof ApiError) return `${error.statusCode} ${error.code}`;
      throw error;
    }
  };
  const row = (key: string, data: Record<string, unknown> | string, updatedAt: string | null = null, deleted = false) =>
    typeof data === 'string'
      ? `{"sourceId":"${key}","sourceUpdatedAt":${updatedAt ? `"${updatedAt}"` : 'null'},"deleted":${deleted},"data":${data}}`
      : JSON.stringify({ sourceId: key, sourceUpdatedAt: updatedAt, deleted, data });
  const gz = (lines: string[]) => gzipSync(Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8'));
  const sha = (body: Buffer) => createHash('sha256').update(body).digest('base64');
  interface Upload { runId: string; batchId?: string; entity?: string; lines?: string[]; body?: Buffer; rows?: number; headers?: Record<string, string | null>; agent?: OnecAgentContext; stream?: Readable }
  const upload = (u: Upload) => {
    const body = u.body ?? gz(u.lines ?? []);
    const batchId = u.batchId ?? randomUUID();
    const headers = {
      'idempotency-key': batchId, 'x-batch-id': batchId, 'x-run-id': u.runId, 'x-entity': u.entity ?? 'items',
      'x-schema-version': '1', 'x-row-count': String(u.rows ?? (u.lines ?? []).length), 'x-content-sha256': sha(body),
      'content-encoding': 'gzip', 'content-length': String(body.length), 'x-source-namespace': NAMESPACE,
      'x-source-generation': generationRef, ...u.headers,
    };
    const sent = Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
    return ingest.upload(u.agent ?? agentA, sent, u.stream ?? Readable.from([body]));
  };
  const entityV2 = (entity: string, extra: Record<string, unknown> = {}) => ({
    entity, status: 'done', readScope: 'full', rowsRead: 0, batchesCreated: 1, errorCode: null, errorMessage: null, ...extra,
  });
  const complete = (runId: string, body: Record<string, unknown>, agent = agentA) => {
    const raw = Buffer.from(JSON.stringify(body));
    return completion.complete(agent, runId, runId, JSON.parse(raw.toString()), raw, 0);
  };
  const v2 = (runId: string, entities: unknown[], extra: Record<string, unknown> = {}) => ({
    runId, status: 'succeeded', mode: 'bootstrap_full', sourceIdentity: { databaseId: DB_ID, exportEpoch: EPOCH, environment: 'test' },
    sourceGeneration: generationRef, rowsRead: 0, batchesCreated: entities.length, batchesAcknowledged: entities.length,
    completedAtUtc: new Date().toISOString(), entitiesFailed: 0, entities, ...extra,
  });
  const mirror = async (entity = 'items') =>
    (await pool.query(`SELECT source_key, deleted, data::text AS data, missing_in_source_at IS NOT NULL AS missing FROM onec_etl_mirror_rows WHERE entity_code = $1 ORDER BY source_key`, [entity])).rows;

  it('stores a batch durably and answers repeats with the original ACK; conflicts and foreign lookups are refused', async () => {
    const runId = randomUUID();
    const batchId = randomUUID();
    const lines = [row('k1', { Description: 'Тест-1' }), row('k2', { Description: 'Тест-2' })];
    const ack = await upload({ runId, batchId, lines });
    expect(ack).toMatchObject({ batchId, status: 'acknowledged', rowsAccepted: 2, checksumValid: true });
    expect(readdirSync(spoolDir).filter((f) => f.endsWith('.ndjson.gz'))).toHaveLength(1);
    expect(await upload({ runId, batchId, lines })).toEqual(ack);
    expect(readdirSync(spoolDir)).toHaveLength(1);
    expect(await status(() => upload({ runId, batchId, lines: [row('k9', {})] }))).toBe('409 BATCH_CONFLICT');
    expect(await ingest.lookup(agentA, batchId)).toEqual(ack);
    expect(await status(() => ingest.lookup(agentB, batchId))).toBe('404 BATCH_NOT_FOUND');
    expect(await status(() => ingest.lookup(agentA, randomUUID()))).toBe('404 BATCH_NOT_FOUND');
  });

  it('refuses bad bodies without keeping anything: checksum, row count, gzip, limits', async () => {
    const runId = randomUUID();
    const body = gz([row('k1', {})]);
    expect(await status(() => upload({ runId, body, rows: 1, headers: { 'x-content-sha256': sha(Buffer.from('other')) } }))).toBe('422 BATCH_CHECKSUM_MISMATCH');
    expect(await status(() => upload({ runId, lines: [row('k1', {})], rows: 2 }))).toBe('422 BATCH_ROW_COUNT_MISMATCH');
    expect(await status(() => upload({ runId, body: Buffer.from('not gzip at all'), rows: 0 }))).toBe('422 BATCH_GZIP_INVALID');
    expect(await status(() => upload({ runId, lines: [row('k1', {})], headers: { 'x-batch-id': randomUUID() } }))).toBe('400 INVALID_REQUEST');
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_batches`)).rows[0].n).toBe(0);
    expect(readdirSync(spoolDir)).toEqual([]);
  });

  it('refuses a closed generation and a different 1C database', async () => {
    expect(await status(() => upload({ runId: randomUUID(), lines: [], headers: { 'x-source-generation': randomUUID() } }))).toBe('409 RUN_GENERATION_CLOSED');
    const other = `1c-identity:v1:${EPOCH}:${DB_ID}:test`;
    expect(await status(() => upload({ runId: randomUUID(), lines: [], headers: { 'x-source-namespace': other } }))).toBe('409 SOURCE_IDENTITY_MISMATCH');
    // A run created in one generation is closed after the generation moves on.
    const runId = randomUUID();
    await upload({ runId, lines: [] });
    await pool.query(`UPDATE onec_sources SET generation = generation + 1, generation_ref = gen_random_uuid() WHERE source_id = 1`);
    const token = (await pool.query(`SELECT generation_ref FROM onec_sources WHERE source_id = 1`)).rows[0].generation_ref;
    expect(await status(() => upload({ runId, lines: [], headers: { 'x-source-generation': token } }))).toBe('409 RUN_GENERATION_CLOSED');
  });

  it('parses, completes and mirrors exactly; repeat is 204 without reprocessing, a different body is 409', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', '{"Description":"Тест","Price":12345678901234567890.1234500}'), row('k2', { Description: 'x' }, null, true)] });
    await upload({ runId, entity: 'counterparties', lines: [row('c1', { ИдентификационныйНомер: '123456789012' })] });
    expect(await parser.drainQueue()).toBe(2);
    const body = v2(runId, [entityV2('counterparties'), entityV2('items')]);
    await complete(runId, body);
    const items = await mirror();
    expect(items.map((r) => [r.source_key, r.deleted, r.missing])).toEqual([['k1', false, false], ['k2', true, false]]);
    // The 1C numeric lexeme is kept exactly (no float round trip).
    expect(items[0].data).toContain('12345678901234567890.1234500');
    expect((await pool.query(`SELECT status, mode, mode_origin FROM onec_etl_runs`)).rows[0]).toEqual({ status: 'completed', mode: 'bootstrap_full', mode_origin: 'complete_body' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_staging_rows`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT DISTINCT status FROM onec_etl_batches`)).rows).toEqual([{ status: 'finalized' }]);
    await complete(runId, body);
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_outbox_events WHERE event_type = 'onec.etl.run_completed'`)).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'onec.etl.run_completed'`)).rows[0].n).toBe(1);
    const links = await pool.query(`SELECT l.run_id FROM onec_audit_links l JOIN audit_log a ON a.audit_id = l.audit_id WHERE a.event = 'onec.etl.run_completed'`);
    expect(links.rows).toEqual([{ run_id: runId }]);
    expect(await status(() => complete(runId, { ...body, rowsRead: 99 }))).toBe('409 RUN_COMPLETION_CONFLICT');
    const state = (await pool.query(`SELECT entity_code, last_status, row_count, deleted_count FROM onec_etl_entity_state ORDER BY entity_code`)).rows;
    expect(state).toEqual([
      { entity_code: 'counterparties', last_status: 'done', row_count: 1, deleted_count: 0 },
      { entity_code: 'items', last_status: 'done', row_count: 2, deleted_count: 1 },
    ]);
  });

  it('marks rows absent from a full read as missing (never deletes); a returning row clears it; a delta read marks nothing', async () => {
    const run1 = randomUUID();
    await upload({ runId: run1, lines: [row('k1', {}), row('k2', {}), row('k3', {})] });
    await parser.drainQueue();
    await complete(run1, v2(run1, [entityV2('items')]));
    const run2 = randomUUID();
    await upload({ runId: run2, lines: [row('k1', {})] });
    await parser.drainQueue();
    await complete(run2, v2(run2, [entityV2('items', { readScope: 'delta' })], { mode: 'incremental' }));
    expect((await mirror()).map((r) => r.missing)).toEqual([false, false, false]);
    const run3 = randomUUID();
    await upload({ runId: run3, lines: [row('k1', {})] });
    await parser.drainQueue();
    await complete(run3, v2(run3, [entityV2('items')], { mode: 'incremental' }));
    expect((await mirror()).map((r) => [r.source_key, r.missing])).toEqual([['k1', false], ['k2', true], ['k3', true]]);
    expect((await pool.query(`SELECT missing_count FROM onec_etl_entity_state`)).rows[0].missing_count).toBe(2);
    const run4 = randomUUID();
    await upload({ runId: run4, lines: [row('k1', {}), row('k2', {})] });
    await parser.drainQueue();
    await complete(run4, v2(run4, [entityV2('items')]));
    expect((await mirror()).map((r) => [r.source_key, r.missing])).toEqual([['k1', false], ['k2', false], ['k3', true]]);
  });

  it('keeps the newer 1C version: an older sourceUpdatedAt never overwrites, NULL loses to a value', async () => {
    const run1 = randomUUID();
    await upload({ runId: run1, lines: [row('k1', { v: 'new' }, '2026-09-28T10:00:00Z'), row('k2', { v: 'dated' }, '2026-09-28T10:00:00')] });
    await parser.drainQueue();
    await complete(run1, v2(run1, [entityV2('items', { readScope: 'delta' })], { mode: 'incremental' }));
    const run2 = randomUUID();
    await upload({ runId: run2, lines: [row('k1', { v: 'old' }, '2026-09-28T09:00:00Z'), row('k2', { v: 'undated' }, null)] });
    await parser.drainQueue();
    await complete(run2, v2(run2, [entityV2('items', { readScope: 'delta' })], { mode: 'incremental' }));
    expect((await mirror()).map((r) => JSON.parse(r.data).v)).toEqual(['new', 'dated']);
  });

  it('failed entity: its staging is dropped, others publish; an alert opens and closes with the next done run', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', {})] });
    await upload({ runId, entity: 'counterparties', lines: [row('c1', {})] });
    await parser.drainQueue();
    await complete(runId, v2(runId, [entityV2('counterparties', { status: 'failed', errorCode: 'ODATA_HTTP_500', errorMessage: 'E2E' }), entityV2('items')], { status: 'partial_success', entitiesFailed: 1 }));
    expect(await mirror('counterparties')).toEqual([]);
    expect(await mirror('items')).toHaveLength(1);
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT kind, state FROM onec_alerts`)).rows).toEqual([{ kind: 'etl_entity_failed', state: 'open' }]);
    const run2 = randomUUID();
    await upload({ runId: run2, entity: 'counterparties', lines: [row('c1', {})] });
    await parser.drainQueue();
    await complete(run2, v2(run2, [entityV2('counterparties')]));
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT state FROM onec_alerts`)).rows).toEqual([{ state: 'resolved' }]);
  });

  it('an unparsable batch makes complete 422 BATCH_PAYLOAD_INVALID with the batch id and opens an incident (no row data)', async () => {
    const runId = randomUUID();
    const batchId = randomUUID();
    await upload({ runId, batchId, lines: [row('k1', {}), '{"sourceId":"k2","deleted":"no","data":{"secret":"E2E"}}'] });
    await parser.drainQueue();
    const refused = await complete(runId, v2(runId, [entityV2('items')])).catch((e: ApiError) => e);
    expect(refused).toMatchObject({ statusCode: 422, code: 'BATCH_PAYLOAD_INVALID', details: { batchId, reason: 'ROW_DELETED' } });
    const incident = (await pool.query(`SELECT kind, details::text AS details, batch_id FROM onec_agent_incidents`)).rows[0];
    expect(incident.kind).toBe('etl_batch_invalid');
    expect(incident.batch_id).toBe(batchId);
    expect(incident.details).not.toContain('secret');
  });

  it('complete checks: batch count mismatch 409, not parsed yet 503, lost staging reparsed, unknown run 409', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', {})] });
    expect(await status(() => complete(runId, v2(runId, [entityV2('items')])))).toBe('503 RUN_NOT_READY');
    await parser.drainQueue();
    expect(await status(() => complete(runId, v2(runId, [entityV2('items')], { batchesAcknowledged: 2 })))).toBe('409 RUN_BATCHES_MISMATCH');
    // PostgreSQL restart empties UNLOGGED staging: complete sends the batch back to parsing.
    await pool.query(`DELETE FROM onec_etl_staging_rows`);
    expect(await status(() => complete(runId, v2(runId, [entityV2('items')])))).toBe('503 RUN_NOT_READY');
    await parser.drainQueue();
    await complete(runId, v2(runId, [entityV2('items')]));
    expect(await mirror()).toHaveLength(1);
    expect(await status(() => complete(randomUUID(), v2(randomUUID(), [])))).toBe('400 INVALID_REQUEST');
    const unknown = randomUUID();
    expect(await status(() => complete(unknown, v2(unknown, [])))).toBe('409 RUN_UNKNOWN');
    expect(await status(() => complete(runId, v2(runId, [entityV2('items')]), agentB))).toBe('409 RUN_UNKNOWN');
  });

  it('v1 body: mode comes from the ETL command result; while the result is in flight complete answers 503 RUN_MODE_PENDING', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', {})] });
    await parser.drainQueue();
    const sent = await commands.enqueue(db, { agentId: 'agent-a', commandType: 'reload_entity', payload: { entity: 'items' }, sourceModule: 'e2e', idempotencyKey: `e2e-${randomUUID()}` });
    const lease = await commands.lease(agentA, { sessionId: sessionA, supportedCommandTypes: ['reload_entity'], maxWaitSeconds: 1 }, new AbortController().signal);
    expect(lease.hasCommand).toBe(true);
    const v1 = { runId, status: 'succeeded', rowsRead: 1, batchesCreated: 1, batchesAcknowledged: 1, completedAtUtc: new Date().toISOString() };
    expect(await status(() => complete(runId, v1))).toBe('503 RUN_MODE_PENDING');
    const result = JSON.stringify({ commandId: sent.command.commandId, status: 'succeeded', resultVersion: 1, data: { accepted: true, runId, mode: 'entity_reload' } });
    await commands.result(agentA, sent.command.commandId, Buffer.from(result));
    await complete(runId, v1);
    expect((await pool.query(`SELECT mode, mode_origin, command_id FROM onec_etl_runs`)).rows[0]).toEqual({ mode: 'entity_reload', mode_origin: 'command_result', command_id: sent.command.commandId });
    expect((await pool.query(`SELECT last_full_run_id FROM onec_etl_entity_state`)).rows[0].last_full_run_id).toBe(runId);
  });

  it('a repeat of an unfinished attempt takes over the reservation; the old attempt can no longer publish', async () => {
    const runId = randomUUID();
    const batchId = randomUUID();
    const lines = [row('k1', {})];
    const body = gz(lines);
    const stalled = new PassThrough();
    const first = upload({ runId, batchId, body, rows: 1, stream: stalled });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const owner1 = (await pool.query(`SELECT receiving_owner FROM onec_etl_batches`)).rows[0].receiving_owner;
    // Per-agent upload limit: a parallel upload of the same agent is 503 retryable, nothing stored.
    const parallel = randomUUID();
    expect(await status(() => upload({ runId, batchId: parallel, lines }))).toBe('503 BATCH_NOT_STORED_RETRYABLE');
    expect(await status(() => ingest.lookup(agentA, parallel))).toBe('404 BATCH_NOT_FOUND');
    // The agent repeats the same batch after an unknown outcome: the new attempt owns it.
    await pool.query(`UPDATE onec_etl_batches SET receiving_owner = gen_random_uuid() WHERE batch_id = $1`, [batchId]);
    stalled.end(body);
    expect(await status(() => first)).toBe('409 BATCH_SUPERSEDED');
    expect(owner1).toBeTruthy();
    expect(readdirSync(spoolDir)).toEqual([]);
  });

  it('monitor: abandons runs without complete (alert), recovers a stopped parser, flags a lost spool file', async () => {
    const stale = randomUUID();
    await upload({ runId: stale, lines: [row('k1', {})] });
    await pool.query(`UPDATE onec_etl_runs SET first_batch_at = now() - interval '25 hours'`);
    const stuck = randomUUID();
    await upload({ runId: stuck, lines: [row('k1', {})] });
    await pool.query(`UPDATE onec_etl_batches b SET status = 'parsing', parse_attempt = 1, parse_heartbeat_at = now() - interval '11 minutes' FROM onec_etl_runs r WHERE r.run_id = b.run_id AND r.run_id = $1`, [stuck]);
    const lost = randomUUID();
    await upload({ runId: lost, lines: [row('k1', {})] });
    const lostPath = (await pool.query(`SELECT b.spool_path FROM onec_etl_batches b WHERE b.run_id = $1`, [lost])).rows[0].spool_path;
    unlinkSync(lostPath);
    await monitor.recoverEtl(new Date());
    const statuses = Object.fromEntries((await pool.query(`SELECT run_id, status FROM onec_etl_batches`)).rows.map((r) => [r.run_id, r.status]));
    expect(statuses).toEqual({ [stale]: 'discarded', [stuck]: 'stored', [lost]: 'invalid' });
    expect((await pool.query(`SELECT status FROM onec_etl_runs WHERE run_id = $1`, [stale])).rows[0].status).toBe('abandoned');
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT kind FROM onec_alerts`)).rows).toEqual([{ kind: 'etl_run_abandoned' }]);
    expect(await status(() => complete(stale, v2(stale, [entityV2('items')])))).toBe('409 RUN_GENERATION_CLOSED');
  });
  it('a lost COMMIT acknowledgement never deletes the stored file: the batch stays usable', async () => {
    const runId = randomUUID();
    const batchId = randomUUID();
    const original = etlRepo.transaction.bind(etlRepo);
    let calls = 0;
    etlRepo.transaction = (async (handler: never) => {
      const result = await original(handler);
      calls += 1;
      if (calls === 2) throw new Error('E2E: connection lost after COMMIT');
      return result;
    }) as typeof etlRepo.transaction;
    try {
      // Our COMMIT went through: the attempt answers with the stored ACK instead of the transport error.
      expect(await upload({ runId, batchId, lines: [row('k1', {})] })).toMatchObject({ batchId, status: 'acknowledged' });
    } finally {
      etlRepo.transaction = original;
    }
    const stored = (await pool.query(`SELECT status, spool_path FROM onec_etl_batches WHERE batch_id = $1`, [batchId])).rows[0];
    expect(stored.status).toBe('stored');
    expect(readdirSync(spoolDir).map((f) => path.join(spoolDir, f))).toEqual([stored.spool_path]);
    expect((await ingest.lookup(agentA, batchId)).batchId).toBe(batchId);
    expect(await parser.drainQueue()).toBe(1);
    await complete(runId, v2(runId, [entityV2('items')]));
    expect(await mirror()).toHaveLength(1);
  });

  it('refuses a complete body that does not account for every entity (nothing is published or finalized)', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', {})] });
    await upload({ runId, entity: 'counterparties', lines: [row('c1', {})] });
    await parser.drainQueue();
    const two = { batchesAcknowledged: 2 };
    expect(await status(() => complete(runId, v2(runId, [entityV2('items')], two)))).toBe('409 RUN_ENTITIES_MISMATCH');
    expect(await status(() => complete(runId, v2(runId, [], two)))).toBe('409 RUN_ENTITIES_MISMATCH');
    expect(await status(() => complete(runId, v2(runId, [entityV2('items'), entityV2('items'), entityV2('counterparties')], two)))).toBe('409 RUN_ENTITIES_MISMATCH');
    expect(await status(() => complete(runId, v2(runId, [entityV2('counterparties', { status: 'failed' }), entityV2('items')], two)))).toBe('409 RUN_ENTITIES_MISMATCH');
    expect(await mirror()).toEqual([]);
    expect((await pool.query(`SELECT DISTINCT status FROM onec_etl_batches`)).rows).toEqual([{ status: 'parsed' }]);
    await complete(runId, v2(runId, [entityV2('counterparties'), entityV2('items')], two));
    expect(await mirror()).toHaveLength(1);
  });

  it('a stale parse attempt cannot invalidate the batch or delete the staging of the current attempt', async () => {
    const runId = randomUUID();
    const batchId = randomUUID();
    await upload({ runId, batchId, lines: [row('k1', {})] });
    const first = (await etlRepo.transaction((tx) => etlRepo.claimForParse(tx)))!;
    await pool.query(`UPDATE onec_etl_batches SET status = 'stored' WHERE batch_id = $1`, [batchId]); // recovery handed it back
    const second = (await etlRepo.transaction((tx) => etlRepo.claimForParse(tx)))!;
    expect([first.parseAttempt, second.parseAttempt]).toEqual([1, 2]);
    expect(await etlRepo.insertStagingChunk(second, 2, [{ lineNo: 1, line: row('k1', {}), sourceKey: 'k1', sourceUpdatedAt: null, deleted: false }])).toBe(true);
    expect(await etlRepo.insertStagingChunk(first, 1, [{ lineNo: 1, line: row('k1', {}), sourceKey: 'k1', sourceUpdatedAt: null, deleted: false }])).toBe(false);
    expect(await etlRepo.markInvalid(batchId, 1, 'ROW_DATA')).toBe(false);
    expect((await pool.query(`SELECT status FROM onec_etl_batches WHERE batch_id = $1`, [batchId])).rows[0].status).toBe('parsing');
    expect(await etlRepo.stagingCount(etlRepo.db, batchId)).toBe(1);
    expect(await etlRepo.finishParse(second, 2)).toBe('parsed');
  });

  it('keeps sub-millisecond 1C time order: an older version inside the same millisecond never wins', async () => {
    const run1 = randomUUID();
    await upload({ runId: run1, lines: [row('k1', { v: 'new' }, '2026-09-28T10:00:00.123900Z')] });
    await parser.drainQueue();
    await complete(run1, v2(run1, [entityV2('items', { readScope: 'delta' })], { mode: 'incremental' }));
    const run2 = randomUUID();
    await upload({ runId: run2, lines: [row('k1', { v: 'old' }, '2026-09-28T10:00:00.123100Z')] });
    await parser.drainQueue();
    await complete(run2, v2(run2, [entityV2('items', { readScope: 'delta' })], { mode: 'incremental' }));
    expect((await mirror()).map((r) => JSON.parse(r.data).v)).toEqual(['new']);
  });

  it('enforces intake limits with a clean refusal: no row, no file, the slot is free again', async () => {
    const runId = randomUUID();
    const big = [row('k1', { d: 'x'.repeat(200) }), row('k2', { d: 'y'.repeat(200) })];
    const cases: Array<[Partial<typeof ingest.limits>, Upload, string]> = [
      [{ maxCompressedBytes: 10 }, { runId, lines: big }, '413 BATCH_LIMIT_EXCEEDED'],
      [{ maxCompressedBytes: 10 }, { runId, lines: big, headers: { 'content-length': null } }, '413 BATCH_LIMIT_EXCEEDED'],
      [{ maxUncompressedBytes: 100 }, { runId, lines: big }, '413 BATCH_LIMIT_EXCEEDED'],
      [{ maxLineBytes: 100 }, { runId, lines: big }, '413 BATCH_LIMIT_EXCEEDED'],
      [{ maxRows: 1 }, { runId, lines: big }, '413 BATCH_LIMIT_EXCEEDED'],
    ];
    const defaults = { ...ingest.limits };
    try {
      for (const [limits, input, expected] of cases) {
        Object.assign(ingest.limits, defaults, limits);
        expect(await status(() => upload(input))).toBe(expected);
      }
    } finally {
      Object.assign(ingest.limits, defaults);
    }
    runtimeConfig.etlSpoolMinFreeBytes = Number.MAX_SAFE_INTEGER;
    try {
      expect(await status(() => upload({ runId, lines: big }))).toBe('503 BATCH_NOT_STORED_RETRYABLE');
    } finally {
      runtimeConfig.etlSpoolMinFreeBytes = 0;
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_batches`)).rows[0].n).toBe(0);
    expect(readdirSync(spoolDir)).toEqual([]);
    expect((await upload({ runId, lines: big })).rowsAccepted).toBe(2);
  });

  it('a late full-mode result for a run completed as incremental opens a "full export needed" alert, once', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', {})] });
    await parser.drainQueue();
    await complete(runId, { runId, status: 'succeeded', rowsRead: 1, batchesCreated: 1, batchesAcknowledged: 1, completedAtUtc: new Date().toISOString() });
    expect((await pool.query(`SELECT mode, mode_origin FROM onec_etl_runs`)).rows[0]).toEqual({ mode: 'incremental', mode_origin: 'no_pending_etl_command' });
    const sent = await commands.enqueue(db, { agentId: 'agent-a', commandType: 'start_full_sync', payload: { entities: [] }, sourceModule: 'e2e', idempotencyKey: `e2e-${randomUUID()}` });
    await commands.lease(agentA, { sessionId: sessionA, supportedCommandTypes: ['start_full_sync'], maxWaitSeconds: 1 }, new AbortController().signal);
    const result = JSON.stringify({ commandId: sent.command.commandId, status: 'succeeded', resultVersion: 1, data: { accepted: true, runId, mode: 'bootstrap_full' } });
    await commands.result(agentA, sent.command.commandId, Buffer.from(result));
    await commands.result(agentA, sent.command.commandId, Buffer.from(result));
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT kind, state FROM onec_alerts`)).rows).toEqual([{ kind: 'etl_full_sync_required', state: 'open' }]);
    expect((await pool.query(`SELECT kind FROM onec_agent_incidents`)).rows.map((r) => r.kind)).toEqual(['late_mode_for_completed_run']);
    expect((await pool.query(`SELECT mode FROM onec_etl_runs`)).rows[0].mode).toBe('incremental');
  });

  it('run detail works for any run, not only recent ones; abandonment is audited by the system actor', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', {})] });
    await pool.query(`UPDATE onec_etl_runs SET created_at = now() - interval '30 days', first_batch_at = now() - interval '30 days' WHERE run_id = $1`, [runId]);
    for (let i = 0; i < 3; i += 1) await upload({ runId: randomUUID(), lines: [] });
    const detail = await admin.getRun(runId);
    expect(detail).toMatchObject({ runId, status: 'receiving', batchCount: 1, rowTotal: 1 });
    await monitor.recoverEtl(new Date());
    await monitor.recoverEtl(new Date());
    const audit = await pool.query(
      `SELECT a.event, a.username AS actor_username, l.actor_kind, l.run_id FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id WHERE a.event = 'onec.etl.run_abandoned'`,
    );
    expect(audit.rows).toEqual([{ event: 'onec.etl.run_abandoned', actor_username: 'onec-monitor', actor_kind: 'system', run_id: runId }]);
  });
  it('over a real HTTP socket a chunked upload over the limit gets a structured 413, not a reset; nothing is kept', async () => {
    const server = createServer((req, res) => {
      ingest.upload(agentA, req.headers, req).then(
        (ack) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ack)),
        (error: unknown) => {
          const e = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL', 'internal');
          res.writeHead(e.statusCode, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: e.code } }));
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const defaults = { ...ingest.limits };
    ingest.limits.maxCompressedBytes = 64 * 1024;
    try {
      const runId = randomUUID();
      const batchId = randomUUID();
      const payload = Buffer.alloc(1024 * 1024, 1);
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < payload.length; offset += 16 * 1024) controller.enqueue(payload.subarray(offset, offset + 16 * 1024));
          controller.close();
        },
      });
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        body: chunked,
        duplex: 'half',
        headers: {
          'idempotency-key': batchId, 'x-batch-id': batchId, 'x-run-id': runId, 'x-entity': 'items', 'x-schema-version': '1',
          'x-row-count': '1', 'x-content-sha256': sha(payload), 'content-encoding': 'gzip', 'content-type': 'application/x-ndjson',
          'x-source-namespace': NAMESPACE, 'x-source-generation': generationRef,
        },
      } as RequestInit);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: { code: 'BATCH_LIMIT_EXCEEDED' } });
      expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_batches`)).rows[0].n).toBe(0);
      expect(readdirSync(spoolDir)).toEqual([]);
    } finally {
      Object.assign(ingest.limits, defaults);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // The slot was released: a normal upload goes through.
    expect((await upload({ runId: randomUUID(), lines: [row('k1', {})] })).rowsAccepted).toBe(1);
  });
  it('a client that disconnects mid-body leaves no open file descriptor, no file and no reservation', async () => {
    const { request } = await import('node:http');
    const { readdir, readlink } = await import('node:fs/promises');
    const server = createServer((req, res) => {
      ingest.upload(agentA, req.headers, req).then(
        () => res.end('ok'),
        () => res.end('refused'),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const batchId = randomUUID();
    try {
      await new Promise<void>((resolve) => {
        const req = request({
          host: '127.0.0.1', port, method: 'POST', path: '/',
          headers: {
            'idempotency-key': batchId, 'x-batch-id': batchId, 'x-run-id': randomUUID(), 'x-entity': 'items', 'x-schema-version': '1',
            'x-row-count': '1', 'x-content-sha256': sha(Buffer.from('x')), 'content-encoding': 'gzip', 'content-length': String(1024 * 1024),
            'x-source-namespace': NAMESPACE, 'x-source-generation': generationRef,
          },
        });
        req.on('error', () => resolve());
        req.write(Buffer.alloc(64 * 1024, 1));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 300);
      });
      for (let i = 0; i < 50 && (await pool.query(`SELECT count(*)::int AS n FROM onec_etl_batches`)).rows[0].n > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const open = [];
      for (const fd of await readdir('/proc/self/fd')) {
        const target = await readlink(`/proc/self/fd/${fd}`).catch(() => '');
        if (target.startsWith(spoolDir)) open.push(target);
      }
      expect(open).toEqual([]);
      expect(readdirSync(spoolDir)).toEqual([]);
      expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_batches`)).rows[0].n).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect((await upload({ runId: randomUUID(), lines: [row('k1', {})] })).rowsAccepted).toBe(1);
  });
  // ---------------------------------------------------------------- E3b: snapshots (§21.2)
  const snapshotRun = async (lines: string[], extra: Record<string, unknown>, entity = 'stock_balances') => {
    const runId = randomUUID();
    await upload({ runId, entity, lines });
    await parser.drainQueue();
    await complete(runId, v2(runId, [entityV2(entity, { completeness: 'verified', completenessReason: null, rowsRead: lines.length, ...extra })], { mode: 'incremental' }));
    return runId;
  };
  const keys = async (entity = 'stock_balances') => (await mirror(entity)).map((r) => r.source_key);

  it('snapshot entity: a newer verified snapshot replaces the copy; unverified, stale or failed ones never touch it', async () => {
    await snapshotRun([row('a', { q: 1 }), row('b', { q: 2 })], { snapshotAtUtc: '2026-09-28T10:00:00.000Z' });
    expect(await keys()).toEqual(['a', 'b']);
    await snapshotRun([row('b', { q: 3 }), row('c', { q: 4 })], { snapshotAtUtc: '2026-09-28T11:00:00.000Z' });
    expect(await keys()).toEqual(['b', 'c']);
    expect((await mirror()).every((r) => r.missing === false)).toBe(true);
    await snapshotRun([row('z', {})], { snapshotAtUtc: '2026-09-28T12:00:00.000Z', completeness: 'unverified', completenessReason: 'COUNT_CHANGED' });
    await snapshotRun([row('z', {})], { snapshotAtUtc: '2026-09-28T10:30:00.000Z' });
    await snapshotRun([row('z', {})], { snapshotAtUtc: '2026-09-28T13:00:00.000Z', readScope: 'delta' });
    expect(await keys()).toEqual(['b', 'c']);
    const state = (await pool.query(`SELECT snapshot_version, snapshot_rejected_reason FROM onec_etl_entity_state WHERE entity_code = 'stock_balances'`)).rows[0];
    expect([new Date(state.snapshot_version).toISOString(), state.snapshot_rejected_reason]).toEqual(['2026-09-28T11:00:00.000Z', 'NOT_FULL']);
    expect((await pool.query(`SELECT kind FROM onec_agent_incidents`)).rows.map((r) => r.kind)).toEqual(['stale_snapshot_ignored']);
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT kind, state FROM onec_alerts`)).rows).toEqual([{ kind: 'etl_snapshot_not_updated', state: 'open' }]);
    // A verified empty snapshot (one empty batch) empties the copy and closes the alert.
    await snapshotRun([], { snapshotAtUtc: '2026-09-28T14:00:00.000Z', rowsRead: 0 });
    expect(await keys()).toEqual([]);
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT state FROM onec_alerts`)).rows).toEqual([{ state: 'resolved' }]);
  });

  it('snapshot rejection reasons: failed, no snapshot time; the copy stays whole', async () => {
    await snapshotRun([row('a', {})], { snapshotAtUtc: '2026-09-28T10:00:00.000Z' });
    await snapshotRun([row('x', {})], { snapshotAtUtc: '2026-09-28T11:00:00.000Z', status: 'failed', errorCode: 'ODATA_HTTP_500' }).catch(() => undefined);
    const noTime = randomUUID();
    await upload({ runId: noTime, entity: 'stock_balances', lines: [row('x', {})] });
    await parser.drainQueue();
    await complete(noTime, v2(noTime, [entityV2('stock_balances', { completeness: 'verified', completenessReason: null, rowsRead: 1 })], { mode: 'incremental' }));
    expect(await keys()).toEqual(['a']);
    expect((await pool.query(`SELECT snapshot_rejected_reason FROM onec_etl_entity_state WHERE entity_code = 'stock_balances'`)).rows[0].snapshot_rejected_reason).toBe('NO_SNAPSHOT_TIME');
  });

  // ---------------------------------------------------------------- E3b: revocation (§21.3, §21.6)
  it('revoking phones: write ban, copy/staging/spool purged in every run, later uploads 409 ENTITY_REVOKED, restore only when clean', async () => {
    const done = await snapshotRun([row('p1', { Представление: '+7 700 000 00 00' })], { snapshotAtUtc: '2026-09-28T10:00:00.000Z' }, 'counterparty_phones');
    const open = randomUUID();
    await upload({ runId: open, lines: [row('k1', {})] });
    await upload({ runId: open, entity: 'counterparty_phones', lines: [row('p2', {})] });
    await parser.drainQueue();
    expect(readdirSync(spoolDir).length).toBe(3);
    expect(await status(() => onecAdmin.restoreEntity('agent-a', 'counterparty_phones', actor, actx('x')))).toBe('409 ONEC_ENTITY_NOT_PURGED');
    const revoked = await onecAdmin.revokeEntity('agent-a', 'counterparty_phones', actor, actx('revoke'));
    expect(revoked).toMatchObject({ revoked: true, clean: true });
    expect(await status(() => onecAdmin.revokeEntity('agent-a', 'counterparty_phones', actor, actx('again')))).toBe('409 ONEC_ENTITY_ALREADY_REVOKED');
    expect(await status(() => onecAdmin.revokeEntity('agent-a', 'items', actor, actx('x')))).toBe('400 ONEC_ENTITY_NOT_REVOCABLE');
    expect(await mirror('counterparty_phones')).toEqual([]);
    expect(readdirSync(spoolDir).length).toBe(1); // only the items batch of the open run is left
    const phoneBatches = (await pool.query(`SELECT run_id, status, revoked, spool_path, ack IS NOT NULL AS acked FROM onec_etl_batches WHERE entity_code = 'counterparty_phones' ORDER BY run_id = $1`, [done])).rows;
    expect(phoneBatches.map((b) => [b.status, b.revoked, b.spool_path, b.acked])).toEqual([['discarded', true, null, true], ['finalized', false, null, true]]);
    expect((await pool.query(`SELECT revoked_entities FROM onec_etl_runs WHERE run_id = $1`, [open])).rows[0].revoked_entities).toEqual(['counterparty_phones']);
    expect(await status(() => upload({ runId: open, entity: 'counterparty_phones', lines: [row('p3', {})] }))).toBe('409 ENTITY_REVOKED');
    // The open run still completes: items published, phones (counted as acknowledged) ignored.
    await complete(open, v2(open, [entityV2('counterparty_phones'), entityV2('items')], { batchesAcknowledged: 2 }));
    expect(await keys('items')).toEqual(['k1']);
    expect(await mirror('counterparty_phones')).toEqual([]);
    const audit = await pool.query(`SELECT event, after_json::text AS after FROM audit_log WHERE event = 'onec.etl.entity_revoked'`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after).not.toContain('+7');
    await onecAdmin.restoreEntity('agent-a', 'counterparty_phones', actor, actx('restore'));
    expect((await pool.query(`SELECT event_type FROM onec_outbox_events WHERE event_type LIKE 'onec.etl.entity_%' ORDER BY event_id`)).rows.map((r) => r.event_type))
      .toEqual(['onec.etl.entity_revoked', 'onec.etl.entity_restored']);
    expect((await pool.query(`SELECT revoked_at FROM onec_etl_entity_state WHERE entity_code = 'counterparty_phones'`)).rows[0].revoked_at).toBeNull();
    // The run that saw the revocation keeps it; a new run may carry phones again.
    expect(await status(() => upload({ runId: open, entity: 'counterparty_phones', lines: [row('p4', {})] }))).toBe('409 RUN_CLOSED');
    await snapshotRun([row('p5', {})], { snapshotAtUtc: '2026-09-28T12:00:00.000Z' }, 'counterparty_phones');
    expect(await keys('counterparty_phones')).toEqual(['p5']);
  });

  it('a revocation during parsing stops the parser: nothing of the entity reaches staging', async () => {
    const runId = randomUUID();
    const batchId = randomUUID();
    await upload({ runId, batchId, entity: 'counterparty_phones', lines: [row('p1', {})] });
    const claimed = (await etlRepo.transaction((tx) => etlRepo.claimForParse(tx)))!;
    await onecAdmin.revokeEntity('agent-a', 'counterparty_phones', actor, actx('revoke'));
    expect(await etlRepo.insertStagingChunk(claimed, claimed.parseAttempt, [{ lineNo: 1, line: row('p1', {}), sourceKey: 'p1', sourceUpdatedAt: null, deleted: false }])).toBe(false);
    expect(await etlRepo.finishParse(claimed, claimed.parseAttempt)).toBe('stale');
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_staging_rows`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT status, revoked FROM onec_etl_batches WHERE batch_id = $1`, [batchId])).rows[0]).toEqual({ status: 'discarded', revoked: true });
  });

  it('personal data not confirmed by a snapshot for 30 days is removed', async () => {
    await snapshotRun([row('p1', {})], { snapshotAtUtc: '2026-09-28T10:00:00.000Z' }, 'counterparty_phones');
    expect(await revocation.cleanupAll()).toMatchObject({ personalRowsExpired: 0 });
    await pool.query(`UPDATE onec_etl_entity_state SET snapshot_version = now() - interval '31 days' WHERE entity_code = 'counterparty_phones'`);
    expect(await revocation.cleanupAll()).toMatchObject({ personalRowsExpired: 1 });
    expect(await mirror('counterparty_phones')).toEqual([]);
  });

  // ---------------------------------------------------------------- E3b: rebaseline (§3.2)
  it('rebaseline: new generation, open runs abandoned, copy cleared, old runs refused; identity change needs confirmation', async () => {
    const done = randomUUID();
    await upload({ runId: done, lines: [row('k1', {})] });
    await parser.drainQueue();
    await complete(done, v2(done, [entityV2('items')]));
    const open = randomUUID();
    await upload({ runId: open, lines: [row('k2', {})] });
    const oldRef = generationRef;
    const result = await onecAdmin.rebaseline(1, { expectedGeneration: 1 }, actor, actx('rb'));
    // A repeat after a lost response finds the generation moved: refused, the new baseline is safe.
    expect(await status(() => onecAdmin.rebaseline(1, { expectedGeneration: 1 }, actor, actx('rb-repeat')))).toBe('409 ONEC_GENERATION_CHANGED');
    expect(result).toMatchObject({ sourceId: 1, generation: 2, abandonedRuns: 1, publishPending: true });
    expect(await mirror()).toEqual([]);
    expect((await pool.query(`SELECT status FROM onec_etl_runs WHERE run_id = $1`, [open])).rows[0].status).toBe('abandoned');
    expect(await status(() => upload({ runId: open, lines: [row('k3', {})], headers: { 'x-source-generation': null } }))).toBe('409 RUN_GENERATION_CLOSED');
    expect(await status(() => upload({ runId: randomUUID(), lines: [], headers: { 'x-source-generation': oldRef } }))).toBe('409 RUN_GENERATION_CLOSED');
    generationRef = (await pool.query(`SELECT generation_ref FROM onec_sources WHERE source_id = 1`)).rows[0].generation_ref;
    expect(generationRef).not.toBe(oldRef);
    const fresh = randomUUID();
    await upload({ runId: fresh, lines: [row('k9', {})] });
    await parser.drainQueue();
    await complete(fresh, v2(fresh, [entityV2('items')]));
    expect(await keys('items')).toEqual(['k9']);
    // identity_changed: refused without confirmation, then bound to the identity the agent reported.
    const other = { databaseId: EPOCH, exportEpoch: DB_ID, environment: 'test' };
    await pool.query(`UPDATE onec_sources SET identity_status = 'identity_changed', observed_identity = $1::jsonb WHERE source_id = 1`, [JSON.stringify(other)]);
    expect(await status(() => onecAdmin.rebaseline(1, { expectedGeneration: 2 }, actor, actx('rb2')))).toBe('409 ONEC_IDENTITY_CONFIRMATION_REQUIRED');
    // Only the identity shown to the operator (reported last by the agent) can be confirmed.
    expect(await status(() => onecAdmin.rebaseline(1, { expectedGeneration: 2, acceptIdentity: { databaseId: DB_ID, exportEpoch: EPOCH, environment: 'test' } }, actor, actx('rb2b')))).toBe('409 ONEC_IDENTITY_CONFIRMATION_REQUIRED');
    expect(await onecAdmin.rebaseline(1, { expectedGeneration: 2, acceptIdentity: other }, actor, actx('rb3'))).toMatchObject({ identityAccepted: true, generation: 3 });
    expect((await pool.query(`SELECT identity, identity_status FROM onec_sources WHERE source_id = 1`)).rows[0]).toEqual({ identity: other, identity_status: 'bound' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'onec.source.generation_bumped'`)).rows[0].n).toBe(2);
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_outbox_events WHERE event_type = 'onec.source.generation_bumped'`)).rows[0].n).toBe(2);
  });

  // ---------------------------------------------------------------- E3b: «Данные 1С»
  it('mirror browse: paging, search, state filters, row detail', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', { Code: '001', Description: 'Плита МДФ' }), row('k2', { Code: '002', Description: 'Кромка' }, null, true)] });
    await parser.drainQueue();
    await complete(runId, v2(runId, [entityV2('items')]));
    const all = await admin.listMirror({ agentId: 'agent-a', entity: 'items' });
    expect(all).toMatchObject({ total: 2 });
    expect(all.rows.map((r) => r.description)).toEqual(['Кромка', 'Плита МДФ']);
    expect((await admin.listMirror({ agentId: 'agent-a', entity: 'items', search: 'мдф' })).rows.map((r) => r.sourceKey)).toEqual(['k1']);
    expect((await admin.listMirror({ agentId: 'agent-a', entity: 'items', state: 'deleted' })).rows.map((r) => r.sourceKey)).toEqual(['k2']);
    expect((await admin.listMirror({ agentId: 'agent-a', entity: 'items', search: '%' })).total).toBe(0);
    expect(await admin.getMirrorRow({ agentId: 'agent-a', entity: 'items', key: 'k1' })).toMatchObject({ data: { Code: '001' } });
    expect(await status(() => admin.getMirrorRow({ agentId: 'agent-b', entity: 'items', key: 'k1' }))).toBe('404 ONEC_MIRROR_ROW_NOT_FOUND');
  });
  it('a spool file that cannot be deleted keeps the revoked entity "not clean" until it is gone', async () => {
    await snapshotRun([row('p1', {})], { snapshotAtUtc: '2026-09-28T10:00:00.000Z' }, 'counterparty_phones');
    const { chmodSync } = await import('node:fs');
    chmodSync(spoolDir, 0o500);
    let revoked;
    try {
      revoked = await onecAdmin.revokeEntity('agent-a', 'counterparty_phones', actor, actx('revoke'));
      expect(revoked.clean).toBe(false);
      expect(await status(() => onecAdmin.restoreEntity('agent-a', 'counterparty_phones', actor, actx('r')))).toBe('409 ONEC_ENTITY_NOT_PURGED');
      expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_batches WHERE spool_path IS NOT NULL AND entity_code = 'counterparty_phones'`)).rows[0].n).toBe(1);
    } finally {
      chmodSync(spoolDir, 0o700);
    }
    await revocation.cleanupAll();
    expect(readdirSync(spoolDir)).toEqual([]);
    await onecAdmin.restoreEntity('agent-a', 'counterparty_phones', actor, actx('restore'));
  });

  it('a crash between the ban and the cleanup still ends in "purged" (restore possible)', async () => {
    await etlRepo.transaction((tx) => etlRepo.markRevoked(tx, 1, 'counterparty_phones', 1));
    await revocation.cleanupAll();
    expect((await pool.query(`SELECT purged_at IS NOT NULL AS purged FROM onec_etl_entity_state WHERE entity_code = 'counterparty_phones'`)).rows[0].purged).toBe(true);
    await onecAdmin.restoreEntity('agent-a', 'counterparty_phones', actor, actx('restore'));
  });

  it('TTL re-checks under the lock: a snapshot published meanwhile is not removed', async () => {
    await snapshotRun([row('p1', {})], { snapshotAtUtc: '2026-09-28T10:00:00.000Z' }, 'counterparty_phones');
    await pool.query(`UPDATE onec_etl_entity_state SET snapshot_version = now() - interval '31 days' WHERE entity_code = 'counterparty_phones'`);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM onec_etl_entity_state WHERE entity_code = 'counterparty_phones' FOR UPDATE`);
      const expiring = etlRepo.expirePersonalData(['counterparty_phones'], 30 * 24 * 60 * 60_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query(`UPDATE onec_etl_entity_state SET snapshot_version = now() WHERE entity_code = 'counterparty_phones'`);
      await holder.query('COMMIT');
      expect(await expiring).toBe(0);
    } finally {
      holder.release();
    }
    expect(await keys('counterparty_phones')).toEqual(['p1']);
  });

  it('a snapshot whose rowsRead disagrees with the received rows never replaces the copy', async () => {
    await snapshotRun([row('a', {})], { snapshotAtUtc: '2026-09-28T10:00:00.000Z' });
    await snapshotRun([], { snapshotAtUtc: '2026-09-28T11:00:00.000Z', rowsRead: 5 });
    expect(await keys()).toEqual(['a']);
    expect((await pool.query(`SELECT snapshot_rejected_reason FROM onec_etl_entity_state WHERE entity_code = 'stock_balances'`)).rows[0].snapshot_rejected_reason).toBe('ROWS_MISMATCH');
  });

  it('concurrent completions of one source and a rebaseline during a completion never deadlock', async () => {
    const runs = [randomUUID(), randomUUID()];
    for (const runId of runs) {
      await upload({ runId, lines: [row(`k-${runId}`, {})] });
      await upload({ runId, entity: 'counterparties', lines: [row(`c-${runId}`, {})] });
    }
    await parser.drainQueue();
    const both = await Promise.allSettled(runs.map((runId) => complete(runId, v2(runId, [entityV2('counterparties'), entityV2('items')], { batchesAcknowledged: 2 }))));
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const third = randomUUID();
    await upload({ runId: third, lines: [row('k3', {})] });
    await parser.drainQueue();
    const raced = await Promise.allSettled([
      complete(third, v2(third, [entityV2('items')])),
      onecAdmin.rebaseline(1, { expectedGeneration: 1 }, actor, actx('rb-race')),
    ]);
    for (const outcome of raced) {
      if (outcome.status === 'rejected') expect(String((outcome.reason as { code?: string }).code)).toBe('RUN_GENERATION_CLOSED');
    }
    expect(raced[1].status).toBe('fulfilled');
  });
  it('revocation removes a file written before a crash (reservation not yet stored) before calling the entity clean', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', {})] });
    const batchId = randomUUID();
    const owner = randomUUID();
    await pool.query(
      `INSERT INTO onec_etl_batches (batch_id, run_id, agent_id, entity_code, schema_version, row_count, content_sha256, status, receiving_owner, receiving_heartbeat_at)
       VALUES ($1, $2, 'agent-a', 'counterparty_phones', 1, 1, $3, 'receiving', $4, now())`,
      [batchId, runId, sha(Buffer.from('x')), owner],
    );
    const { writeFileSync } = await import('node:fs');
    const orphan = path.join(spoolDir, `1.counterparty_phones.${batchId}.${owner}.ndjson.gz`);
    writeFileSync(orphan, gz([row('p1', { Представление: '+7' })]));
    const revoked = await onecAdmin.revokeEntity('agent-a', 'counterparty_phones', actor, actx('revoke'));
    expect(revoked.clean).toBe(true);
    expect(readdirSync(spoolDir).some((f) => f.startsWith(batchId))).toBe(false);
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_batches WHERE batch_id = $1`, [batchId])).rows[0].n).toBe(0);
  });

  it('retention keeps the path of a file it could not delete and retries', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', {})] });
    await parser.drainQueue();
    await complete(runId, v2(runId, [entityV2('items')]));
    await pool.query(`UPDATE onec_etl_batches SET updated_at = now() - interval '8 days'`);
    const { chmodSync } = await import('node:fs');
    chmodSync(spoolDir, 0o500);
    try {
      expect(await monitor.etlRetention()).toMatchObject({ spoolFilesRemoved: 0 });
      expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_batches WHERE spool_path IS NOT NULL`)).rows[0].n).toBe(1);
    } finally {
      chmodSync(spoolDir, 0o700);
    }
    expect(await monitor.etlRetention()).toMatchObject({ spoolFilesRemoved: 1 });
    expect(readdirSync(spoolDir)).toEqual([]);
  });

  it('a revocation waiting on an entity held by a completion does not deadlock when the completion inserts new mirror keys', async () => {
    await snapshotRun([row('p1', {})], { snapshotAtUtc: '2026-09-28T10:00:00.000Z' }, 'counterparty_phones');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM onec_etl_entity_state WHERE entity_code = 'counterparty_phones' FOR UPDATE`);
      const revoking = onecAdmin.revokeEntity('agent-a', 'counterparty_phones', actor, actx('revoke'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Like a completion publishing new keys: the FK takes KEY SHARE on the source row.
      await holder.query(
        `INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id)
         VALUES (1, 'counterparty_phones', 'p-new', false, '{}'::jsonb, 'h', gen_random_uuid(), gen_random_uuid())`,
      );
      await holder.query('COMMIT');
      expect(await revoking).toMatchObject({ revoked: true });
    } finally {
      holder.release();
    }
    expect(await mirror('counterparty_phones')).toEqual([]);
  }, 20000);
  it('a file whose record was lost (crash after rename, then rebaseline) is still removed by revocation', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', {})] });
    const batchId = randomUUID();
    const owner = randomUUID();
    await pool.query(
      `INSERT INTO onec_etl_batches (batch_id, run_id, agent_id, entity_code, schema_version, row_count, content_sha256, status, receiving_owner, receiving_heartbeat_at)
       VALUES ($1, $2, 'agent-a', 'counterparty_phones', 1, 1, $3, 'receiving', $4, now())`,
      [batchId, runId, sha(Buffer.from('x')), owner],
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(spoolDir, `1.counterparty_phones.${batchId}.${owner}.ndjson.gz`), gz([row('p1', {})]));
    await onecAdmin.rebaseline(1, { expectedGeneration: 1 }, actor, actx('rb')); // deletes the reservation row
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_batches WHERE batch_id = $1`, [batchId])).rows[0].n).toBe(0);
    const revoked = await onecAdmin.revokeEntity('agent-a', 'counterparty_phones', actor, actx('revoke'));
    expect(revoked.clean).toBe(true);
    expect(readdirSync(spoolDir).some((f) => f.startsWith('1.counterparty_phones.'))).toBe(false);
  });

  it('stale-reservation cleanup claims first: a late uploader can no longer publish, and a stored batch is never touched', async () => {
    const runId = randomUUID();
    const batchId = randomUUID();
    const body = gz([row('k1', {})]);
    const stalled = new PassThrough();
    const late = upload({ runId, batchId, body, rows: 1, stream: stalled });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await pool.query(`UPDATE onec_etl_batches SET receiving_heartbeat_at = now() - interval '11 minutes' WHERE batch_id = $1`, [batchId]);
    await monitor.recoverEtl(new Date());
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_etl_batches WHERE batch_id = $1`, [batchId])).rows[0].n).toBe(0);
    stalled.end(body);
    expect(await status(() => late)).toBe('409 BATCH_SUPERSEDED');
    expect(readdirSync(spoolDir)).toEqual([]);
    // Publication won the race: the claim finds nothing and the stored file stays.
    const stored = randomUUID();
    await upload({ runId, batchId: stored, lines: [row('k2', {})] });
    await pool.query(`UPDATE onec_etl_batches SET receiving_heartbeat_at = now() - interval '11 minutes' WHERE batch_id = $1`, [stored]);
    await monitor.recoverEtl(new Date());
    expect((await pool.query(`SELECT status FROM onec_etl_batches WHERE batch_id = $1`, [stored])).rows[0].status).toBe('stored');
    expect(readdirSync(spoolDir)).toHaveLength(1);
  });
  it('revocation also removes attempt files in the E3a naming format (written before the upgrade)', async () => {
    const runId = randomUUID();
    await upload({ runId, lines: [row('k1', {})] });
    const batchId = randomUUID();
    const owner = randomUUID();
    await pool.query(
      `INSERT INTO onec_etl_batches (batch_id, run_id, agent_id, entity_code, schema_version, row_count, content_sha256, status, receiving_owner, receiving_heartbeat_at)
       VALUES ($1, $2, 'agent-a', 'counterparty_phones', 1, 1, $3, 'receiving', $4, now())`,
      [batchId, runId, sha(Buffer.from('x')), owner],
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(spoolDir, `${batchId}.${owner}.ndjson.gz`), gz([row('p1', {})]));
    expect((await onecAdmin.revokeEntity('agent-a', 'counterparty_phones', actor, actx('revoke'))).clean).toBe(true);
    expect(readdirSync(spoolDir).some((f) => f.startsWith(batchId))).toBe(false);
  });

  it('a delayed revocation sweep never deletes files of uploads allowed by a restore that happened meanwhile', async () => {
    await onecAdmin.revokeEntity('agent-a', 'counterparty_phones', actor, actx('revoke'));
    const holder = await pool.connect();
    const { writeFileSync, existsSync } = await import('node:fs');
    const fresh = path.join(spoolDir, `1.counterparty_phones.${randomUUID()}.${randomUUID()}.ndjson.gz`);
    try {
      await holder.query('BEGIN');
      // Like restoreEntity: FOR UPDATE on the entity state, then the ban is lifted.
      await holder.query(`SELECT 1 FROM onec_etl_entity_state WHERE entity_code = 'counterparty_phones' FOR UPDATE`);
      const sweeping = revocation.cleanup(1, 'counterparty_phones');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query(`UPDATE onec_etl_entity_state SET revoked_at = NULL WHERE entity_code = 'counterparty_phones'`);
      writeFileSync(fresh, gz([row('p9', {})])); // a new, acknowledged upload after the restore
      await holder.query('COMMIT');
      await sweeping;
    } finally {
      holder.release();
    }
    expect(existsSync(fresh)).toBe(true);
  });
});
