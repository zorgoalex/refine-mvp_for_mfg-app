import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
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
import { PgOnecStockSnapshotStore } from './adapters/pg-onec-stock-snapshot-store';
import { OnecAdminService } from './application/onec-admin.service';
import { OnecAgentProtocolService } from './application/onec-agent-protocol.service';
import { OnecAlertProjector } from './application/onec-alert-projector';
import { OnecAlertsPort } from './application/onec-alerts-port';
import { OnecAuditWriter, type OnecAgentContext } from './application/onec-audit';
import { OnecCommandWakeups } from './application/onec-command-wakeups';
import { OnecCommandsService } from './application/onec-commands.service';
import { OnecEtlCompletionService } from './application/onec-etl-completion.service';
import { OnecEtlEvents } from './application/onec-etl-events';
import { OnecEtlIngestService } from './application/onec-etl-ingest.service';
import { OnecEtlParserService } from './application/onec-etl-parser.service';
import { OnecEtlRevocationService } from './application/onec-etl-revocation.service';
import { OnecMonitorService } from './application/onec-monitor.service';
import { OnecStockSnapshotsService } from './application/onec-stock-snapshots.service';
import { CONFIG_APPLY_TIMEOUT_MS, SLOT_STUCK_MS, SYNC_DEADLINE_MS } from './domain/onec-stock-snapshot-rules';
import type { OnecRuntimeConfig, OnecRuntimeConfigService } from './onec-runtime-config.service';

const suite = process.env.ONEC_AGENT_DOCKER_TEST === 'true' ? describe : describe.skip;

const keeper = { id: '1', username: 'E2E-Тест', role: 'manager', roleId: 10, permissions: ['inventory.manage'] } as unknown as CurrentUser;
const operator = { id: '1', username: 'E2E-Тест', role: 'admin', roleId: 1, permissions: ['onec.manage', 'onec.view'] } as CurrentUser;
const DB_ID = '11111111-1111-4111-8111-111111111111';
const EPOCH = '22222222-2222-4222-8222-222222222222';
const NAMESPACE = `1c-identity:v1:${DB_ID}:${EPOCH}:test`;
const SET = 'stock_balances_at';
const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const I1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const I2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const ZERO = '00000000-0000-0000-0000-000000000000';
const MOMENT = '2026-09-26T10:14:00';
const PATH = (period: string) => `AccumulationRegister_ЗапасыНаСкладах/Balance(Period=datetime'${period}',Dimensions='Организация,Номенклатура,Характеристика,Партия,СтруктурнаяЕдиница,Ячейка')`;

suite('1C stock snapshots at a date — the queue and the port (isolated PostgreSQL, real ETL services)', () => {
  const schema = `e2e_onec_snap_${randomUUID().replaceAll('-', '')}`;
  const spoolDir = mkdtempSync(path.join(tmpdir(), 'onec-snap-test-'));
  const runtimeConfig = {
    enabled: true, agentPort: 3901, ingressSecrets: ['x'.repeat(40)], clientCertHeader: 'x-forwarded-tls-client-cert',
    sessionTtlMs: 600000, heartbeatIntervalMs: 60000, monitorOwner: 'none', monitorIntervalMs: 60000, nightlyFullSyncHourUtc: null,
    stockSnapshots: true, etlWorkerOwner: 'none', etlSpoolDir: spoolDir, etlSpoolMinFreeBytes: 0,
  } as OnecRuntimeConfig;
  const runtime = { get: () => runtimeConfig, requireEnabled: () => undefined } as unknown as OnecRuntimeConfigService;
  const agent: OnecAgentContext = { agentId: 'agent-a', sourceId: 1, certId: 1, requestId: 'r-a', correlationId: null };
  let pool: Pool;
  let db: DatabaseService;
  let repo: PgOnecRepository;
  let parser: OnecEtlParserService;
  let ingest: OnecEtlIngestService;
  let completion: OnecEtlCompletionService;
  let commands: OnecCommandsService;
  let monitor: OnecMonitorService;
  let admin: OnecAdminService;
  let snapshots: OnecStockSnapshotsService;
  let protocol: OnecAgentProtocolService;
  let generationRef = '';
  let session = '';
  /** A moment outside the hourly window, close to the real clock (command deadlines are checked against it). */
  let T0 = new Date();
  const later = (ms: number) => new Date(T0.getTime() + ms);
  /** Moves the test clock forward and keeps it outside the minutes of the hourly clock run. */
  const moveClock = (ms: number) => {
    T0 = new Date(T0.getTime() + ms);
    if (T0.getUTCMinutes() >= 58) T0 = new Date(T0.getTime() + 9 * 60_000);
    if (T0.getUTCMinutes() <= 6) T0 = new Date(T0.getTime() + (7 - T0.getUTCMinutes()) * 60_000);
  };

  beforeAll(async () => {
    const [container] = JSON.parse(execFileSync('docker', ['inspect', 'erp_test-postgresdb-1'], { encoding: 'utf8' }));
    const env = Object.fromEntries(container.Config.Env.map((entry: string) => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
    const network = Object.values(container.NetworkSettings.Networks)[0] as { IPAddress: string };
    const url = new URL(`postgresql://${network.IPAddress}:5432/${env.POSTGRES_DB ?? 'erpdb'}`);
    url.username = env.POSTGRES_USER;
    url.password = env.POSTGRES_PASSWORD;
    url.searchParams.set('options', `-c search_path=${schema},pg_catalog -c jit=off -c lock_timeout=5000`);
    pool = new Pool({ connectionString: url.toString(), max: 8, statement_timeout: 20000 });
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE users(user_id bigint PRIMARY KEY, username text); INSERT INTO users VALUES (1, 'E2E-Тест');
      CREATE TABLE roles(role_id bigint, role_code text); INSERT INTO roles VALUES (1, 'admin');
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, domain text, label text, description text, sort_order integer, is_dangerous boolean, is_active boolean, updated_at timestamptz);
      CREATE TABLE role_permissions(role_id bigint, permission_name text, is_enabled boolean, PRIMARY KEY(role_id, permission_name));
      CREATE TABLE permissions_state(id boolean, version integer, updated_at timestamptz); INSERT INTO permissions_state VALUES (true, 1, now());
      CREATE TABLE audit_log(LIKE public.audit_log INCLUDING ALL);
      CREATE TABLE audit_log_related_entity(LIKE public.audit_log_related_entity INCLUDING ALL);`);
    for (const file of ['193_onec_agent_foundation.sql', '196_onec_agent_commands.sql', '198_onec_etl.sql', '200_onec_etl_snapshots_revocation.sql',
      '247_onec_agent_expected_silence.sql', '250_onec_stock_snapshots.sql']) {
      await pool.query(readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    // The zone of the 1C base comes with migration 216 (documents); only this column of it is needed here.
    await pool.query(`ALTER TABLE onec_sources ADD COLUMN time_zone text NOT NULL DEFAULT 'Asia/Almaty'`);
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 20000, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 8, DATABASE_SSL: false };
    db = new DatabaseService(
      { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService,
    );
    repo = new PgOnecRepository(db);
    const etlRepo = new PgOnecEtlRepository(db);
    const events = new OnecEtlEvents();
    parser = new OnecEtlParserService(etlRepo, repo, runtime);
    ingest = new OnecEtlIngestService(etlRepo, repo, runtime, parser);
    const audit = new OnecAuditWriter(repo);
    completion = new OnecEtlCompletionService(etlRepo, repo, audit, parser, events);
    const commandsRepo = new PgOnecCommandRepository(db);
    commands = new OnecCommandsService(commandsRepo, repo, audit, new OnecCommandWakeups(db, runtime), runtime, etlRepo);
    const revocation = new OnecEtlRevocationService(etlRepo, runtime);
    const store = new PgOnecStockSnapshotStore(repo, audit);
    monitor = new OnecMonitorService(runtime, repo, db, new OnecAlertProjector(repo), commandsRepo, etlRepo, audit, revocation);
    admin = new OnecAdminService(repo, audit, runtime, etlRepo, revocation, store);
    snapshots = new OnecStockSnapshotsService(runtime, db, repo, store, admin, commands, new OnecAlertsPort(repo), events);
    protocol = new OnecAgentProtocolService(repo, audit);
  }, 60000);

  afterAll(async () => {
    await db?.onModuleDestroy();
    if (pool) {
      try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); }
    }
    rmSync(spoolDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    runtimeConfig.stockSnapshots = true;
    await pool.query(`TRUNCATE onec_etl_staging_rows, onec_etl_mirror_rows, onec_etl_entity_state, onec_etl_batches, onec_etl_runs,
      onec_agent_commands, onec_alerts, onec_outbox_events, onec_audit_links, onec_agent_incidents, onec_agent_config_drafts,
      onec_agent_status, onec_agent_sessions, onec_agent_certificates, onec_agents, onec_sources RESTART IDENTITY CASCADE;
      ALTER TABLE onec_agent_config_versions DISABLE TRIGGER onec_agent_config_version_immutable;
      DELETE FROM onec_agent_config_versions;
      ALTER TABLE onec_agent_config_versions ENABLE TRIGGER onec_agent_config_version_immutable;
      DELETE FROM audit_log_related_entity; DELETE FROM audit_log;
      INSERT INTO onec_sources (code, display_name, identity, identity_status)
        VALUES ('a', 'Тест A', '{"databaseId":"${DB_ID}","exportEpoch":"${EPOCH}","environment":"test"}', 'bound');
      INSERT INTO onec_agents (agent_id, source_id, site_id, display_name) VALUES ('agent-a', 1, 's', 'E2E A');`);
    generationRef = (await pool.query(`SELECT generation_ref FROM onec_sources WHERE source_id = 1`)).rows[0].generation_ref;
    session = (await pool.query(`INSERT INTO onec_agent_sessions (agent_id, agent_version, accepted) VALUES ('agent-a', '1.3.11', true) RETURNING session_id`)).rows[0].session_id;
    T0 = new Date();
    T0.setUTCSeconds(0, 0);
    if (T0.getUTCMinutes() >= 58) T0 = new Date(T0.getTime() + 9 * 60_000);
    if (T0.getUTCMinutes() <= 6) T0 = new Date(T0.getTime() + (7 - T0.getUTCMinutes()) * 60_000);
    // An operator configuration is published; the agent is online on 1.3.11 and has taken it.
    const entity = { entityCode: 'items', oDataPath: 'Catalog_Номенклатура', keyField: 'Ref_Key', select: ['Ref_Key'], syncMode: 'incremental', pageSize: 100, overlapMinutes: 0 };
    const draft = await admin.saveDraft('agent-a', undefined, { configuration: { mode: 'Normal', commandTypes: [], etlIntervalMinutes: 60, etlEntities: [entity] } }, operator, ctx('d'));
    await admin.publish('agent-a', { revision: draft.revision, configHash: draft.configHash }, operator, ctx('p'));
    await heartbeat();
  });

  // ---------------------------------------------------------------- helpers

  const ctx = (requestId: string) => ({ requestId, correlationId: null });
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
  const publishedVersion = async () => Number((await pool.query(`SELECT config_version FROM onec_agent_config_versions WHERE agent_id = 'agent-a' AND status = 'published'`)).rows[0].config_version);
  const publishedSet = async () => {
    const config = JSON.parse((await pool.query(`SELECT configuration_canonical FROM onec_agent_config_versions WHERE agent_id = 'agent-a' AND status = 'published'`)).rows[0].configuration_canonical);
    const set = (config.etlEntities as Array<{ entityCode: string; enabled?: boolean; oDataPath: string }>).find((item) => item.entityCode === SET);
    return set ? [set.enabled, set.oDataPath] : null;
  };
  /** The agent reports: alive at `at`, the given version active (default — the published one). */
  const heartbeat = async (patch: { at?: Date; version?: string | null; active?: number | null; rejected?: number | null } = {}) => {
    await pool.query(
      `INSERT INTO onec_agent_status (agent_id, received_at, agent_version, state, active_config_version, rejected_config_version)
       VALUES ('agent-a', $1, $2, 'healthy', $3, $4)
       ON CONFLICT (agent_id) DO UPDATE SET received_at = EXCLUDED.received_at, agent_version = EXCLUDED.agent_version,
         active_config_version = EXCLUDED.active_config_version, rejected_config_version = EXCLUDED.rejected_config_version`,
      [patch.at ?? T0, patch.version === undefined ? '1.3.11' : patch.version, patch.active === undefined ? await publishedVersion() : patch.active, patch.rejected ?? null]);
  };
  const slot = async () => (await pool.query(
    `SELECT state, to_char(period_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS period, owner_snapshot_id::int AS owner FROM onec_stock_snapshot_slot WHERE source_id = 1`)).rows[0] ?? null;
  // Commands of the port run in a real transaction of the caller (as the inventory service calls them): the
  // advisory lock, the header, the request key, the audit row and the outbox event commit or roll back together.
  const request = (momentLocal = MOMENT, extra: { force?: boolean; key?: string } = {}) =>
    db.transaction((tx) => snapshots.request({ sourceId: 1, momentLocal, force: extra.force, idempotencyKey: extra.key ?? `key-${randomUUID()}` }, keeper, 'req-user', tx));
  const remove = (id: number, requestId = 'del') => db.transaction((tx) => snapshots.delete(id, keeper, requestId, tx));
  /** Runs the queue of the source until nothing changes. */
  const settle = async (now = T0) => { for (let step = 0; step < 10 && (await snapshots.advance(1, now)); step += 1); };
  const stockRow = (key: string, warehouse: string | null, item: string, quantity: string | number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ sourceId: key, sourceUpdatedAt: null, deleted: false, data: {
      Организация_Key: ZERO, Номенклатура_Key: item, Характеристика_Key: ZERO, Партия_Key: ZERO, СтруктурнаяЕдиница_Key: warehouse ?? ZERO, Ячейка_Key: '',
      КоличествоBalance: quantity, ...extra } });
  const upload = async (runId: string, lines: string[], entity = SET) => {
    const body = gzipSync(Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8'));
    const batchId = randomUUID();
    await ingest.upload(agent, {
      'idempotency-key': batchId, 'x-batch-id': batchId, 'x-run-id': runId, 'x-entity': entity, 'x-schema-version': '1', 'x-row-count': String(lines.length),
      'x-content-sha256': createHash('sha256').update(body).digest('base64'), 'content-encoding': 'gzip', 'content-length': String(body.length),
      'x-source-namespace': NAMESPACE, 'x-source-generation': generationRef,
    }, Readable.from([body]));
    await parser.drainQueue();
  };
  const completeRun = (runId: string, rows: number, entity: Record<string, unknown> = {}, mode = 'bootstrap_full') => {
    const body = {
      runId, status: 'succeeded', mode, sourceIdentity: { databaseId: DB_ID, exportEpoch: EPOCH, environment: 'test' }, sourceGeneration: generationRef,
      rowsRead: rows, batchesCreated: 1, batchesAcknowledged: 1, completedAtUtc: new Date().toISOString(), entitiesFailed: entity.status === 'failed' ? 1 : 0,
      entities: [{ entity: SET, status: 'done', readScope: 'full', rowsRead: rows, batchesCreated: 1, errorCode: null, errorMessage: null,
        completeness: 'verified', completenessReason: null, snapshotAtUtc: new Date().toISOString(), ...entity }],
    };
    const raw = Buffer.from(JSON.stringify(body));
    return completion.complete(agent, runId, runId, JSON.parse(raw.toString()), raw, 0);
  };
  /** The agent takes the queued command; returns its id. */
  const lease = async () => {
    const leased = await commands.lease(agent, { sessionId: session, supportedCommandTypes: ['start_full_sync'], maxWaitSeconds: 1 }, new AbortController().signal) as
      { hasCommand: boolean; command?: { commandId: string; commandType: string; payload: unknown } };
    expect(leased.hasCommand).toBe(true);
    return leased.command!;
  };
  const answer = (commandId: string, runId: string) =>
    commands.result(agent, commandId, Buffer.from(JSON.stringify({ commandId, status: 'succeeded', resultVersion: 1, data: { accepted: true, runId, mode: 'bootstrap_full' } })));
  /** The agent does everything for the snapshot being read: takes the command, reads `lines`, completes the run. */
  const agentReads = async (lines: string[], entity: Record<string, unknown> = {}) => {
    const command = await lease();
    const runId = randomUUID();
    await upload(runId, lines);
    await answer(command.commandId, runId);
    await completeRun(runId, lines.length, entity);
    return { commandId: command.commandId, runId };
  };
  /** A requested snapshot is brought to `syncing` (the version is published and taken, the command is queued). */
  const toSyncing = async (momentLocal = MOMENT) => {
    const view = await request(momentLocal);
    await settle();
    await heartbeat();
    await settle();
    expect((await snapshots.get(view.id, {}, db)).status).toBe('syncing');
    return view.id;
  };
  const events = async (id: number) => (await pool.query(
    `SELECT event_type FROM onec_outbox_events WHERE aggregate_type = 'onec_stock_snapshot' AND aggregate_id = $1 ORDER BY event_id`, [String(id)])).rows.map((row) => row.event_type);

  // ---------------------------------------------------------------- the main path

  it('request → version with the period → command → the rows of ITS run → ready; then the set is switched off and the slot goes idle', async () => {
    expect(await snapshots.capabilities(1, db)).toEqual({ readAvailable: true, commandsAvailable: true, reason: null });
    const requested = await request();
    expect(requested).toMatchObject({
      sourceId: 1, currentSource: true, baseRef: generationRef, momentLocal: MOMENT, momentUtc: '2026-09-26T05:14:00.000Z', timeZone: 'Asia/Almaty',
      status: 'requested', waitReason: 'QUEUED', requestedBy: { id: 1, name: 'E2E-Тест' }, queuePosition: 1, activeAhead: false, rowsCount: null,
    });
    expect(await publishedSet()).toBeNull();

    // Step 1: the slot is taken and the version with the period goes out; the author of the version is the system.
    const before = await publishedVersion();
    expect(await snapshots.advance(1, T0)).toBe(true);
    expect(await publishedSet()).toEqual([true, PATH(MOMENT)]);
    expect(await slot()).toEqual({ state: 'active', period: MOMENT, owner: requested.id });
    const version = await publishedVersion();
    expect(version).toBeGreaterThan(before);
    expect((await pool.query(`SELECT published_by FROM onec_agent_config_versions WHERE config_version = $1`, [version])).rows[0].published_by).toBeNull();
    expect(await snapshots.get(requested.id, {}, db)).toMatchObject({ status: 'config_published', queuePosition: 0, waitReason: null });
    // The agent has not taken the version yet: nothing moves, no command.
    await heartbeat({ active: before });
    expect(await snapshots.advance(1, T0)).toBe(false);
    expect((await pool.query(`SELECT count(*)::int n FROM onec_agent_commands`)).rows[0].n).toBe(0);

    // Step 2: the agent took it → one read command for the set only, with a delivery deadline.
    await heartbeat();
    expect(await snapshots.advance(1, T0)).toBe(true);
    const command = (await pool.query(`SELECT command_type, payload_canonical::jsonb AS payload, source_module, source_entity_id, expires_at_utc IS NOT NULL AS has_deadline, idempotency_key FROM onec_agent_commands`)).rows;
    expect(command).toEqual([{ command_type: 'start_full_sync', payload: { entities: [SET] }, source_module: 'onec_stock_snapshots', source_entity_id: String(requested.id),
      has_deadline: true, idempotency_key: `stock-snapshot:${requested.id}` }]);
    // The same step again (a restart): no second command.
    expect(await snapshots.advance(1, T0)).toBe(false);
    expect((await pool.query(`SELECT count(*)::int n FROM onec_agent_commands`)).rows[0].n).toBe(1);

    // Step 3: the agent reads the register; the rows of the run are copied.
    const { runId } = await agentReads([
      stockRow('r1', W1, I1, '2.5'), stockRow('r2', W1, I2.toUpperCase(), 3), stockRow('r3', W2, I1, '4'), stockRow('r4', null, I2, '-1'),
    ]);
    expect(await snapshots.advance(1, T0)).toBe(true);
    const ready = await snapshots.get(requested.id, {}, db);
    expect(ready).toMatchObject({ status: 'ready', rowsCount: 4, queuePosition: null, errorCode: null });
    expect(ready.readAt).not.toBeNull();
    expect(await snapshots.rows(requested.id, {}, db)).toEqual([
      { organizationRefKey: null, itemRefKey: I1, characteristicRefKey: null, batchRefKey: null, warehouseRefKey: W1, cellRefKey: null, quantity: 2.5 },
      { organizationRefKey: null, itemRefKey: I2, characteristicRefKey: null, batchRefKey: null, warehouseRefKey: W1, cellRefKey: null, quantity: 3 },
      { organizationRefKey: null, itemRefKey: I1, characteristicRefKey: null, batchRefKey: null, warehouseRefKey: W2, cellRefKey: null, quantity: 4 },
      { organizationRefKey: null, itemRefKey: I2, characteristicRefKey: null, batchRefKey: null, warehouseRefKey: null, cellRefKey: null, quantity: -1 },
    ]);
    expect((await snapshots.rows(requested.id, { warehouseRefKeys: [W2.toUpperCase()] }, db)).map((row) => row.quantity)).toEqual([4]);
    expect(await snapshots.rows(requested.id, { warehouseRefKeys: [] }, db)).toEqual([]);
    expect(await snapshots.summary(requested.id, db)).toEqual([
      { warehouseRefKey: W1, rows: 2, quantityTotal: 5.5 }, { warehouseRefKey: W2, rows: 1, quantityTotal: 4 }, { warehouseRefKey: null, rows: 1, quantityTotal: -1 },
    ]);
    expect((await pool.query(`SELECT run_id::text FROM onec_stock_snapshots WHERE snapshot_id = $1`, [requested.id])).rows[0].run_id).toBe(runId);

    // Step 4: nothing else waits → the set is switched off (still in the configuration), then confirmed by the agent.
    expect(await snapshots.advance(1, T0)).toBe(true);
    expect(await publishedSet()).toEqual([false, PATH(MOMENT)]);
    expect((await slot()).state).toBe('disabling');
    expect(await snapshots.advance(1, T0)).toBe(false);
    await heartbeat();
    expect(await snapshots.advance(1, T0)).toBe(true);
    expect(await slot()).toEqual({ state: 'idle', period: MOMENT, owner: null });
    expect(await snapshots.advance(1, T0)).toBe(false);

    // Every transition left an audit row and one outbox event; the relay knows the new event types.
    expect(await events(requested.id)).toEqual(['onec.stock_snapshot.requested', 'onec.stock_snapshot.ready']);
    const audit = (await pool.query(
      `SELECT a.event, a.username, a.related_user_id::text AS initiator, l.actor_kind, l.correlation_id FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id
        WHERE a.event LIKE 'onec.stock_snapshot.%' ORDER BY a.created_at`)).rows;
    const correlation = (await pool.query(`SELECT correlation_id FROM onec_stock_snapshots WHERE snapshot_id = $1`, [requested.id])).rows[0].correlation_id;
    expect(correlation).toMatch(/^[0-9a-f-]{36}$/);
    expect(audit).toEqual([
      { event: 'onec.stock_snapshot.requested', username: 'E2E-Тест', initiator: '1', actor_kind: 'user', correlation_id: correlation },
      { event: 'onec.stock_snapshot.ready', username: 'onec_stock_snapshots', initiator: '1', actor_kind: 'system', correlation_id: correlation },
    ]);
    expect((await pool.query(`SELECT event, status_field, status_code FROM audit_log WHERE event LIKE 'onec.stock_snapshot.%' ORDER BY created_at`)).rows).toEqual([
      { event: 'onec.stock_snapshot.requested', status_field: 'status', status_code: 'requested' },
      { event: 'onec.stock_snapshot.ready', status_field: 'status', status_code: 'ready' },
    ]);
    // The command and the service publications carry the same correlation id.
    expect((await pool.query(`SELECT DISTINCT correlation_id::text AS c FROM onec_agent_commands`)).rows).toEqual([{ c: correlation }]);
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT count(*)::int n FROM onec_outbox_events WHERE event_type LIKE 'onec.stock_snapshot.%' AND status <> 'processed'`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM onec_alerts`)).rows[0].n).toBe(0);
  });

  it('an empty slice (one batch without rows, done / full / verified / 0) is a valid snapshot of zero rows', async () => {
    const id = await toSyncing('2020-01-01T00:00:00');
    await agentReads([]);
    await settle();
    expect(await snapshots.get(id, {}, db)).toMatchObject({ status: 'ready', rowsCount: 0 });
    expect(await snapshots.rows(id, {}, db)).toEqual([]);
    expect(await snapshots.summary(id, db)).toEqual([]);
  });

  // ---------------------------------------------------------------- requests and the line

  it('the same moment returns the existing snapshot; force and the idempotency key; the line is served in order and the slot is handed over without switching off', async () => {
    const first = await request(MOMENT, { key: 'key-first-1' });
    expect((await request(MOMENT)).id).toBe(first.id);
    expect((await request(MOMENT, { key: 'key-first-1', force: true })).id).toBe(first.id);
    const second = await request('2026-09-27T00:00:00');
    const forced = await request(MOMENT, { force: true, key: 'key-forced-1' });
    expect((await request(MOMENT, { force: true, key: 'key-forced-1' })).id).toBe(forced.id);
    expect([second.queuePosition, second.activeAhead, forced.queuePosition]).toEqual([2, true, 3]);
    expect(await code(request('2026-09-26 10:14:00'))).toBe('VALIDATION_ERROR');
    expect(await code(request('2999-01-01T00:00:00'))).toBe('VALIDATION_ERROR');
    // An unknown source is a mistake of the request, as in the in-memory implementation of the port.
    expect(await code(db.transaction((tx) => snapshots.request({ sourceId: 9, momentLocal: MOMENT, idempotencyKey: 'key-other-source' }, keeper, 'r', tx)))).toBe('VALIDATION_ERROR');
    expect(await snapshots.capabilities(9, db)).toEqual({ readAvailable: true, commandsAvailable: false, reason: 'SOURCE_NOT_CONFIGURED' });
    expect(await code(db.transaction((tx) => snapshots.request({ sourceId: 1, momentLocal: MOMENT, idempotencyKey: 'short' }, keeper, 'r', tx)))).toBe('VALIDATION_ERROR');

    await settle();
    await heartbeat();
    await settle();
    expect((await snapshots.list({ sourceId: 1 }, db)).items.map((item) => [item.id, item.status, item.queuePosition])).toEqual([
      [forced.id, 'requested', 2], [second.id, 'requested', 1], [first.id, 'syncing', 0],
    ]);
    await agentReads([stockRow('r1', W1, I1, 1)]);
    // The first becomes ready and, in the same pass, the slot goes to the second with the new period — no «disabled» version in between.
    const versionsBefore = Number((await pool.query(`SELECT count(*)::int n FROM onec_agent_config_versions`)).rows[0].n);
    await settle();
    expect((await snapshots.get(first.id, {}, db)).status).toBe('ready');
    expect(await slot()).toEqual({ state: 'active', period: '2026-09-27T00:00:00', owner: second.id });
    expect(await publishedSet()).toEqual([true, PATH('2026-09-27T00:00:00')]);
    expect(Number((await pool.query(`SELECT count(*)::int n FROM onec_agent_config_versions`)).rows[0].n)).toBe(versionsBefore + 1);
    await heartbeat();
    await settle();
    await agentReads([stockRow('r1', W1, I1, 7), stockRow('r2', W2, I1, 8)]);
    await settle();
    expect(await snapshots.get(second.id, {}, db)).toMatchObject({ status: 'ready', rowsCount: 2 });
    // The third is a forced repeat of the first moment: the same path as already published once → still read anew.
    expect(await slot()).toEqual({ state: 'active', period: MOMENT, owner: forced.id });
    await heartbeat();
    await settle();
    await agentReads([stockRow('r1', W1, I1, 9)]);
    await settle();
    expect((await snapshots.rows(forced.id, {}, db)).map((row) => row.quantity)).toEqual([9]);
    // Rows of the earlier snapshots are their own.
    expect((await snapshots.rows(first.id, {}, db)).map((row) => row.quantity)).toEqual([1]);
    expect((await snapshots.rows(second.id, {}, db)).map((row) => row.quantity)).toEqual([7, 8]);
    // A ready snapshot of the moment exists now: a plain request returns the newest of them.
    expect((await request(MOMENT)).id).toBe(forced.id);
  });

  it('a request key is answered with the same snapshot for ever — also a key that was answered with an existing snapshot', async () => {
    const a = await toSyncing();
    await agentReads([stockRow('r1', W1, I1, 1)]);
    await settle();
    // K2 asks for the same moment and is answered with A.
    expect((await request(MOMENT, { key: 'key-second-2' })).id).toBe(a);
    // Then a forced snapshot B of the same moment appears and becomes the newest ready one.
    await heartbeat();
    const b = await request(MOMENT, { force: true, key: 'key-forced-b' });
    await settle();
    await heartbeat();
    await settle();
    await agentReads([stockRow('r1', W1, I1, 2)]);
    await settle();
    expect((await snapshots.get(b.id, {}, db)).status).toBe('ready');
    expect((await request(MOMENT, { key: 'key-third-3' })).id).toBe(b.id);
    // K2 repeated: still A, not B — with or without force, and after A is deleted.
    expect((await request(MOMENT, { key: 'key-second-2' })).id).toBe(a);
    expect((await request(MOMENT, { key: 'key-second-2', force: true })).id).toBe(a);
    await remove(a, 'del-a');
    const afterDelete = await request(MOMENT, { key: 'key-second-2' });
    expect([afterDelete.id, afterDelete.deletedAt !== null]).toEqual([a, true]);
    expect((await pool.query(`SELECT idempotency_key, snapshot_id::int AS id FROM onec_stock_snapshot_requests ORDER BY created_at, idempotency_key`)).rows.map((row) => [row.idempotency_key.replace(/^key-[0-9a-f-]{36}$/, 'key-random'), row.id]))
      .toEqual([['key-random', a], ['key-second-2', a], ['key-forced-b', b.id], ['key-third-3', b.id]]);
    // A failed snapshot answers its own key too; a new key of that moment gets a new snapshot.
    await heartbeat();
    const failing = await request('2026-09-30T00:00:00', { key: 'key-failing-1' });
    await settle();
    await heartbeat({ active: null, rejected: await publishedVersion() });
    await settle();
    expect((await snapshots.get(failing.id, {}, db)).status).toBe('failed');
    expect((await request('2026-09-30T00:00:00', { key: 'key-failing-1' })).id).toBe(failing.id);
    expect((await request('2026-09-30T00:00:00', { key: 'key-after-fail' })).id).not.toBe(failing.id);
  });

  it('concurrent requests of one moment or one key give one snapshot; a failure of the audit or the outbox leaves nothing behind', async () => {
    const sameMoment = await Promise.all(Array.from({ length: 6 }, (_, index) => request(MOMENT, { key: `key-concurrent-${index}` })));
    expect(new Set(sameMoment.map((view) => view.id)).size).toBe(1);
    const sameKey = await Promise.all(Array.from({ length: 6 }, () => request('2026-09-27T00:00:00', { key: 'key-one-and-only', force: true })));
    expect(new Set(sameKey.map((view) => view.id)).size).toBe(1);
    expect((await pool.query(`SELECT count(*)::int n FROM onec_stock_snapshots`)).rows[0].n).toBe(2);
    expect((await pool.query(`SELECT count(*)::int n FROM onec_stock_snapshot_requests`)).rows[0].n).toBe(7);
    expect((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE event = 'onec.stock_snapshot.requested'`)).rows[0].n).toBe(2);
    expect((await pool.query(`SELECT count(*)::int n FROM onec_outbox_events WHERE event_type = 'onec.stock_snapshot.requested'`)).rows[0].n).toBe(2);
    // Forced requests with different keys at once: each its own snapshot, none lost.
    const forced = await Promise.all(Array.from({ length: 4 }, (_, index) => request('2026-09-28T00:00:00', { key: `key-forced-${index}`, force: true })));
    expect(new Set(forced.map((view) => view.id)).size).toBe(4);

    // The outbox refuses the event: the whole request rolls back — no header, no key, no audit row.
    const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM onec_stock_snapshots)::int AS s, (SELECT count(*) FROM onec_stock_snapshot_requests)::int AS k,
      (SELECT count(*) FROM audit_log WHERE event LIKE 'onec.stock_snapshot.%')::int AS a, (SELECT count(*) FROM onec_outbox_events WHERE event_type LIKE 'onec.stock_snapshot.%')::int AS o`)).rows[0];
    const before = await counts();
    await pool.query(`CREATE FUNCTION refuse_snapshot_event() RETURNS trigger AS $$ BEGIN IF NEW.event_type LIKE 'onec.stock_snapshot.%' THEN RAISE EXCEPTION 'outbox down'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_refuse_snapshot_event BEFORE INSERT ON onec_outbox_events FOR EACH ROW EXECUTE FUNCTION refuse_snapshot_event()`);
    try {
      await expect(request('2026-09-29T00:00:00', { key: 'key-rolled-back' })).rejects.toThrow(/outbox down/);
      expect(await counts()).toEqual(before);
      // Deleting rolls back as a whole too: the snapshot stays exactly as it was.
      const target = sameMoment[0]!.id;
      await expect(remove(target, 'del-rolled-back')).rejects.toThrow(/outbox down/);
      expect(await snapshots.get(target, {}, db)).toMatchObject({ status: 'requested', deletedAt: null });
      expect(await counts()).toEqual(before);
    } finally {
      await pool.query(`DROP TRIGGER trg_refuse_snapshot_event ON onec_outbox_events; DROP FUNCTION refuse_snapshot_event()`);
    }
    // The key of the rolled-back request is free: the same request succeeds afterwards.
    expect((await request('2026-09-29T00:00:00', { key: 'key-rolled-back' })).status).toBe('requested');
  });

  it('the queue resumes long after the agent applied the version (a restart): the command is queued with a fresh deadline, also while switching off', async () => {
    const view = await request();
    await settle();
    await heartbeat();
    // The backend was down for 9 minutes of the allowed 10: the version is active, the step runs late.
    const resumed = later(CONFIG_APPLY_TIMEOUT_MS - 60_000);
    await heartbeat({ at: resumed });
    runtimeConfig.stockSnapshots = false;
    expect(await snapshots.advance(1, resumed)).toBe(true);
    expect((await snapshots.get(view.id, {}, db)).status).toBe('syncing');
    const deadline = (await pool.query(`SELECT expires_at_utc FROM onec_agent_commands`)).rows[0].expires_at_utc as Date;
    expect(deadline.getTime()).toBeGreaterThan(resumed.getTime() + 9 * 60_000);
    // Hours later with an active version: the command is still queued (never «already expired» in a loop).
    await pool.query(`UPDATE onec_agent_commands SET status = 'cancelled'; UPDATE onec_stock_snapshots SET status = 'config_published', command_id = NULL, syncing_at = NULL;
      DELETE FROM onec_agent_commands`);
    T0 = new Date(Date.now() + 5 * 60_000);
    T0.setUTCSeconds(0, 0);
    if (T0.getUTCMinutes() >= 58 || T0.getUTCMinutes() <= 6) T0 = new Date(T0.getTime() + 10 * 60_000);
    await pool.query(`UPDATE onec_stock_snapshots SET config_published_at = now() - interval '3 hours'`);
    await heartbeat();
    expect(await snapshots.advance(1, T0)).toBe(true);
    expect((await snapshots.get(view.id, {}, db)).status).toBe('syncing');
    // The flag is off: the started snapshot is still finished and the slot is switched off.
    await agentReads([stockRow('r1', W1, I1, 1)]);
    await settle();
    expect((await snapshots.get(view.id, {}, db)).status).toBe('ready');
    expect((await slot()).state).toBe('disabling');
  });

  it('a snapshot waits, with a reason, while the agent is offline, too old, busy, the publication is blocked or the clock forbids — nothing is published', async () => {
    const view = await request();
    const reason = async (now = T0) => { await settle(now); return (await snapshots.get(view.id, {}, db)).waitReason; };
    await heartbeat({ at: later(-10 * 60_000) });
    expect(await reason()).toBe('AGENT_OFFLINE');
    await heartbeat({ version: '1.3.10' });
    expect(await reason()).toBe('AGENT_TOO_OLD');
    expect(await snapshots.capabilities(1, db)).toEqual({ readAvailable: true, commandsAvailable: false, reason: 'AGENT_TOO_OLD' });
    await heartbeat({ version: null });
    expect(await reason()).toBe('AGENT_TOO_OLD');
    await heartbeat();
    await pool.query(`UPDATE onec_agents SET config_publish_blocked = true, config_publish_blocked_at = now()`);
    expect(await reason()).toBe('CONFIG_PUBLISH_BLOCKED');
    await pool.query(`UPDATE onec_agents SET config_publish_blocked = false, expected_silence_utc = $1`, [
      `${String(T0.getUTCHours()).padStart(2, '0')}:${String(T0.getUTCMinutes()).padStart(2, '0')}-${String((T0.getUTCHours() + 1) % 24).padStart(2, '0')}:00`]);
    expect(await reason()).toBe('AGENT_QUIET_WINDOW');
    await pool.query(`UPDATE onec_agents SET expected_silence_utc = NULL`);
    const topOfHour = new Date(T0.getTime());
    topOfHour.setUTCMinutes(59);
    await heartbeat({ at: topOfHour });
    expect(await reason(topOfHour)).toBe('HOURLY_RUN_WINDOW');
    await heartbeat();
    // Another extraction is under way: a queued ETL command, then an open run.
    const other = await commands.enqueue(db, { agentId: 'agent-a', commandType: 'start_full_sync', payload: { entities: [] }, sourceModule: 'e2e', idempotencyKey: `e2e-${randomUUID()}` });
    expect(await reason()).toBe('AGENT_BUSY');
    await pool.query(`UPDATE onec_agent_commands SET status = 'succeeded' WHERE command_id = $1`, [other.command.commandId]);
    const openRun = randomUUID();
    await upload(openRun, [JSON.stringify({ sourceId: 'k', sourceUpdatedAt: null, deleted: false, data: {} })], 'items');
    expect(await reason()).toBe('AGENT_BUSY');
    expect(await publishedSet()).toBeNull();
    expect(await slot()).toBeNull();
    // A run that has been open for more than an hour is stuck and no longer holds the line.
    await pool.query(`UPDATE onec_etl_runs SET created_at = now() - interval '61 minutes' WHERE run_id = $1`, [openRun]);
    await settle();
    expect((await snapshots.get(view.id, {}, db)).status).toBe('config_published');
  });

  // ---------------------------------------------------------------- failures

  it('a rejected or never applied version fails the snapshot before any command; the slot is switched off', async () => {
    const rejected = await request();
    await settle();
    await heartbeat({ active: null, rejected: await publishedVersion() });
    await snapshots.advance(1, T0);
    expect(await snapshots.get(rejected.id, {}, db)).toMatchObject({ status: 'failed', errorCode: 'CONFIG_REJECTED' });
    expect((await pool.query(`SELECT count(*)::int n FROM onec_agent_commands`)).rows[0].n).toBe(0);
    await settle();
    expect((await slot()).state).toBe('disabling');
    expect(await publishedSet()).toEqual([false, PATH(MOMENT)]);
    await heartbeat();
    await settle();
    expect((await slot()).state).toBe('idle');

    const ignored = await request('2026-09-27T00:00:00');
    await settle();
    await heartbeat({ active: 1 });
    await settle(later(CONFIG_APPLY_TIMEOUT_MS - 1000));
    expect((await snapshots.get(ignored.id, {}, db)).status).toBe('config_published');
    await snapshots.advance(1, later(CONFIG_APPLY_TIMEOUT_MS + 1000));
    expect(await snapshots.get(ignored.id, {}, db)).toMatchObject({ status: 'failed', errorCode: 'CONFIG_NOT_APPLIED' });
    expect(await events(ignored.id)).toEqual(['onec.stock_snapshot.requested', 'onec.stock_snapshot.failed']);
  });

  it('the agent refuses the command or reads an unverified snapshot: failed with the reason, nothing is copied', async () => {
    const refused = await toSyncing();
    const command = await lease();
    await commands.result(agent, command.commandId, Buffer.from(JSON.stringify({ commandId: command.commandId, status: 'business_error', resultVersion: 1, error: { code: 'ENTITY_UNKNOWN', message: 'x' } })));
    await settle();
    expect(await snapshots.get(refused.valueOf(), {}, db)).toMatchObject({ status: 'failed', errorCode: 'COMMAND_BUSINESS_ERROR:ENTITY_UNKNOWN' });

    await heartbeat();
    const unverified = await toSyncing('2026-09-27T00:00:00');
    await agentReads([stockRow('r1', W1, I1, 1)], { completeness: 'unverified', completenessReason: 'COUNT_MISMATCH' });
    await settle();
    expect(await snapshots.get(unverified, {}, db)).toMatchObject({ status: 'failed', errorCode: 'SNAPSHOT_REJECTED:NOT_VERIFIED' });
    // The failure knows the run it was found in: in the header, in the audit link and in the event.
    const failedRun = (await pool.query(`SELECT run_id::text AS run FROM onec_stock_snapshots WHERE snapshot_id = $1`, [unverified])).rows[0].run;
    expect(failedRun).toMatch(/^[0-9a-f-]{36}$/);
    const failedAudit = (await pool.query(
      `SELECT a.status_field, a.status_code, l.run_id::text AS run, l.command_id IS NOT NULL AS has_command
         FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id WHERE a.event = 'onec.stock_snapshot.failed' AND a.entity_id = $1`, [String(unverified)])).rows;
    expect(failedAudit).toEqual([{ status_field: 'status', status_code: 'failed', run: failedRun, has_command: true }]);
    const failedEvent = (await pool.query(`SELECT payload_json->'data'->>'runId' AS run FROM onec_outbox_events WHERE event_type = 'onec.stock_snapshot.failed' AND aggregate_id = $1`, [String(unverified)])).rows[0].run;
    expect(failedEvent).toBe(failedRun);
    expect((await pool.query(`SELECT count(*)::int n FROM onec_stock_snapshot_rows`)).rows[0].n).toBe(0);

    await heartbeat();
    const invalid = await toSyncing('2026-09-28T00:00:00');
    await agentReads([stockRow('r1', W1, I1, 1), stockRow('r2', W1, 'not-a-key', 1)]);
    await settle();
    expect(await snapshots.get(invalid, {}, db)).toMatchObject({ status: 'failed', errorCode: 'INVALID_ROWS' });
    expect(await code(snapshots.rows(invalid, {}, db))).toBe('ONEC_STOCK_SNAPSHOT_NOT_READY');
  });

  it('one deadline for every unfinished branch: no result, a result without a run, a run that never completes — failed, an alert, the slot is released', async () => {
    // The command was never taken: at the deadline it is cancelled by the system, audited once.
    const undelivered = await toSyncing('2026-09-20T00:00:00');
    await snapshots.advance(1, later(SYNC_DEADLINE_MS + 1000));
    expect(await snapshots.get(undelivered, {}, db)).toMatchObject({ status: 'failed', errorCode: 'SYNC_TIMEOUT' });
    expect((await pool.query(`SELECT status, cancelled_by FROM onec_agent_commands`)).rows).toEqual([{ status: 'cancelled', cancelled_by: null }]);
    const cancelAudit = (await pool.query(
      `SELECT a.username, a.user_id, a.status_code, a.after_json->>'reason' AS reason, l.actor_kind, l.command_id IS NOT NULL AS linked, l.correlation_id IS NOT NULL AS correlated
         FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id WHERE a.event = 'onec.command.cancelled'`)).rows;
    expect(cancelAudit).toEqual([{ username: 'onec_stock_snapshots', user_id: null, status_code: 'cancelled', reason: 'stock_snapshot_sync_timeout', actor_kind: 'system', linked: true, correlated: true }]);
    expect((await pool.query(`SELECT details->>'commandCancelled' AS cancelled FROM onec_alerts`)).rows).toEqual([{ cancelled: 'true' }]);
    // Events carry the common envelope of the module.
    const envelope = (await pool.query(`SELECT payload_json FROM onec_outbox_events WHERE event_type = 'onec.stock_snapshot.failed'`)).rows[0].payload_json;
    expect(envelope).toMatchObject({
      envelopeVersion: 1, eventType: 'onec.stock_snapshot.failed', severity: 'warning', actor: { kind: 'system', id: 'onec_stock_snapshots' },
      agentId: 'agent-a', sourceId: 1, subject: { type: 'onec_stock_snapshot', id: String(undelivered) }, requestId: 'req-user',
      data: { errorCode: 'SYNC_TIMEOUT', previousStatus: 'syncing', momentLocal: '2026-09-20T00:00:00', requestedBy: 1 },
    });
    expect(typeof envelope.occurredAt).toBe('string');
    expect(envelope.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    const requestedEnvelope = (await pool.query(`SELECT payload_json FROM onec_outbox_events WHERE event_type = 'onec.stock_snapshot.requested'`)).rows[0].payload_json;
    expect(requestedEnvelope).toMatchObject({ envelopeVersion: 1, severity: 'info', actor: { kind: 'user', id: '1' }, subject: { type: 'onec_stock_snapshot' } });
    await pool.query(`DELETE FROM onec_alerts; DELETE FROM onec_agent_commands`);
    moveClock(SYNC_DEADLINE_MS + 2 * 60_000);
    await heartbeat();
    await settle();
    await heartbeat();
    await settle();

    // The agent took the command and went silent.
    const silent = await toSyncing();
    await lease();
    await settle(later(SYNC_DEADLINE_MS - 1000));
    expect((await snapshots.get(silent, {}, db)).status).toBe('syncing');
    await snapshots.advance(1, later(SYNC_DEADLINE_MS + 1000));
    expect(await snapshots.get(silent, {}, db)).toMatchObject({ status: 'failed', errorCode: 'SYNC_TIMEOUT' });
    expect((await pool.query(`SELECT kind, details->>'snapshotId' AS snapshot FROM onec_alerts WHERE state <> 'resolved'`)).rows)
      .toEqual([{ kind: 'onec_stock_snapshot_command_unknown', snapshot: String(silent) }]);
    // The slot is not held by the command of an unknown outcome.
    await heartbeat({ at: later(SYNC_DEADLINE_MS + 1000) });
    await settle(later(SYNC_DEADLINE_MS + 1000));
    expect((await slot()).state).not.toBe('active');

    // The run started (the command succeeded, a batch arrived) and its completion never came.
    await pool.query(`UPDATE onec_agent_commands SET status = 'succeeded'; UPDATE onec_etl_runs SET status = 'abandoned' WHERE status = 'receiving'`);
    moveClock(SYNC_DEADLINE_MS + 2 * 60_000);
    await heartbeat();
    await settle();
    const hanging = await toSyncing('2026-09-27T00:00:00');
    const command = await lease();
    const runId = randomUUID();
    await upload(runId, [stockRow('r1', W1, I1, 1)]);
    await answer(command.commandId, runId);
    expect((await pool.query(`SELECT status FROM onec_etl_runs WHERE run_id = $1`, [runId])).rows[0].status).toBe('receiving');
    await settle(later(SYNC_DEADLINE_MS - 1000));
    expect((await snapshots.get(hanging, {}, db)).status).toBe('syncing');
    await snapshots.advance(1, later(SYNC_DEADLINE_MS + 1000));
    expect(await snapshots.get(hanging, {}, db)).toMatchObject({ status: 'failed', errorCode: 'SYNC_TIMEOUT' });
    // The late completion of that run changes nothing in the failed snapshot.
    await completeRun(runId, 1);
    await settle(later(SYNC_DEADLINE_MS + 1000));
    expect(await snapshots.get(hanging, {}, db)).toMatchObject({ status: 'failed', errorCode: 'SYNC_TIMEOUT', rowsCount: null });
    expect((await pool.query(`SELECT count(*)::int n FROM onec_stock_snapshot_rows`)).rows[0].n).toBe(0);
  });

  it('a stray run of an earlier command never gets into another snapshot: the next one copies ITS run or fails with SNAPSHOT_REPLACED', async () => {
    // Snapshot A times out with its command in the agent's hands; B takes the slot and is read.
    const a = await toSyncing();
    const commandA = await lease();
    await snapshots.advance(1, later(SYNC_DEADLINE_MS + 1000));
    expect((await snapshots.get(a, {}, db)).status).toBe('failed');
    moveClock(SYNC_DEADLINE_MS + 2 * 60_000);
    await pool.query(`UPDATE onec_agent_commands SET created_at = now() - interval '2 hours'`);
    await heartbeat();
    const b = await request('2026-09-27T00:00:00');
    await settle();
    await heartbeat();
    await settle();
    expect((await snapshots.get(b.id, {}, db)).status).toBe('syncing');
    const commandB = await lease();
    const runB = randomUUID();
    await upload(runB, [stockRow('b1', W1, I1, 100)]);
    await answer(commandB.commandId, runB);
    await completeRun(runB, 1);
    // The stray command A wakes up and reads the set (with the period of B) AFTER the run of B was applied.
    const runA = randomUUID();
    await upload(runA, [stockRow('a1', W1, I1, 666)]);
    await answer(commandA.commandId, runA);
    await completeRun(runA, 1);
    await settle();
    // The mirror is the stray run now: B does not take foreign rows — it fails and is requested again.
    expect(await snapshots.get(b.id, {}, db)).toMatchObject({ status: 'failed', errorCode: 'SNAPSHOT_REPLACED' });
    expect((await pool.query(`SELECT count(*)::int n FROM onec_stock_snapshot_rows`)).rows[0].n).toBe(0);
    expect((await snapshots.get(a, {}, db)).status).toBe('failed');

    // The other order: the stray run completes first, then the run of C — C copies exactly its own rows.
    await heartbeat();
    const c = await toSyncing('2026-09-28T00:00:00');
    const commandC = await lease();
    const stray = randomUUID();
    await upload(stray, [stockRow('s1', W1, I1, 666)]);
    await completeRun(stray, 1, {}, 'incremental');
    const runC = randomUUID();
    await upload(runC, [stockRow('c1', W2, I2, 5)]);
    await answer(commandC.commandId, runC);
    await completeRun(runC, 1);
    await settle();
    expect(await snapshots.get(c, {}, db)).toMatchObject({ status: 'ready', rowsCount: 1 });
    expect(await snapshots.rows(c, {}, db)).toMatchObject([{ warehouseRefKey: W2, itemRefKey: I2, quantity: 5 }]);
  });

  it('the 1C base is replaced (rebaseline): unfinished snapshots fail, ready ones become historical and are not returned for the same moment', async () => {
    const old = await toSyncing();
    await agentReads([stockRow('r1', W1, I1, 1)]);
    await settle();
    const active = await toSyncing('2026-09-27T00:00:00');
    const waiting = await request('2026-09-28T00:00:00');
    const generation = Number((await pool.query(`SELECT generation FROM onec_sources WHERE source_id = 1`)).rows[0].generation);
    await admin.rebaseline(1, { expectedGeneration: generation }, operator, ctx('rebaseline'));
    expect(await snapshots.get(active, {}, db)).toMatchObject({ status: 'failed', errorCode: 'SOURCE_GENERATION_CHANGED', currentSource: false });
    expect(await snapshots.get(waiting.id, {}, db)).toMatchObject({ status: 'failed', errorCode: 'SOURCE_GENERATION_CHANGED' });
    const historical = await snapshots.get(old, {}, db);
    expect(historical).toMatchObject({ status: 'ready', currentSource: false, baseRef: generationRef });
    expect((await snapshots.rows(old, {}, db)).length).toBe(1);
    // A refused rebaseline (stale generation) fails nothing.
    expect(await code(admin.rebaseline(1, { expectedGeneration: generation }, operator, ctx('rebaseline-2')))).toBe('ONEC_GENERATION_CHANGED');
    await heartbeat();
    await settle();
    const again = await request();
    expect(again.id).not.toBe(old);
    expect(again).toMatchObject({ currentSource: true });
    expect(again.baseRef).not.toBe(generationRef);
    expect((await snapshots.list({ sourceId: 1, currentSourceOnly: true }, db)).items.map((item) => item.id)).toEqual([again.id]);
  });

  // ---------------------------------------------------------------- the operator and the slot

  it('an operator publication during a snapshot keeps the set; a slot that cannot be switched off raises an alert and is retried', async () => {
    const id = await toSyncing();
    const view = await admin.getConfiguration('agent-a');
    const { sourceGeneration: _generation, ...base } = view.published!.configuration as Record<string, unknown>;
    const draftRevision = Number((await pool.query(`SELECT revision FROM onec_agent_config_drafts WHERE agent_id = 'agent-a'`)).rows[0].revision);
    const draft = await admin.saveDraft('agent-a', String(draftRevision), { configuration: { ...base, etlIntervalMinutes: 30 } }, operator, ctx('op-d'));
    await admin.publish('agent-a', { revision: draft.revision, configHash: draft.configHash }, operator, ctx('op-p'));
    expect(await publishedSet()).toEqual([true, PATH(MOMENT)]);
    // Publications become blocked (a restore) before the snapshot is ready: it is still collected, but the set cannot be
    // switched off — the slot stays «disabling», retried every pass, with an alert after 15 minutes.
    await pool.query(`UPDATE onec_agents SET config_publish_blocked = true, config_publish_blocked_at = now()`);
    await agentReads([stockRow('r1', W1, I1, 1)]);
    await settle();
    expect((await snapshots.get(id, {}, db)).status).toBe('ready');
    expect((await slot()).state).toBe('disabling');
    expect(await publishedSet()).toEqual([true, PATH(MOMENT)]);
    expect((await pool.query(`SELECT count(*)::int n FROM onec_alerts`)).rows[0].n).toBe(0);
    await settle(later(SLOT_STUCK_MS + 1000));
    expect((await pool.query(`SELECT kind, details->>'reason' AS reason FROM onec_alerts WHERE state <> 'resolved'`)).rows).toEqual([{ kind: 'onec_stock_snapshot_slot_stuck', reason: 'CONFIG_PUBLISH_BLOCKED' }]);
    await pool.query(`UPDATE onec_agents SET config_publish_blocked = false`);
    await settle(later(SLOT_STUCK_MS + 1000));
    expect(await publishedSet()).toEqual([false, PATH(MOMENT)]);
    await heartbeat({ at: later(SLOT_STUCK_MS + 1000) });
    await settle(later(SLOT_STUCK_MS + 1000));
    expect((await slot()).state).toBe('idle');
    expect((await pool.query(`SELECT count(*)::int n FROM onec_alerts WHERE state <> 'resolved'`)).rows[0].n).toBe(0);
  });

  it('switched off by the flag: nothing new, what was started is finished, waiting requests fail, the set goes off; then it can be removed for a rollback', async () => {
    const reading = await toSyncing();
    const waiting = await request('2026-09-27T00:00:00');
    runtimeConfig.stockSnapshots = false;
    expect(await snapshots.capabilities(1, db)).toEqual({ readAvailable: true, commandsAvailable: false, reason: 'MODULE_DISABLED' });
    expect(await code(request('2026-09-28T00:00:00'))).toBe('ONEC_STOCK_SNAPSHOTS_UNAVAILABLE');
    expect(await code(snapshots.removeManagedSet(1, operator, 'rm-early'))).toBe('ONEC_STOCK_SNAPSHOT_SLOT_BUSY');
    await agentReads([stockRow('r1', W1, I1, 1)]);
    await settle();
    expect((await snapshots.get(reading, {}, db)).status).toBe('ready');
    expect(await snapshots.get(waiting.id, {}, db)).toMatchObject({ status: 'failed', errorCode: 'MODULE_DISABLED' });
    expect(await publishedSet()).toEqual([false, PATH(MOMENT)]);
    await heartbeat();
    await settle();
    expect((await slot()).state).toBe('idle');
    // Reading and cleaning the history still work.
    expect((await snapshots.list({}, db)).total).toBe(2);
    expect((await snapshots.rows(reading, {}, db)).length).toBe(1);
    await remove(waiting.id, 'del-1');
    // Before a rollback of the image: the set leaves the configuration entirely; an older validator accepts the document.
    const removed = await snapshots.removeManagedSet(1, operator, 'rm-1');
    expect(removed.changed).toBe(true);
    expect(await publishedSet()).toBeNull();
    expect((await slot()).state).toBe('removed');
    expect(await snapshots.removeManagedSet(1, operator, 'rm-2')).toEqual({ configVersion: null, changed: false });
    const published = JSON.parse((await pool.query(`SELECT configuration_canonical FROM onec_agent_config_versions WHERE agent_id = 'agent-a' AND status = 'published'`)).rows[0].configuration_canonical);
    expect(JSON.stringify(published)).not.toContain('Period=');
    // Switched on again: the first snapshot brings the set back.
    runtimeConfig.stockSnapshots = true;
    expect(await code(snapshots.removeManagedSet(1, operator, 'rm-3'))).toBe('ONEC_STOCK_SNAPSHOTS_ENABLED');
    await heartbeat();
    const back = await toSyncing('2026-09-29T00:00:00');
    expect(await publishedSet()).toEqual([true, PATH('2026-09-29T00:00:00')]);
    expect((await snapshots.get(back, {}, db)).status).toBe('syncing');
  });

  // ---------------------------------------------------------------- delete and reading

  it('delete: a ready or failed snapshot disappears with its rows, a waiting one is cancelled, one being read is refused; all audited', async () => {
    const ready = await toSyncing();
    await agentReads([stockRow('r1', W1, I1, 1), stockRow('r2', W2, I1, 2)]);
    await settle();
    await heartbeat();
    const reading = await toSyncing('2026-09-27T00:00:00');
    const waiting = await request('2026-09-28T00:00:00');
    expect(await code(remove(reading, 'del'))).toBe('ONEC_STOCK_SNAPSHOT_IN_PROGRESS');
    await remove(ready, 'del-ready');
    await remove(waiting.id, 'del-waiting');
    for (const id of [ready, waiting.id]) {
      expect(await code(snapshots.get(id, {}, db))).toBe('ONEC_STOCK_SNAPSHOT_NOT_FOUND');
      expect(await code(snapshots.rows(id, {}, db))).toBe('ONEC_STOCK_SNAPSHOT_NOT_FOUND');
      expect(await code(snapshots.summary(id, db))).toBe('ONEC_STOCK_SNAPSHOT_NOT_FOUND');
      expect(await code(remove(id, 'del-again'))).toBe('ONEC_STOCK_SNAPSHOT_NOT_FOUND');
    }
    expect((await snapshots.list({}, db)).items.map((item) => item.id)).toEqual([reading]);
    expect(await snapshots.get(waiting.id, { includeDeleted: true }, db)).toMatchObject({ status: 'failed', errorCode: 'CANCELLED' });
    expect((await snapshots.get(ready, { includeDeleted: true }, db)).deletedAt).not.toBeNull();
    expect((await pool.query(`SELECT count(*)::int n FROM onec_stock_snapshot_rows WHERE snapshot_id = $1`, [ready])).rows[0].n).toBe(0);
    expect(await events(ready)).toEqual(['onec.stock_snapshot.requested', 'onec.stock_snapshot.ready', 'onec.stock_snapshot.deleted']);
    expect(await events(waiting.id)).toEqual(['onec.stock_snapshot.requested', 'onec.stock_snapshot.failed', 'onec.stock_snapshot.deleted']);
    const deleted = (await pool.query(`SELECT a.username, l.actor_kind, a.after_json->>'rowsRemoved' AS rows FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id
      WHERE a.event = 'onec.stock_snapshot.deleted' AND a.entity_id = $1`, [String(ready)])).rows;
    expect(deleted).toEqual([{ username: 'E2E-Тест', actor_kind: 'user', rows: '2' }]);
    expect((await pool.query(`SELECT DISTINCT status_field, status_code FROM audit_log WHERE event = 'onec.stock_snapshot.deleted'`)).rows).toEqual([{ status_field: 'status', status_code: 'deleted' }]);
    // The cancelled request never starts.
    await agentReads([stockRow('r1', W1, I1, 1)]);
    await settle();
    expect((await slot()).state).toBe('disabling');
  });

  it('reading runs inside the caller\'s REPEATABLE READ READ ONLY transaction and sees one picture', async () => {
    const id = await toSyncing();
    await agentReads([stockRow('r1', W1, I1, 1)]);
    await settle();
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const tx = { query: (text: string, params: unknown[] = []) => client.query(text, params) } as never;
      const before = await snapshots.get(id, {}, tx);
      // Deleted meanwhile by another connection: the transaction still reads its picture, consistently.
      await remove(id, 'del-concurrent');
      expect(await snapshots.get(id, {}, tx)).toEqual(before);
      expect((await snapshots.rows(id, {}, tx)).length).toBe(1);
      expect((await snapshots.summary(id, tx))[0]).toMatchObject({ warehouseRefKey: W1, rows: 1 });
      expect((await snapshots.list({}, tx)).total).toBe(1);
      expect((await snapshots.capabilities(1, tx)).readAvailable).toBe(true);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await code(snapshots.get(id, {}, db))).toBe('ONEC_STOCK_SNAPSHOT_NOT_FOUND');
  });

  // ---------------------------------------------------------------- concurrency

  it('copying, an operator publication and a late STALE completion that writes an incident run together without a deadlock', async () => {
    for (let round = 0; round < 3; round += 1) {
      await heartbeat();
      const id = await toSyncing(`2026-09-2${round}T00:00:00`);
      const command = await lease();
      const runId = randomUUID();
      await upload(runId, [stockRow('r1', W1, I1, round + 1)]);
      await answer(command.commandId, runId);
      // A run of the set read EARLIER than ours (its snapshot time is older) completes late: STALE, an incident is written.
      const stale = randomUUID();
      await upload(stale, [stockRow('s1', W1, I1, 666)]);
      await completeRun(runId, 1);
      const view = await admin.getConfiguration('agent-a');
      const { sourceGeneration: _generation, ...base } = view.published!.configuration as Record<string, unknown>;
      const revision = Number((await pool.query(`SELECT revision FROM onec_agent_config_drafts WHERE agent_id = 'agent-a'`)).rows[0].revision);
      const draft = await admin.saveDraft('agent-a', String(revision), { configuration: { ...base, etlIntervalMinutes: 20 + round } }, operator, ctx(`c-d-${round}`));
      const results = await Promise.allSettled([
        snapshots.advance(1, T0),
        admin.publish('agent-a', { revision: draft.revision, configHash: draft.configHash }, operator, ctx(`c-p-${round}`)),
        completeRun(stale, 1, { snapshotAtUtc: '2020-01-01T00:00:00.000Z' }, 'incremental'),
        // The agent reconnects at the same moment: a session start locks the agent, then the source.
        protocol.startSession(agent, { agentId: 'agent-a', siteId: 's', agentVersion: '1.3.11', capabilities: [],
          sourceIdentity: { databaseId: DB_ID, exportEpoch: EPOCH, environment: 'test' } }),
      ]);
      expect(results.map((result) => (result.status === 'rejected' ? String(result.reason) : 'ok'))).toEqual(['ok', 'ok', 'ok', 'ok']);
      await settle();
      // Our rows, never the stale ones.
      expect(await snapshots.get(id, {}, db)).toMatchObject({ status: 'ready', rowsCount: 1 });
      expect((await snapshots.rows(id, {}, db))[0]!.quantity).toBe(round + 1);
      expect(await publishedSet()).not.toBeNull();
      await agentIdle();
    }
  });

  it('copying holds the agent and the source first: with a late completion holding the entity state and a session start in between, nobody waits in a circle', async () => {
    const id = await toSyncing();
    const command = await lease();
    const runId = randomUUID();
    await upload(runId, [stockRow('r1', W1, I1, 5)]);
    await answer(command.commandId, runId);
    await completeRun(runId, 1);
    const stale = randomUUID();
    await upload(stale, [stockRow('s1', W1, I1, 666)]);
    // A controlled order: (1) a foreign transaction holds the entity state as a late completion would;
    // (2) the copy step starts and waits for it; (3) the agent's session start arrives; (4) the holder goes on to
    // write its incident (KEY SHARE on the agent) and commits.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM onec_etl_entity_state WHERE source_id = 1 AND entity_code = $1 FOR UPDATE`, [SET]);
      const copying = snapshots.advance(1, T0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const starting = protocol.startSession(agent, { agentId: 'agent-a', siteId: 's', agentVersion: '1.3.11', capabilities: [],
        sourceIdentity: { databaseId: DB_ID, exportEpoch: EPOCH, environment: 'test' } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query(`INSERT INTO onec_agent_incidents (agent_id, kind, details, dedupe_key) VALUES ('agent-a', 'e2e_late_completion', '{}'::jsonb, $1)`, [`e2e-${randomUUID()}`]);
      await holder.query('COMMIT');
      const settled = await Promise.allSettled([copying, starting]);
      expect(settled.map((result) => (result.status === 'rejected' ? String(result.reason) : 'ok'))).toEqual(['ok', 'ok']);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    await settle();
    expect(await snapshots.get(id, {}, db)).toMatchObject({ status: 'ready', rowsCount: 1 });
    expect((await snapshots.rows(id, {}, db))[0]!.quantity).toBe(5);
  });

  /** Lets the slot go idle between rounds. */
  const agentIdle = async () => {
    await settle();
    await heartbeat();
    await settle();
  };
});
