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
import { PgOnecCommandRepository } from './adapters/pg-onec-command-repository';
import { PgOnecEtlRepository } from './adapters/pg-onec-etl-repository';
import { PgOnecRepository } from './adapters/pg-onec-repository';
import { OnecAlertProjector } from './application/onec-alert-projector';
import { OnecAuditWriter, type OnecAgentContext } from './application/onec-audit';
import { OnecCommandWakeups } from './application/onec-command-wakeups';
import { OnecCommandsService } from './application/onec-commands.service';
import { OnecEtlAdminService } from './application/onec-etl-admin.service';
import { OnecEtlCompletionService } from './application/onec-etl-completion.service';
import { OnecEtlIngestService } from './application/onec-etl-ingest.service';
import { OnecEtlParserService } from './application/onec-etl-parser.service';
import { OnecMonitorService } from './application/onec-monitor.service';
import type { OnecRuntimeConfig, OnecRuntimeConfigService } from './onec-runtime-config.service';

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
    for (const file of ['193_onec_agent_foundation.sql', '196_onec_agent_commands.sql', '198_onec_etl.sql']) {
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
    monitor = new OnecMonitorService(runtime, repo, db, new OnecAlertProjector(repo), commandsRepo, etlRepo, audit);
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
      await expect(upload({ runId, batchId, lines: [row('k1', {})] })).rejects.toThrow('connection lost after COMMIT');
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
});
