import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { OnecEtlRevocationService } from './application/onec-etl-revocation.service';
import { OnecMonitorService } from './application/onec-monitor.service';
import type { OnecRuntimeConfig, OnecRuntimeConfigService } from './onec-runtime-config.service';

const suite = process.env.ONEC_AGENT_DOCKER_TEST === 'true' ? describe : describe.skip;

const actor: CurrentUser = { id: '1', username: 'E2E-Тест', role: 'admin', roleId: 1, permissions: ['onec.commands.send'] };
const ctx = (requestId: string) => ({ requestId, correlationId: null });
const runtimeConfig: OnecRuntimeConfig = {
  enabled: true, agentPort: 3901, ingressSecrets: ['x'.repeat(40)], clientCertHeader: 'x-forwarded-tls-client-cert',
  sessionTtlMs: 600000, heartbeatIntervalMs: 60000, monitorOwner: 'none', monitorIntervalMs: 60000,
};
const runtime = { get: () => runtimeConfig, requireEnabled: () => undefined } as unknown as OnecRuntimeConfigService;
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

suite('1C agent E2 command queue — isolated PostgreSQL', () => {
  const schema = `e2e_onec_cmd_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let db: DatabaseService;
  let repo: PgOnecRepository;
  let commandsRepo: PgOnecCommandRepository;
  let wakeups: OnecCommandWakeups;
  let service: OnecCommandsService;
  let monitor: OnecMonitorService;
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
    pool = new Pool({ connectionString: url.toString(), max: 6, statement_timeout: 15000 });
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE users(user_id bigint PRIMARY KEY, username text); INSERT INTO users VALUES (1, 'E2E-Тест');
      CREATE TABLE roles(role_id bigint, role_code text); INSERT INTO roles VALUES (1, 'admin');
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, domain text, label text, description text, sort_order integer, is_dangerous boolean, is_active boolean, updated_at timestamptz);
      CREATE TABLE role_permissions(role_id bigint, permission_name text, is_enabled boolean, PRIMARY KEY(role_id, permission_name));
      CREATE TABLE permissions_state(id boolean, version integer, updated_at timestamptz); INSERT INTO permissions_state VALUES (true, 1, now());
      CREATE TABLE audit_log(LIKE public.audit_log INCLUDING ALL);
      CREATE TABLE audit_log_related_entity(LIKE public.audit_log_related_entity INCLUDING ALL);`);
    for (const file of ['193_onec_agent_foundation.sql', '196_onec_agent_commands.sql']) {
      await pool.query(readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 15000, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 6, DATABASE_SSL: false };
    db = new DatabaseService(
      { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService,
    );
    repo = new PgOnecRepository(db);
    commandsRepo = new PgOnecCommandRepository(db);
    // No LISTEN here (module init not called): wakes come from the in-process path.
    wakeups = new OnecCommandWakeups(db, runtime);
    service = new OnecCommandsService(commandsRepo, repo, new OnecAuditWriter(repo), wakeups, runtime, new PgOnecEtlRepository(db));
    monitor = new OnecMonitorService(runtime, repo, db, new OnecAlertProjector(repo), commandsRepo, new PgOnecEtlRepository(db), new OnecAuditWriter(repo), new OnecEtlRevocationService(new PgOnecEtlRepository(db), runtime));
  }, 60000);

  afterAll(async () => {
    await wakeups?.onModuleDestroy();
    await db?.onModuleDestroy();
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });

  let sessionA = '';
  beforeEach(async () => {
    await pool.query(`TRUNCATE onec_agent_commands, onec_alerts, onec_outbox_events, onec_audit_links, onec_agent_incidents,
      onec_agent_sessions, onec_agent_certificates, onec_agents, onec_sources RESTART IDENTITY CASCADE;
      DELETE FROM audit_log_related_entity; DELETE FROM audit_log;
      INSERT INTO onec_sources (code, display_name) VALUES ('a', 'Тест A'), ('b', 'Тест B');
      INSERT INTO onec_agents (agent_id, source_id, site_id, display_name) VALUES ('agent-a', 1, 's', 'E2E A'), ('agent-b', 2, 's', 'E2E B');
      INSERT INTO onec_agent_config_versions (agent_id, config_version, status, configuration_canonical, config_hash, published_from_revision)
        VALUES ('agent-a', 1, 'published', '{"commandTypes":["integration_probe"]}', 'h', 1);`);
    sessionA = (await pool.query(`INSERT INTO onec_agent_sessions (agent_id, agent_version, accepted) VALUES ('agent-a', '1.0.0', true) RETURNING session_id`)).rows[0].session_id;
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
  const enqueue = (overrides: Record<string, unknown> = {}, key = randomUUID()) =>
    commandsRepo.transaction((tx) =>
      service.enqueue(tx, { agentId: 'agent-a', commandType: 'integration_probe', payload: { marker: 'E2E-Тест' }, sourceModule: 'e2e', idempotencyKey: key, ...overrides }),
    );
  const lease = (body: Record<string, unknown> = {}, agent = agentA) =>
    service.lease(agent, { sessionId: sessionA, supportedCommandTypes: ['integration_probe', 'start_full_sync'], maxWaitSeconds: 1, ...body }, new AbortController().signal);

  it('enqueue is idempotent per (sourceModule, key) and rejects a different intent under the same key', async () => {
    const key = 'e2e-key-123456';
    const first = await enqueue({}, key);
    const again = await enqueue({}, key);
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, command: { commandId: first.command.commandId } });
    expect(await status(() => enqueue({ payload: { marker: 'другое' } }, key))).toBe('409 ONEC_COMMAND_IDEMPOTENCY_CONFLICT');
    expect(first.command.payloadCanonical).toBe('{"marker":"E2E-\\u0422\\u0435\\u0441\\u0442"}');
  });

  it('enforces the agent payload policy and known types', async () => {
    expect(await status(() => enqueue({ commandType: 'drop_everything' }))).toBe('422 ONEC_COMMAND_TYPE_UNKNOWN');
    expect(await status(() => enqueue({ payload: { big: 'x'.repeat(61441) } }))).toBe('422 PAYLOAD_TOO_LARGE');
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 31; i += 1) deep = { d: deep };
    expect(await status(() => enqueue({ payload: deep }))).toBe('422 INVALID_PAYLOAD');
    expect(await status(() => enqueue({ payload: { price: 1.5 } }))).toBe('422 INVALID_PAYLOAD');
    expect(await status(() => enqueue({ expiresAtUtc: new Date(Date.now() - 1000).toISOString() }))).toBe('422 ONEC_COMMAND_ALREADY_EXPIRED');
  });

  it('lease: session checks, empty long poll, supported types, notBefore/expiresAt, priority, ordering key, capacity', async () => {
    expect(await status(() => lease({ sessionId: randomUUID() }))).toBe('409 SESSION_EXPIRED');
    const started = Date.now();
    expect(await lease()).toEqual({ hasCommand: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    const later = await enqueue({ notBeforeUtc: new Date(Date.now() + 3600_000).toISOString() });
    const low = await enqueue({ priority: 0, orderingKey: 'order-1' });
    const lowNext = await enqueue({ priority: 100, orderingKey: 'order-1' });
    const high = await enqueue({ priority: 50 });
    const other = await enqueue({ commandType: 'reload_entity', payload: { entity: 'items' } });
    expect(await lease({ currentLoad: { executing: 1, capacity: 1 } })).toEqual({ hasCommand: false });
    const first = await lease();
    // lowNext has the highest priority but waits for its ordering-key predecessor.
    expect(first.command).toMatchObject({ commandId: high.command.commandId });
    const second = await lease();
    expect(second.command).toMatchObject({ commandId: low.command.commandId });
    // lowNext stays blocked while its predecessor is only leased (not received).
    expect(await lease()).toEqual({ hasCommand: false });
    await service.received(agentA, low.command.commandId, { leaseId: second.leaseId, payloadHash: low.command.payloadHash });
    expect((await lease()).command).toMatchObject({ commandId: lowNext.command.commandId });
    // Unsupported type and future notBefore are never issued.
    expect(await lease()).toEqual({ hasCommand: false });
    expect([later.command.status, other.command.commandType]).toEqual(['queued', 'reload_entity']);
  });

  it('two concurrent leases never issue the same command', async () => {
    await enqueue();
    const [a, b] = await Promise.all([commandsRepo.leaseNext('agent-a', ['integration_probe'], 60), commandsRepo.leaseNext('agent-a', ['integration_probe'], 60)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('re-issues the same command after the lease expires; received is idempotent; hash mismatch is 409 + incident', async () => {
    const queued = await enqueue();
    const first = await lease();
    await pool.query(`UPDATE onec_agent_commands SET lease_expires_at = now() - interval '1 second'`);
    const again = await lease();
    expect(again.command).toMatchObject({ commandId: queued.command.commandId, leaseCount: 2, payloadHash: queued.command.payloadHash });
    expect(again.leaseId).not.toBe(first.leaseId);
    await service.received(agentA, queued.command.commandId, { leaseId: first.leaseId, payloadHash: queued.command.payloadHash });
    await service.received(agentA, queued.command.commandId, { leaseId: again.leaseId, payloadHash: queued.command.payloadHash });
    expect(await lease()).toEqual({ hasCommand: false });
    expect(await status(() => service.received(agentA, queued.command.commandId, { leaseId: again.leaseId, payloadHash: 'other' }))).toBe('409 PAYLOAD_HASH_MISMATCH');
    // Cross-agent access is indistinguishable from "not found".
    expect(await status(() => service.received(agentB, queued.command.commandId, { leaseId: again.leaseId, payloadHash: queued.command.payloadHash }))).toBe('404 COMMAND_NOT_FOUND');
    const incidents = await pool.query(`SELECT kind FROM onec_agent_incidents`);
    expect(incidents.rows.map((row) => row.kind)).toEqual(['command_hash_mismatch']);
    const audit = await pool.query(`SELECT a.event, l.command_id FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id WHERE a.event = 'onec.command.received'`);
    expect(audit.rows).toEqual([{ event: 'onec.command.received', command_id: queued.command.commandId }]);
  });

  it('stores results byte for byte: repeat is a no-op, a different body is 409, unknown is 404; dead_letter raises an alert', async () => {
    const queued = await enqueue();
    await lease();
    const body = JSON.stringify({ commandId: queued.command.commandId, status: 'dead_letter', resultVersion: 1, error: { code: 'ONEC_REJECTED', message: 'E2E-Тест' } });
    // Result without a prior received is accepted (implicit receipt).
    await service.result(agentA, queued.command.commandId, Buffer.from(body));
    await service.result(agentA, queued.command.commandId, Buffer.from(body));
    const row = (await pool.query(`SELECT status, received_at IS NOT NULL AS received, result_sha256, result_error_code FROM onec_agent_commands`)).rows[0];
    expect(row).toEqual({ status: 'dead_letter', received: true, result_sha256: sha256Hex(body), result_error_code: 'ONEC_REJECTED' });
    expect(await status(() => service.result(agentA, queued.command.commandId, Buffer.from(body.replace('E2E-Тест', 'другое'))))).toBe('409 RESULT_CONFLICT');
    expect(await status(() => service.result(agentA, randomUUID(), Buffer.from(body)))).toBe('400 COMMAND_ID_MISMATCH');
    const unknownId = randomUUID();
    expect(await status(() => service.result(agentA, unknownId, Buffer.from(body.replace(queued.command.commandId, unknownId))))).toBe('404 COMMAND_NOT_FOUND');
    const events = await pool.query(`SELECT event_type, idempotency_key FROM onec_outbox_events`);
    expect(events.rows).toEqual([{ event_type: 'onec.command.completed', idempotency_key: `onec.command.completed:${queued.command.commandId}` }]);
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT kind, severity FROM onec_alerts`)).rows).toEqual([{ kind: 'command_dead_letter', severity: 'critical' }]);
    expect((await pool.query(`SELECT kind FROM onec_agent_incidents ORDER BY kind`)).rows.map((r) => r.kind)).toEqual(['result_conflict', 'result_for_unknown_command']);
  });

  it('cancels only commands the agent cannot have; a result for a cancelled command is kept with an incident', async () => {
    const queued = await enqueue();
    const leasedCmd = await enqueue();
    const cancelled = await service.cancel(queued.command.commandId, actor, ctx('c1'));
    expect(cancelled.status).toBe('cancelled');
    await lease();
    expect(await status(() => service.cancel(leasedCmd.command.commandId, actor, ctx('c2')))).toBe('409 ONEC_COMMAND_NOT_CANCELLABLE');
    // Lease expired without a receipt: now cancellable; a late result still counts.
    await pool.query(`UPDATE onec_agent_commands SET lease_expires_at = now() - interval '1 second' WHERE command_id = $1`, [leasedCmd.command.commandId]);
    await service.cancel(leasedCmd.command.commandId, actor, ctx('c3'));
    const body = JSON.stringify({ commandId: leasedCmd.command.commandId, status: 'succeeded', resultVersion: 1, document: {} });
    await service.result(agentA, leasedCmd.command.commandId, Buffer.from(body));
    expect((await pool.query(`SELECT status FROM onec_agent_commands WHERE command_id = $1`, [leasedCmd.command.commandId])).rows[0].status).toBe('cancelled');
    expect((await pool.query(`SELECT kind FROM onec_agent_incidents`)).rows.map((r) => r.kind)).toEqual(['result_for_cancelled_command']);
  });

  it('wakes a waiting long poll as soon as a command is queued (in-process notify)', async () => {
    const started = Date.now();
    const pending = service.lease(agentA, { sessionId: sessionA, supportedCommandTypes: ['integration_probe'], maxWaitSeconds: 20 }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const queued = await service.operatorEnqueue('agent-a', { commandType: 'integration_probe', payload: { marker: 'E2E-Тест' } }, 'e2e-operator-1', actor, ctx('op1'));
    const result = await pending;
    expect(result.command).toMatchObject({ commandId: queued.commandId });
    expect(Date.now() - started).toBeLessThan(4000);
    const audit = await pool.query(`SELECT a.event, l.command_id, l.actor_kind FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id WHERE a.event = 'onec.command.enqueued'`);
    expect(audit.rows).toEqual([{ event: 'onec.command.enqueued', command_id: queued.commandId, actor_kind: 'user' }]);
    // A newer long poll of the same agent supersedes the older one.
    const older = service.lease(agentA, { sessionId: sessionA, supportedCommandTypes: ['integration_probe'], maxWaitSeconds: 20 }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const newer = service.lease(agentA, { sessionId: sessionA, supportedCommandTypes: ['integration_probe'], maxWaitSeconds: 1 }, new AbortController().signal);
    expect(await older).toEqual({ hasCommand: false });
    expect(await newer).toEqual({ hasCommand: false });
  });

  it('operator commands: only allowed types with valid payloads and an Idempotency-Key', async () => {
    expect(await status(() => service.operatorEnqueue('agent-a', { commandType: 'create_customer_order', payload: {} }, 'k-12345678', actor, ctx('x')))).toBe('422 ONEC_COMMAND_NOT_ALLOWED');
    expect(await status(() => service.operatorEnqueue('agent-a', { commandType: 'reload_entity', payload: {} }, 'k-12345678', actor, ctx('x')))).toBe('422 VALIDATION_FAILED');
    expect(await status(() => service.operatorEnqueue('agent-a', { commandType: 'pause_etl', payload: {} }, undefined, actor, ctx('x')))).toBe('400 IDEMPOTENCY_KEY_REQUIRED');
    const sent = await service.operatorEnqueue('agent-a', { commandType: 'start_full_sync', payload: { entities: ['items'] } }, 'k-12345678', actor, ctx('x'));
    expect(sent).toMatchObject({ commandType: 'start_full_sync', commandKind: 'admin', status: 'queued', created: true, payload: { entities: ['items'] } });
  });

  it('idempotency compares the whole request; an identical repeat succeeds even after its expiry', async () => {
    const key = 'e2e-intent-123456';
    const expiresAtUtc = new Date(Date.now() + 60_000).toISOString();
    const first = await enqueue({ expiresAtUtc, notBeforeUtc: null, priority: 5 }, key);
    for (const changed of [{ priority: 6 }, { orderingKey: 'k' }, { notBeforeUtc: new Date(Date.now() + 86_400_000).toISOString() }, { expiresAtUtc: new Date(Date.now() + 120_000).toISOString() }, { sourceEntityId: '42' }]) {
      expect(await status(() => enqueue({ expiresAtUtc, priority: 5, ...changed }, key))).toBe('409 ONEC_COMMAND_IDEMPOTENCY_CONFLICT');
    }
    await pool.query(`UPDATE onec_agent_commands SET expires_at_utc = now() - interval '1 second'`);
    const pastExpiry = (await pool.query(`SELECT expires_at_utc FROM onec_agent_commands`)).rows[0].expires_at_utc as Date;
    const again = await enqueue({ expiresAtUtc: pastExpiry.toISOString(), priority: 5 }, key);
    expect(again).toMatchObject({ created: false, command: { commandId: first.command.commandId } });
  });

  it('enqueue policy: business types only when enabled for the agent, admin types always, payloadVersion 1 only', async () => {
    expect(await status(() => enqueue({ agentId: 'agent-b' }))).toBe('422 ONEC_COMMAND_TYPE_NOT_ENABLED');
    expect(await status(() => enqueue({ commandType: 'create_customer_order', payload: {} }))).toBe('422 ONEC_COMMAND_TYPE_NOT_ENABLED');
    expect((await enqueue({ agentId: 'agent-b', commandType: 'pause_etl', payload: {} })).created).toBe(true);
    expect(await status(() => enqueue({ payloadVersion: 2 }))).toBe('422 ONEC_COMMAND_PAYLOAD_VERSION');
    expect(await status(() => service.operatorEnqueue('agent-b', { commandType: 'integration_probe', payload: { marker: 'E2E-Тест' } }, 'k-12345678', actor, ctx('x')))).toBe('422 ONEC_COMMAND_TYPE_NOT_ENABLED');
    // The longest allowed header still fits after the `<userId>:` prefix.
    const sent = await service.operatorEnqueue('agent-a', { commandType: 'pause_etl', payload: {} }, 'k'.repeat(200), actor, ctx('x'));
    expect(sent.created).toBe(true);
  });

  it('a late receipt/result of an expired_undelivered command keeps the status, stores the result, opens an incident and resolves the alert', async () => {
    const queued = await enqueue({ expiresAtUtc: new Date(Date.now() + 60_000).toISOString(), correlationId: '11111111-2222-4333-8444-555555555555' });
    const leased = await lease();
    await pool.query(`UPDATE onec_agent_commands SET expires_at_utc = now() - interval '1 second', lease_expires_at = now() - interval '1 second'`);
    expect(await monitor.expireUndeliveredCommands(new Date())).toBe(1);
    await monitor.relayOutbox();
    // Replaying the same fact never reopens or duplicates the one-shot alert.
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT state FROM onec_alerts`)).rows).toEqual([{ state: 'open' }]);
    await service.received(agentA, queued.command.commandId, { leaseId: leased.leaseId, payloadHash: queued.command.payloadHash });
    const body = JSON.stringify({ commandId: queued.command.commandId, status: 'succeeded', resultVersion: 1 });
    await service.result(agentA, queued.command.commandId, Buffer.from(body));
    const row = (await pool.query(`SELECT status, received_at IS NOT NULL AS received, result_sha256 FROM onec_agent_commands`)).rows[0];
    expect(row).toEqual({ status: 'expired_undelivered', received: true, result_sha256: sha256Hex(body) });
    expect((await pool.query(`SELECT kind FROM onec_agent_incidents`)).rows.map((r) => r.kind)).toEqual(['late_delivery_of_expired_command']);
    expect((await pool.query(`SELECT state FROM onec_alerts`)).rows).toEqual([{ state: 'resolved' }]);
    // The command's correlation id reaches the audit even without an agent header.
    const links = await pool.query(`SELECT a.event, l.correlation_id FROM audit_log a JOIN onec_audit_links l ON l.audit_id = a.audit_id WHERE l.command_id = $1 ORDER BY a.event`, [queued.command.commandId]);
    expect(links.rows).toEqual([
      { event: 'onec.command.completed', correlation_id: '11111111-2222-4333-8444-555555555555' },
      { event: 'onec.command.received', correlation_id: '11111111-2222-4333-8444-555555555555' },
    ]);
  });

  it('one-shot command alerts are closed by the operator and stay closed on replay', async () => {
    const queued = await enqueue();
    await lease();
    await service.result(agentA, queued.command.commandId, Buffer.from(JSON.stringify({ commandId: queued.command.commandId, status: 'dead_letter', resultVersion: 1 })));
    await monitor.relayOutbox();
    const alertId = Number((await pool.query(`SELECT alert_id FROM onec_alerts`)).rows[0].alert_id);
    expect(await commandsRepo.transaction((tx) => repo.resolveAlert(tx, alertId, ['command_dead_letter']))).toMatchObject({ state: 'resolved' });
    await pool.query(`UPDATE onec_outbox_events SET status = 'pending', processed_at = NULL, next_attempt_at = now()`);
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT state FROM onec_alerts`)).rows).toEqual([{ state: 'resolved' }]);
    // State-derived kinds are never operator-resolvable.
    expect(await commandsRepo.transaction((tx) => repo.resolveAlert(tx, alertId, ['agent_silent']))).toBeNull();
  });

  it('a new long poll supersedes an older one even when it leases at once', async () => {
    const older = service.lease(agentA, { sessionId: sessionA, supportedCommandTypes: ['integration_probe'], maxWaitSeconds: 20 }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const first = await enqueue();
    await enqueue();
    const newer = await lease();
    expect(newer.command).toMatchObject({ commandId: first.command.commandId });
    const started = Date.now();
    expect(await older).toEqual({ hasCommand: false });
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_agent_commands WHERE status = 'queued'`)).rows[0].n).toBe(1);
  });

  it('a poll superseded while its lease query runs gives the lease back', async () => {
    const queued = await enqueue();
    const original = commandsRepo.leaseNext.bind(commandsRepo);
    let calls = 0;
    commandsRepo.leaseNext = async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      calls += 1;
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 400));
      return result;
    };
    try {
      const older = service.lease(agentA, { sessionId: sessionA, supportedCommandTypes: ['integration_probe'], maxWaitSeconds: 5 }, new AbortController().signal);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const newer = lease();
      expect(await older).toEqual({ hasCommand: false });
      expect((await pool.query(`SELECT status, lease_id FROM onec_agent_commands`)).rows[0]).toEqual({ status: 'queued', lease_id: null });
      // The current poll picks the returned command up on its next pass.
      expect((await newer).command).toMatchObject({ commandId: queued.command.commandId });
    } finally {
      commandsRepo.leaseNext = original;
    }
  });

  it('never raises "undelivered" when the late receipt landed before the relay; received audit carries the real transition', async () => {
    const queued = await enqueue({ expiresAtUtc: new Date(Date.now() + 60_000).toISOString() });
    const leased = await lease();
    await service.received(agentA, queued.command.commandId, { leaseId: leased.leaseId, payloadHash: queued.command.payloadHash });
    const audit = await pool.query(`SELECT before_json, after_json FROM audit_log WHERE event = 'onec.command.received'`);
    expect(audit.rows[0]).toMatchObject({ before_json: { status: 'leased' }, after_json: { status: 'received' } });
    const other = await enqueue({ expiresAtUtc: new Date(Date.now() + 60_000).toISOString() });
    const otherLease = await lease();
    await pool.query(`UPDATE onec_agent_commands SET expires_at_utc = now() - interval '1 second', lease_expires_at = now() - interval '1 second' WHERE command_id = $1`, [other.command.commandId]);
    expect(await monitor.expireUndeliveredCommands(new Date())).toBe(1);
    // Late receipt BEFORE the relay projects the expiry event.
    await service.received(agentA, other.command.commandId, { leaseId: otherLease.leaseId, payloadHash: other.command.payloadHash });
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT count(*)::int AS n FROM onec_alerts`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT kind FROM onec_agent_incidents`)).rows.map((r) => r.kind)).toEqual(['late_delivery_of_expired_command']);
  });

  it('concurrent refused cancels use only their own transaction connection', async () => {
    const queued = await enqueue();
    const leased = await lease();
    await service.received(agentA, queued.command.commandId, { leaseId: leased.leaseId, payloadHash: queued.command.payloadHash });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => status(() => service.cancel(queued.command.commandId, actor, ctx(`c${i}`)))));
    expect(new Set(results)).toEqual(new Set(['409 ONEC_COMMAND_NOT_CANCELLABLE']));
  }, 20000);

  it('marks never-delivered expired commands and raises a warning alert', async () => {
    const queued = await enqueue({ expiresAtUtc: new Date(Date.now() + 60_000).toISOString() });
    await pool.query(`UPDATE onec_agent_commands SET expires_at_utc = now() - interval '1 second'`);
    expect(await monitor.expireUndeliveredCommands(new Date())).toBe(1);
    expect((await pool.query(`SELECT status FROM onec_agent_commands`)).rows[0].status).toBe('expired_undelivered');
    await monitor.relayOutbox();
    expect((await pool.query(`SELECT kind, severity FROM onec_alerts`)).rows).toEqual([{ kind: 'command_expired_undelivered', severity: 'warning' }]);
    expect(queued.created).toBe(true);
  });
});
