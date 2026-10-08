import { sha256Base64 } from './canonical-json/canonical-json';
import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
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
import { OnecAdminService } from './application/onec-admin.service';
import { OnecAgentProtocolService } from './application/onec-agent-protocol.service';
import { OnecAlertProjector } from './application/onec-alert-projector';
import { OnecAuditWriter, type OnecAgentContext } from './application/onec-audit';
import type { RateLimitService } from '../../rate-limit/rate-limit.service';
import { OnecEtlRevocationService } from './application/onec-etl-revocation.service';
import { OnecMonitorService } from './application/onec-monitor.service';
import { OnecAgentAuthGuard } from './http/onec-agent-auth.guard';
import { OnecAgentController } from './http/onec-agent.controller';
import type { OnecRuntimeConfig, OnecRuntimeConfigService } from './onec-runtime-config.service';
import { PgOnecStockSnapshotStore } from './adapters/pg-onec-stock-snapshot-store';

const suite = process.env.ONEC_AGENT_DOCKER_TEST === 'true' ? describe : describe.skip;

const ctx = (requestId: string, correlationId: string | null = null) => ({ requestId, correlationId });
const actor: CurrentUser = { id: '1', username: 'E2E-Тест', role: 'admin', roleId: 1, permissions: ['onec.manage'] };
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const PEM_A = fixture('test-agent-a.cert.pem');
const PEM_B = fixture('test-agent-b.cert.pem');
const header = (pem: string) => encodeURIComponent(new X509Certificate(pem).raw.toString('base64'));
const SECRET = 'e2e-ingress-secret-0123456789abcdef-0123';
const AGENT_PORT = 3901;

const runtimeConfig: OnecRuntimeConfig = {
  enabled: true,
  agentPort: AGENT_PORT,
  ingressSecrets: [SECRET],
  clientCertHeader: 'x-forwarded-tls-client-cert',
  sessionTtlMs: 600000,
  heartbeatIntervalMs: 60000,
  monitorOwner: 'none',
  monitorIntervalMs: 60000,
};
const runtime = { get: () => runtimeConfig, requireEnabled: () => undefined } as unknown as OnecRuntimeConfigService;

const entity = {
  entityCode: 'items',
  oDataPath: 'Catalog_Номенклатура',
  keyField: 'Ref_Key',
  updatedAtField: null,
  deletedField: 'DeletionMark',
  select: ['Ref_Key', 'Description', 'DeletionMark'],
  syncMode: 'full',
  pageSize: 500,
  overlapMinutes: 0,
};

suite('1C agent E1 — isolated PostgreSQL', () => {
  const schema = `e2e_onec_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let db: DatabaseService;
  let repo: PgOnecRepository;
  let admin: OnecAdminService;
  let protocol: OnecAgentProtocolService;
  let monitor: OnecMonitorService;
  let guard: OnecAgentAuthGuard;

  beforeAll(async () => {
    const [container] = JSON.parse(execFileSync('docker', ['inspect', 'erp_test-postgresdb-1'], { encoding: 'utf8' }));
    const env = Object.fromEntries(container.Config.Env.map((entry: string) => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
    const network = Object.values(container.NetworkSettings.Networks)[0] as { IPAddress: string };
    const url = new URL(`postgresql://${network.IPAddress}:5432/${env.POSTGRES_DB ?? 'erpdb'}`);
    url.username = env.POSTGRES_USER;
    url.password = env.POSTGRES_PASSWORD;
    url.searchParams.set('options', `-c search_path=${schema},pg_catalog -c jit=off -c lock_timeout=5000`);
    pool = new Pool({ connectionString: url.toString(), max: 4, statement_timeout: 10000 });
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
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 10000, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 4, DATABASE_SSL: false };
    db = new DatabaseService(
      { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService,
    );
    repo = new PgOnecRepository(db);
    const audit = new OnecAuditWriter(repo);
    const etlRepo = new PgOnecEtlRepository(db);
    admin = new OnecAdminService(repo, audit, runtime, etlRepo, new OnecEtlRevocationService(etlRepo, runtime), new PgOnecStockSnapshotStore(repo, audit));
    protocol = new OnecAgentProtocolService(repo, audit);
    monitor = new OnecMonitorService(runtime, repo, db, new OnecAlertProjector(repo), new PgOnecCommandRepository(db), etlRepo, new OnecAuditWriter(repo), new OnecEtlRevocationService(etlRepo, runtime));
    const rateLimit = { assertAllowed: async () => undefined, refund: async () => undefined } as unknown as RateLimitService;
    guard = new OnecAgentAuthGuard(new Reflector(), runtime, repo, rateLimit);
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
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE onec_alerts, onec_outbox_events, onec_audit_links, onec_agent_incidents,
      onec_agent_config_drafts, onec_agent_status_history, onec_agent_status, onec_agent_sessions,
      onec_agent_certificates, onec_agents, onec_sources RESTART IDENTITY CASCADE;
      ALTER TABLE onec_agent_config_versions DISABLE TRIGGER onec_agent_config_version_immutable;
      DELETE FROM onec_agent_config_versions;
      ALTER TABLE onec_agent_config_versions ENABLE TRIGGER onec_agent_config_version_immutable;
      DELETE FROM audit_log_related_entity; DELETE FROM audit_log;`);
  });

  async function registerAgent(agentId = 'agent-a', pem = PEM_A, code = 'main') {
    const source = await admin.createSource({ code, displayName: `Тест ${code}` }, actor, ctx('e2e-src'));
    const agent = await admin.createAgent({ agentId, sourceId: source.sourceId, siteId: 'e2e-site', displayName: `E2E ${agentId}`, minimumAgentVersion: '1.2' }, actor, ctx('e2e-agent'));
    const cert = await admin.addCertificate(agentId, { pem }, actor, ctx('e2e-cert'));
    return { source, agent, cert };
  }

  function context(request: Record<string, unknown>, handler: 'startSession' | 'heartbeat' = 'startSession') {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => OnecAgentController.prototype[handler],
      getClass: () => OnecAgentController,
    } as never;
  }

  function agentRequest(overrides: Record<string, string | undefined> = {}, port = AGENT_PORT) {
    return {
      socket: { localPort: port },
      headers: {
        'x-onec-ingress-auth': SECRET,
        'x-forwarded-tls-client-cert': header(PEM_A),
        'x-agent-id': 'agent-a',
        'x-request-id': randomUUID(),
        'x-correlation-id': randomUUID(),
        ...overrides,
      },
    } as Record<string, unknown> & { onecAgent?: OnecAgentContext };
  }

  async function authenticate(request: ReturnType<typeof agentRequest>, handler: 'startSession' | 'heartbeat' = 'startSession') {
    await guard.canActivate(context(request, handler));
    return request.onecAgent!;
  }

  const statusOf = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return 200;
    } catch (error) {
      if (error instanceof ApiError) return `${error.statusCode} ${error.code}`;
      throw error;
    }
  };

  // ------------------------------------------------------------------ auth

  it('authenticates only via agent port + ingress secret + registered cert matching X-Agent-Id', async () => {
    await registerAgent();
    await registerAgent('agent-b', PEM_B, 'second');
    expect(await statusOf(() => guard.canActivate(context(agentRequest({}, 3000))))).toBe('404 NOT_FOUND');
    expect(await statusOf(() => guard.canActivate(context(agentRequest({ 'x-onec-ingress-auth': undefined }))))).toBe('403 FORBIDDEN');
    expect(await statusOf(() => guard.canActivate(context(agentRequest({ 'x-onec-ingress-auth': `${SECRET}x` }))))).toBe('403 FORBIDDEN');
    expect(await statusOf(() => guard.canActivate(context(agentRequest({ 'x-forwarded-tls-client-cert': undefined }))))).toBe('403 CERT_REQUIRED');
    // Agent A's certificate cannot act as agent B (cross-agent isolation).
    expect(await statusOf(() => guard.canActivate(context(agentRequest({ 'x-agent-id': 'agent-b' }))))).toBe('403 AGENT_CERT_MISMATCH');
    for (const forged of ['x1', 'x2', 'x3']) {
      expect(await statusOf(() => guard.canActivate(context(agentRequest({ 'x-agent-id': forged }))))).toBe('403 AGENT_CERT_MISMATCH');
    }
    const ok = agentRequest();
    await guard.canActivate(context(ok));
    expect(ok.onecAgent).toMatchObject({ agentId: 'agent-a' });
    const mismatch = await pool.query(`SELECT count(*)::int AS rows, sum(occurrences)::int AS hits FROM onec_agent_incidents WHERE kind = 'agent_cert_mismatch'`);
    expect(mismatch.rows[0]).toEqual({ rows: 1, hits: 4 });
    const incidents = await pool.query(`SELECT kind FROM onec_agent_incidents ORDER BY kind`);
    expect(incidents.rows.map((row) => row.kind)).toEqual(['agent_cert_mismatch', 'cert_required', 'ingress_auth_failed']);
    // Two forged-secret requests aggregate into one incident; audit is throttled per reason+identity.
    const ingress = await pool.query(`SELECT occurrences FROM onec_agent_incidents WHERE kind = 'ingress_auth_failed'`);
    expect(ingress.rows[0].occurrences).toBe(2);
    const denied = await pool.query(
      `SELECT a.metadata_json->>'reason' AS reason, l.actor_kind, l.agent_id, l.cert_id IS NOT NULL AS has_cert
         FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id WHERE a.event = 'onec.auth.denied' ORDER BY 1`,
    );
    expect(denied.rows).toEqual([
      { reason: 'agent_cert_mismatch', actor_kind: 'onec_agent', agent_id: 'agent-a', has_cert: true },
      { reason: 'cert_required', actor_kind: 'system', agent_id: null, has_cert: false },
      { reason: 'ingress_auth_failed', actor_kind: 'system', agent_id: null, has_cert: false },
    ]);
  });

  it('refuses revoked certificates and blocked agents except heartbeat', async () => {
    const { agent, cert } = await registerAgent();
    await admin.setAgentStatus('agent-a', 'blocked', { version: agent.version }, actor, ctx('e2e-block'));
    expect(await statusOf(() => guard.canActivate(context(agentRequest())))).toBe('403 AGENT_BLOCKED');
    expect(await statusOf(() => guard.canActivate(context(agentRequest(), 'heartbeat')))).toBe(200);
    await admin.revokeCertificate('agent-a', cert.certId, actor, ctx('e2e-revoke'));
    expect(await statusOf(() => guard.canActivate(context(agentRequest(), 'heartbeat')))).toBe('403 CERT_UNKNOWN');
  });

  it('supports two active certificates for rotation overlap', async () => {
    await registerAgent();
    await admin.addCertificate('agent-a', { pem: PEM_B }, actor, ctx('e2e-cert-2'));
    expect(await statusOf(() => guard.canActivate(context(agentRequest())))).toBe(200);
    expect(await statusOf(() => guard.canActivate(context(agentRequest({ 'x-forwarded-tls-client-cert': header(PEM_B) }))))).toBe(200);
    expect(await statusOf(() => admin.addCertificate('agent-a', { pem: PEM_B }, actor, ctx('dup')))).toBe('409 ONEC_CERTIFICATE_TAKEN');
  });

  // ------------------------------------------------------------------ session / heartbeat / configuration

  it('starts sessions: version floor, maintenance from published mode, body agentId must match', async () => {
    await registerAgent();
    const agent = await authenticate(agentRequest());
    const ok = await protocol.startSession(agent, { agentId: 'agent-a', siteId: 'e2e-site', agentVersion: '1.2.0', capabilities: ['commands.long-poll.v1'] });
    expect(ok).toMatchObject({ accepted: true, minimumAgentVersion: '1.2', configVersion: 0, maintenanceMode: false });
    expect(Math.abs(Date.parse(ok.serverTimeUtc) - Date.now())).toBeLessThan(5000);
    const old = await protocol.startSession(agent, { agentId: 'agent-a', siteId: 'e2e-site', agentVersion: '1.1.9' });
    expect(old.accepted).toBe(false);
    expect(await statusOf(() => protocol.startSession(agent, { agentId: 'agent-b', siteId: 's', agentVersion: '1.2.0' }))).toBe('400 AGENT_ID_MISMATCH');

    const draft = await admin.saveDraft('agent-a', undefined, { configuration: { mode: 'Maintenance', commandTypes: [], etlIntervalMinutes: 60, etlEntities: [] } }, actor, ctx('e2e-draft'));
    const published = await admin.publish('agent-a', { revision: draft.revision, configHash: draft.configHash }, actor, ctx('e2e-pub'));
    const maintenance = await protocol.startSession(agent, { agentId: 'agent-a', siteId: 'e2e-site', agentVersion: '1.2.0' });
    expect(maintenance).toMatchObject({ maintenanceMode: true, configVersion: published.configVersion });
  });

  it('serves configuration verbatim with 304 for the current version', async () => {
    await registerAgent();
    const agent = await authenticate(agentRequest());
    expect(await protocol.configuration(agent, '0')).toEqual({ notModified: true });
    const draft = await admin.saveDraft('agent-a', undefined, { configuration: { mode: 'Normal', commandTypes: ['integration_probe'], etlIntervalMinutes: 30, etlEntities: [entity] } }, actor, ctx('e2e-draft'));
    const published = await admin.publish('agent-a', { revision: draft.revision, configHash: draft.configHash }, actor, ctx('e2e-pub'));
    const full = await protocol.configuration(agent, '0');
    expect(full.notModified).toBe(false);
    if (!full.notModified) {
      const body = JSON.parse(full.body);
      expect(body.configVersion).toBe(published.configVersion);
      // Published = draft + the source generation token (plan §3.2); the hash covers what the agent receives.
      expect(body.configHash).toBe(published.configHash);
      expect(body.configHash).not.toBe(draft.configHash);
      const generationRef = (await pool.query(`SELECT generation_ref FROM onec_sources WHERE source_id = $1`, [agent.sourceId])).rows[0].generation_ref;
      expect(body.configuration.sourceGeneration).toBe(generationRef);
      expect(full.body).toContain('"configuration":{"commandTypes":["integration_probe"]');
      expect(sha256Base64(full.body.slice(full.body.indexOf('"configuration":') + 16, -1))).toBe(published.configHash);
    }
    expect(await protocol.configuration(agent, String(published.configVersion))).toEqual({ notModified: true });
    expect(await statusOf(() => protocol.configuration(agent, '-1'))).toBe('400 INVALID_REQUEST');
  });

  it('records heartbeats: whitelisted status, history on change, state event, blocked agents allowed', async () => {
    await registerAgent();
    const agent = await authenticate(agentRequest(), 'heartbeat');
    const beat = (state: string, extra: Record<string, unknown> = {}) =>
      protocol.heartbeat({ ...agent, requestId: randomUUID() }, { agentId: 'agent-a', version: '1.2.0', state, uptimeSeconds: 10, queues: { commandsPending: 1 }, secret: 'drop-me', ...extra });
    await beat('healthy');
    await beat('healthy');
    await beat('degraded', { stateReason: 'CLOCK_DRIFT' });
    const status = await pool.query(`SELECT state, state_reason, heartbeat FROM onec_agent_status WHERE agent_id = 'agent-a'`);
    expect(status.rows[0]).toMatchObject({ state: 'degraded', state_reason: 'CLOCK_DRIFT' });
    expect(status.rows[0].heartbeat).not.toHaveProperty('secret');
    const history = await pool.query(`SELECT state FROM onec_agent_status_history ORDER BY history_id`);
    expect(history.rows.map((row) => row.state)).toEqual(['healthy', 'degraded']);
    const events = await pool.query(`SELECT event_type FROM onec_outbox_events ORDER BY event_id`);
    expect(events.rows.map((row) => row.event_type)).toEqual(['onec.agent.state_changed', 'onec.agent.state_changed']);
    expect(await statusOf(() => protocol.heartbeat(agent, { agentId: 'agent-a', version: '1', state: 'exploded' }))).toBe('400 INVALID_REQUEST');
  });

  it('binds source identity once and flags a changed database with incident, audit link and alert', async () => {
    const { source } = await registerAgent();
    const agent = await authenticate(agentRequest());
    const identity = { databaseId: 'db-1', exportEpoch: 'e-1', environment: 'test' };
    const start = (sourceIdentity: typeof identity) =>
      protocol.startSession(agent, { agentId: 'agent-a', siteId: 'e2e-site', agentVersion: '1.2.0', sourceIdentity });
    expect((await start(identity)).accepted).toBe(true);
    expect((await start(identity)).accepted).toBe(true);
    expect((await start({ ...identity, exportEpoch: 'e-2' })).accepted).toBe(false);
    const row = await pool.query(`SELECT identity_status, identity FROM onec_sources WHERE source_id = $1`, [source.sourceId]);
    expect(row.rows[0]).toMatchObject({ identity_status: 'identity_changed', identity });
    const links = await pool.query(
      `SELECT a.event, l.actor_kind, l.agent_id, l.source_id FROM onec_audit_links l JOIN audit_log a ON a.audit_id = l.audit_id
        WHERE l.actor_kind = 'onec_agent' ORDER BY a.event`,
    );
    expect(links.rows).toEqual([
      { event: 'onec.source.identity_bound', actor_kind: 'onec_agent', agent_id: 'agent-a', source_id: String(source.sourceId) },
      { event: 'onec.source.identity_changed', actor_kind: 'onec_agent', agent_id: 'agent-a', source_id: String(source.sourceId) },
    ]);
    await monitor.relayOutbox();
    const alerts = await pool.query(`SELECT kind, severity FROM onec_alerts`);
    expect(alerts.rows).toEqual([{ kind: 'source_identity_changed', severity: 'critical' }]);
  });

  // ------------------------------------------------------------------ configuration admin

  it('protects the draft against stale writes and publishes only the confirmed revision', async () => {
    await registerAgent();
    const config = (minutes: number) => ({ configuration: { mode: 'Normal', commandTypes: [], etlIntervalMinutes: minutes, etlEntities: [] } });
    const first = await admin.saveDraft('agent-a', undefined, config(10), actor, ctx('r1'));
    expect(await statusOf(() => admin.saveDraft('agent-a', undefined, config(11), actor, ctx('r1b')))).toBe('409 STALE_DRAFT');
    const second = await admin.saveDraft('agent-a', `"${first.revision}"`, config(20), actor, ctx('r2'));
    expect(await statusOf(() => admin.saveDraft('agent-a', String(first.revision), config(30), actor, ctx('r3')))).toBe('409 STALE_DRAFT');
    expect(await statusOf(() => admin.publish('agent-a', { revision: first.revision, configHash: first.configHash }, actor, ctx('p0')))).toBe('409 STALE_DRAFT');
    expect(await statusOf(() => admin.saveDraft('agent-a', String(second.revision), { configuration: { mode: 'Normal' } }, actor, ctx('bad')))).toBe('422 ONEC_CONFIG_INVALID');
    const one = await admin.publish('agent-a', { revision: second.revision, configHash: second.configHash }, actor, ctx('p1'));
    expect(one.configVersion).toBeGreaterThanOrEqual(Date.now() - 60000);
    expect(await statusOf(() => admin.publish('agent-a', { revision: second.revision, configHash: second.configHash }, actor, ctx('p1b')))).toBe('409 ONEC_CONFIG_UNCHANGED');
    // Agent reports a version above everything ERP has (e.g. after a DB restore).
    await pool.query(`INSERT INTO onec_agent_status (agent_id, received_at, state, active_config_version) VALUES ('agent-a', now(), 'healthy', $1)`, [one.configVersion + 10_000_000]);
    const third = await admin.saveDraft('agent-a', String(second.revision), config(40), actor, ctx('r4'));
    const two = await admin.publish('agent-a', { revision: third.revision, configHash: third.configHash }, actor, ctx('p2'));
    expect(two.configVersion).toBe(one.configVersion + 10_000_001);
    const versions = await admin.listConfigVersions('agent-a');
    expect(versions.map((v) => v.status)).toEqual(['published', 'superseded']);
    await expect(pool.query(`UPDATE onec_agent_config_versions SET config_hash = 'x'`)).rejects.toThrow(/only published -> superseded/);
    await expect(pool.query(`DELETE FROM onec_agent_config_versions`)).rejects.toThrow(/immutable/);
  });

  it('the service set of stock snapshots: the operator neither sees nor edits it, and every published version takes it from the slot', async () => {
    await registerAgent();
    const sourceId = Number((await pool.query(`SELECT source_id FROM onec_agents WHERE agent_id = 'agent-a'`)).rows[0].source_id);
    const entity = { entityCode: 'items', oDataPath: 'Catalog_Номенклатура', keyField: 'Ref_Key', select: ['Ref_Key'], syncMode: 'incremental', pageSize: 100, overlapMinutes: 0 };
    const config = (minutes: number, entities: unknown[] = [entity]) => ({ configuration: { mode: 'Normal', commandTypes: [], etlIntervalMinutes: minutes, etlEntities: entities } });
    const publishedEntities = async () => (JSON.parse((await pool.query(
      `SELECT configuration_canonical FROM onec_agent_config_versions WHERE agent_id = 'agent-a' AND status = 'published'`)).rows[0].configuration_canonical)
      .etlEntities as Array<{ entityCode: string; enabled?: boolean; oDataPath: string }>).map((item) => [item.entityCode, item.enabled ?? null, item.oDataPath]);
    const PATH = (period: string) => `AccumulationRegister_ЗапасыНаСкладах/Balance(Period=datetime'${period}',Dimensions='Организация,Номенклатура,Характеристика,Партия,СтруктурнаяЕдиница,Ячейка')`;

    // No slot yet: nothing is added; an operator document with the reserved code is refused.
    const first = await admin.saveDraft('agent-a', undefined, config(10), actor, ctx('m1'));
    await admin.publish('agent-a', { revision: first.revision, configHash: first.configHash }, actor, ctx('m2'));
    expect(await publishedEntities()).toEqual([['items', null, 'Catalog_Номенклатура']]);
    const reserved = { ...entity, entityCode: 'stock_balances_at' };
    expect(await statusOf(() => admin.saveDraft('agent-a', String(first.revision), config(11, [entity, reserved]), actor, ctx('m3')))).toBe('422 ONEC_CONFIG_INVALID');
    expect(admin.validateConfiguration(config(11, [reserved]))).toMatchObject({ ok: false, issues: [{ path: 'etlEntities.0.entityCode' }] });

    // The slot is switched on for a snapshot: the service publication changes only the managed set, the author is the system.
    const snapshotId = Number((await pool.query(
      `INSERT INTO onec_stock_snapshots (source_id, agent_id, generation_ref, source_generation, moment_local, moment_utc, time_zone, idempotency_key, request_id, correlation_id)
       SELECT $1, 'agent-a', generation_ref, generation, '2026-09-26 10:14:00', '2026-09-26 05:14:00+00', 'Asia/Almaty', 'e2e-slot-1', 'req-s', 'corr-s' FROM onec_sources WHERE source_id = $1
       RETURNING snapshot_id`, [sourceId])).rows[0].snapshot_id);
    await pool.query(`INSERT INTO onec_stock_snapshot_slot (source_id, state, period_local, owner_snapshot_id) VALUES ($1, 'active', '2026-09-26 10:14:00', $2)`, [sourceId, snapshotId]);
    const enable = { requestId: 'req-s', correlationId: 'corr-s', snapshotId, requestedByUserId: 1, action: 'enable' as const };
    const on = await db.transaction((tx) => admin.publishManaged(tx, 'agent-a', enable));
    expect(on.changed).toBe(true);
    expect(await publishedEntities()).toEqual([['items', null, 'Catalog_Номенклатура'], ['stock_balances_at', true, PATH('2026-09-26T10:14:00')]]);
    // The same state again (a step repeated after a restart): the published version is returned, nothing is written.
    expect(await db.transaction((tx) => admin.publishManaged(tx, 'agent-a', enable))).toEqual({ configVersion: on.configVersion, configHash: on.configHash, changed: false });
    const version = (await pool.query(`SELECT published_by, published_from_revision FROM onec_agent_config_versions WHERE agent_id = 'agent-a' AND config_version = $1`, [on.configVersion])).rows[0];
    expect(version).toEqual({ published_by: null, published_from_revision: '0' });
    const audit = (await pool.query(
      `SELECT a.username, a.user_id, a.related_user_id::text AS initiator, a.after_json->>'reason' AS reason, a.after_json->>'action' AS action, l.actor_kind, l.correlation_id,
              (SELECT entity_id::text FROM audit_log_related_entity r WHERE r.audit_id = a.audit_id AND r.entity_type = 'onec_stock_snapshot') AS snapshot
         FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id WHERE a.event = 'onec.config.published' ORDER BY a.created_at DESC LIMIT 1`)).rows[0];
    expect(audit).toEqual({ username: 'onec_stock_snapshots', user_id: null, initiator: '1', reason: 'stock_snapshot', action: 'enable', actor_kind: 'system', correlation_id: 'corr-s', snapshot: String(snapshotId) });

    // The operator's view is without the set; a draft built from it saves and publishes, and the set stays.
    const view = await admin.getConfiguration('agent-a');
    expect((view.published!.configuration as { etlEntities: Array<{ entityCode: string }> }).etlEntities.map((item) => item.entityCode)).toEqual(['items']);
    expect(view.managedEntities).toEqual([{ entityCode: 'stock_balances_at', enabled: true, oDataPath: PATH('2026-09-26T10:14:00') }]);
    // As the editor does: the published document without the generation token is the base of a draft.
    const { sourceGeneration: _generation, ...operatorBase } = view.published!.configuration as Record<string, unknown>;
    const edited = await admin.saveDraft('agent-a', String(first.revision), { configuration: { ...operatorBase, etlIntervalMinutes: 15 } }, actor, ctx('m4'));
    await admin.publish('agent-a', { revision: edited.revision, configHash: edited.configHash }, actor, ctx('m5'));
    expect(await publishedEntities()).toEqual([['items', null, 'Catalog_Номенклатура'], ['stock_balances_at', true, PATH('2026-09-26T10:14:00')]]);
    // Publishing the same draft again is still «unchanged» for the operator.
    expect(await statusOf(() => admin.publish('agent-a', { revision: edited.revision, configHash: edited.configHash }, actor, ctx('m6')))).toBe('409 ONEC_CONFIG_UNCHANGED');

    // Switched off: the set stays in the configuration with enabled:false and the last period.
    await pool.query(`UPDATE onec_stock_snapshot_slot SET state = 'disabling' WHERE source_id = $1`, [sourceId]);
    const off = await db.transaction((tx) => admin.publishManaged(tx, 'agent-a', { ...enable, action: 'disable' }));
    expect(off.changed).toBe(true);
    expect(await publishedEntities()).toEqual([['items', null, 'Catalog_Номенклатура'], ['stock_balances_at', false, PATH('2026-09-26T10:14:00')]]);
    expect((await admin.getConfiguration('agent-a')).managedEntities).toEqual([{ entityCode: 'stock_balances_at', enabled: false, oDataPath: PATH('2026-09-26T10:14:00') }]);
    // Removed (before a rollback of the backend image): the document has no trace of the set.
    await pool.query(`UPDATE onec_stock_snapshot_slot SET state = 'removed', owner_snapshot_id = NULL WHERE source_id = $1`, [sourceId]);
    await db.transaction((tx) => admin.publishManaged(tx, 'agent-a', { ...enable, action: 'remove' }));
    expect(await publishedEntities()).toEqual([['items', null, 'Catalog_Номенклатура']]);
    expect((await admin.getConfiguration('agent-a')).managedEntities).toEqual([]);
    // A blocked publication is refused for the service path too.
    await pool.query(`UPDATE onec_agents SET config_publish_blocked = true, config_publish_blocked_at = now()`);
    expect(await statusOf(() => db.transaction((tx) => admin.publishManaged(tx, 'agent-a', enable)))).toBe('409 ONEC_CONFIG_PUBLISH_BLOCKED');
  });

  it('blocks publication after restore until a fresh heartbeat arrives', async () => {
    await registerAgent();
    await pool.query(`UPDATE onec_agents SET config_publish_blocked = true, config_publish_blocked_at = now() - interval '1 second'`);
    const draft = await admin.saveDraft('agent-a', undefined, { configuration: { mode: 'PauseEtl', commandTypes: [], etlIntervalMinutes: 60, etlEntities: [] } }, actor, ctx('d'));
    expect(await statusOf(() => admin.publish('agent-a', { revision: draft.revision, configHash: draft.configHash }, actor, ctx('p')))).toBe('409 ONEC_CONFIG_PUBLISH_BLOCKED');
    const agent = await authenticate(agentRequest(), 'heartbeat');
    await protocol.heartbeat(agent, { agentId: 'agent-a', version: '1.2.0', state: 'healthy', activeConfigVersion: 5 });
    expect(await statusOf(() => admin.publish('agent-a', { revision: draft.revision, configHash: draft.configHash }, actor, ctx('p2')))).toBe(200);
  });

  it('rejects stale agent updates and writes admin audit with normalized links', async () => {
    const { agent } = await registerAgent();
    await admin.updateAgent('agent-a', { version: agent.version, displayName: 'Новое имя' }, actor, ctx('u1', 'corr-u1'));
    const corr = await pool.query(`SELECT request_id, correlation_id FROM onec_audit_links WHERE request_id = 'u1'`);
    expect(corr.rows).toEqual([{ request_id: 'u1', correlation_id: 'corr-u1' }]);
    expect(await statusOf(() => admin.updateAgent('agent-a', { version: agent.version, displayName: 'Ещё' }, actor, ctx('u2')))).toBe('409 ONEC_AGENT_STALE');
    const rows = await pool.query(
      `SELECT a.event, a.user_id, a.source, l.actor_kind, l.agent_id, l.cert_id, l.request_id
         FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id ORDER BY a.created_at, a.event`,
    );
    expect(rows.rows.map((row) => row.event)).toEqual(['onec.source.created', 'onec.agent.created', 'onec.certificate.added', 'onec.agent.updated']);
    expect(rows.rows.every((row) => row.actor_kind === 'user' && row.source === 'erp_1c_admin' && String(row.user_id) === '1')).toBe(true);
    expect(rows.rows[2]).toMatchObject({ agent_id: 'agent-a', request_id: 'e2e-cert' });
    expect(rows.rows[2].cert_id).not.toBeNull();
  });

  // ------------------------------------------------------------------ monitor & alerts

  it('opens one silent alert per silence period, skips recovered agents and resolves on heartbeat', async () => {
    await registerAgent();
    const now = new Date();
    await monitor.detectSilentAgents(now);
    await monitor.detectSilentAgents(now);
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_outbox_events`)).rows[0].n).toBe(1);
    await monitor.relayOutbox();
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT kind, state FROM onec_alerts`)).rows).toEqual([{ kind: 'agent_silent', state: 'open' }]);
    const agent = await authenticate(agentRequest(), 'heartbeat');
    await protocol.heartbeat(agent, { agentId: 'agent-a', version: '1.2.0', state: 'healthy' });
    expect((await pool.query(`SELECT state FROM onec_alerts WHERE kind = 'agent_silent'`)).rows[0].state).toBe('resolved');
    // An event detected before the heartbeat but relayed after it must not reopen an alert.
    await pool.query(`INSERT INTO onec_outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
      VALUES ('onec.agent.silent', 'onec_agent', 'agent-a', $1::jsonb, 'late')`,
      [JSON.stringify({ envelopeVersion: 1, agentId: 'agent-a', data: { silentSince: new Date(Date.now() - 600000).toISOString() } })]);
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_alerts WHERE state = 'open'`)).rows[0].n).toBe(0);
  });

  it('does not report a silence explained by the expected daily interval; reports it when the interval ends or is cleared', async () => {
    const { agent } = await registerAgent();
    const silentEvents = async () => (await pool.query(
      `SELECT payload_json->'data'->>'silentSince' AS since FROM onec_outbox_events WHERE event_type = 'onec.agent.silent' ORDER BY event_id`)).rows.map((row) => row.since);

    // The setting: validated, stored, audited, returned by the admin API.
    expect(await statusOf(() => admin.updateAgent('agent-a', { version: agent.version, expectedSilenceUtc: '20:00-23:00' }, actor, ctx('es-long')))).toBe('422 VALIDATION_FAILED');
    expect(await statusOf(() => admin.updateAgent('agent-a', { version: agent.version, expectedSilenceUtc: '2345-0025' }, actor, ctx('es-bad')))).toBe('422 VALIDATION_FAILED');
    const updated = await admin.updateAgent('agent-a', { version: agent.version, expectedSilenceUtc: '23:45-00:25' }, actor, ctx('es-set'));
    expect(updated.expectedSilenceUtc).toBe('23:45-00:25');
    expect((await admin.getAgent('agent-a')).expectedSilenceUtc).toBe('23:45-00:25');
    const audit = await pool.query(`SELECT a.before_json, a.after_json FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id WHERE l.request_id = 'es-set'`);
    expect(audit.rows[0].before_json.expectedSilenceUtc).toBeNull();
    expect(audit.rows[0].after_json.expectedSilenceUtc).toBe('23:45-00:25');
    // Another field can be saved without touching the interval.
    const renamed = await admin.updateAgent('agent-a', { version: updated.version, displayName: 'E2E переименован' }, actor, ctx('es-keep'));
    expect(renamed.expectedSilenceUtc).toBe('23:45-00:25');

    // A clean stop at 23:49:33 (the production night of 2026-10-05).
    const session = await authenticate(agentRequest(), 'heartbeat');
    await protocol.heartbeat(session, { agentId: 'agent-a', version: '1.2.0', state: 'healthy' });
    await pool.query(`UPDATE onec_agent_status SET received_at = '2026-10-05T23:49:33Z' WHERE agent_id = 'agent-a'`);
    await monitor.detectSilentAgents(new Date('2026-10-05T23:53:16Z'));
    await monitor.detectSilentAgents(new Date('2026-10-06T00:03:00Z'));
    await monitor.detectSilentAgents(new Date('2026-10-06T00:24:59Z'));
    expect(await silentEvents()).toEqual([]);
    // Still silent when the interval ends: reported once, with the real beginning of the silence.
    await monitor.detectSilentAgents(new Date('2026-10-06T00:25:00Z'));
    await monitor.detectSilentAgents(new Date('2026-10-06T00:26:00Z'));
    expect(await silentEvents()).toEqual(['2026-10-05T23:49:33.000Z']);

    // A silence that began long before the interval is not hidden by it.
    await pool.query(`DELETE FROM onec_outbox_events`);
    await pool.query(`UPDATE onec_agent_status SET received_at = '2026-10-05T20:03:23Z' WHERE agent_id = 'agent-a'`);
    await monitor.detectSilentAgents(new Date('2026-10-05T23:50:00Z'));
    expect(await silentEvents()).toEqual(['2026-10-05T20:03:23.000Z']);

    // Cleared: the same planned stop is reported again.
    await pool.query(`DELETE FROM onec_outbox_events`);
    const cleared = await admin.updateAgent('agent-a', { version: renamed.version, expectedSilenceUtc: null }, actor, ctx('es-clear'));
    expect(cleared.expectedSilenceUtc).toBeNull();
    await pool.query(`UPDATE onec_agent_status SET received_at = '2026-10-05T23:49:33Z' WHERE agent_id = 'agent-a'`);
    await monitor.detectSilentAgents(new Date('2026-10-05T23:53:16Z'));
    expect(await silentEvents()).toEqual(['2026-10-05T23:49:33.000Z']);
  });

  it('projects agent state alerts from the current status: out-of-order retry and replay are no-ops', async () => {
    await registerAgent();
    const agent = await authenticate(agentRequest(), 'heartbeat');
    const beat = (state: string) => protocol.heartbeat({ ...agent, requestId: randomUUID() }, { agentId: 'agent-a', version: '1.2.0', state });
    await beat('healthy');
    await beat('storage_critical');
    // Relay processes both events; the older "healthy" must not close the newer critical alert.
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT kind, state, severity FROM onec_alerts`)).rows).toEqual([{ kind: 'agent_state', state: 'open', severity: 'critical' }]);
    // Replay every event (e.g. a relay crash before markProcessed): still one open alert.
    await pool.query(`UPDATE onec_outbox_events SET status = 'pending', attempts = 0`);
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_alerts WHERE state = 'open'`)).rows[0].n).toBe(1);
    await beat('healthy');
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_alerts WHERE state = 'open'`)).rows[0].n).toBe(0);
    // The same condition returning reopens the alert instead of leaving it resolved.
    await beat('storage_critical');
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT state FROM onec_alerts WHERE kind = 'agent_state'`)).rows).toEqual([{ state: 'open' }]);
    const envelope = (await pool.query(`SELECT payload_json FROM onec_outbox_events ORDER BY event_id DESC LIMIT 1`)).rows[0].payload_json;
    expect(envelope).toMatchObject({ envelopeVersion: 1, eventType: 'onec.agent.state_changed', actor: { kind: 'onec_agent', id: 'agent-a' }, severity: 'critical', subject: { type: 'onec_agent', id: 'agent-a' } });
    expect(envelope.requestId).toBeTruthy();
    expect(envelope.correlationId).toBeTruthy();
  });

  it('serializes a concurrent certificate revoke with the expiry-alert projection (no deadlock)', async () => {
    const { cert } = await registerAgent();
    await pool.query(`UPDATE onec_agent_certificates SET not_after = now() + interval '5 days' WHERE cert_id = $1`, [cert.certId]);
    await monitor.detectExpiringCertificates(new Date());
    // Connection A: the revoke transaction's first step (agent FOR UPDATE), held open.
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query(`SELECT 1 FROM onec_agents WHERE agent_id = 'agent-a' FOR UPDATE`);
      // Connection B: relay/projection must wait on the agent lock, not deadlock.
      const relay = monitor.relayOutbox();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await revoker.query(`UPDATE onec_agent_certificates SET status = 'revoked', revoked_at = now() WHERE cert_id = $1`, [cert.certId]);
      await revoker.query('COMMIT');
      expect(await relay).toBe(1);
    } finally {
      revoker.release();
    }
    // Projection ran after the revoke committed: no alert for a revoked certificate.
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_alerts WHERE kind = 'certificate_expiring'`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT status FROM onec_outbox_events`)).rows).toEqual([{ status: 'processed' }]);
  });

  it('emits certificate expiry events per threshold and keeps unknown events pending for retry', async () => {
    const { cert } = await registerAgent();
    await pool.query(`UPDATE onec_agent_certificates SET not_after = now() + interval '5 days' WHERE cert_id = $1`, [cert.certId]);
    await monitor.detectExpiringCertificates(new Date());
    await monitor.detectExpiringCertificates(new Date());
    const events = await pool.query(`SELECT idempotency_key FROM onec_outbox_events`);
    expect(events.rows.map((row) => row.idempotency_key)).toEqual([`onec.certificate.expiring:${cert.certId}:7`]);
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT kind, severity, cert_id FROM onec_alerts`)).rows).toEqual([
      { kind: 'certificate_expiring', severity: 'critical', cert_id: String(cert.certId) },
    ]);
    // Revoke, then replay the expiry event: the alert stays resolved.
    await admin.revokeCertificate('agent-a', cert.certId, actor, ctx('revoke'));
    await pool.query(`UPDATE onec_outbox_events SET status = 'pending', attempts = 0`);
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT state FROM onec_alerts WHERE kind = 'certificate_expiring'`)).rows).toEqual([{ state: 'resolved' }]);
    await pool.query(`INSERT INTO onec_outbox_events (event_type, aggregate_type, aggregate_id, idempotency_key)
      VALUES ('onec.unknown.event', 'x', '1', 'unknown-1')`);
    await monitor.relayOutbox();
    const unknown = await pool.query(`SELECT status, attempts, last_error FROM onec_outbox_events WHERE idempotency_key = 'unknown-1'`);
    expect(unknown.rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(unknown.rows[0].last_error).toContain('No projector');
  });

  it('heartbeat identity check does not wait for FOR KEY SHARE locks on the source (ETL complete inserting mirror rows)', async () => {
    const { source } = await registerAgent();
    const agent = await authenticate(agentRequest(), 'heartbeat');
    const identity = { databaseId: 'db-1', exportEpoch: 'e-1', environment: 'test' };
    await protocol.startSession(agent, { agentId: 'agent-a', siteId: 'e2e-site', agentVersion: '1.2.0', sourceIdentity: identity });
    // A long transaction that holds FOR KEY SHARE on the source row — what every insert with a foreign key to
    // onec_sources takes (a `complete` publishing mirror rows held it for ~30 s; the heartbeat used FOR UPDATE and timed out).
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM onec_sources WHERE source_id = $1 FOR KEY SHARE', [source.sourceId]);
      const started = Date.now();
      await protocol.heartbeat({ ...agent, requestId: randomUUID() },
        { agentId: 'agent-a', version: '1.2.0', state: 'healthy', sourceIdentity: identity });
      expect(Date.now() - started).toBeLessThan(2000);
      // A FOR UPDATE writer (admin source operations) still waits for the KEY SHARE holder.
      const blocked = pool.query(`SELECT 1 FROM onec_sources WHERE source_id = $1 FOR UPDATE NOWAIT`, [source.sourceId]);
      await expect(blocked).rejects.toThrow(/could not obtain lock/);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const status = await pool.query(`SELECT state FROM onec_agent_status WHERE agent_id = 'agent-a'`);
    expect(status.rows[0].state).toBe('healthy');
  });
});

