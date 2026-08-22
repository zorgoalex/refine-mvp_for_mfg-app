#!/usr/bin/env node

const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { setMaxListeners } = require('node:events');
const jwt = require('jsonwebtoken');
const {
  assertIsolatedLoadAllowed,
  assertIsolatedTargetResolution,
  assertSharedStageCleanupAllowed,
  assertSharedStageLoadAllowed,
  assertSharedStageTargetResolution,
  calculateCpuBusyPercent,
  consumeSseLoadChunk,
  evaluateSharedStageCpuSafety,
  parseOrderSseLoadArgs,
  parseProcStatCpuSnapshot,
  readLoadCredentials,
} = require('./order-sse-load-lib.js');
const { createEvidenceLogger, safeErrorMessage } = require('./order-sse-rollout-lib.js');

async function main() {
  const config = parseOrderSseLoadArgs(process.argv.slice(2));
  if (config.help) return printUsage();
  if (config.cleanupRunId) {
    assertSharedStageCleanupAllowed(config);
    const cleanup = await cleanupStageFixtures(config.cleanupRunId);
    process.stdout.write(`${JSON.stringify(cleanup)}\n`);
    if (cleanup.remaining !== 0) process.exitCode = 1;
    return;
  }

  const sharedStage = config.targetEnv === 'shared-stage';
  let credentials = [];
  if (sharedStage) {
    assertSharedStageLoadAllowed(config);
    await assertSharedStageTargetResolution(config);
    if (config.preflightOnly) {
      const controller = new AbortController();
      const deployment = await assertSharedStageDeployment(config, controller.signal);
      process.stdout.write(`${JSON.stringify({ status: 'shared_stage_preflight_passed', ...deployment })}\n`);
      return;
    }
  } else {
    assertIsolatedLoadAllowed(config);
    await assertIsolatedTargetResolution(config);
    credentials = readLoadCredentials(config);
  }
  const evidence = createEvidenceLogger(config.logRoot, sharedStage ? 'shared-stage-load' : 'isolated-load');
  const abortController = new AbortController();
  setMaxListeners(0, abortController.signal);
  const sigint = () => abortController.abort(new Error('SIGINT'));
  const sigterm = () => abortController.abort(new Error('SIGTERM'));
  const activeConnections = new Set();
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  let summary;
  let fixtureUsers = [];
  let cpuWatchdog;
  try {
    evidence.log('load_started', {
      targetEnv: config.targetEnv,
      backendOrigin: new URL(config.backendUrl).origin,
      clients: config.clients,
      credentialCount: sharedStage ? undefined : credentials.length,
      connectionsPerUser: config.connectionsPerUser,
      reconnectRounds: config.reconnectRounds,
      roundSeconds: config.roundSeconds,
      expectedStageSha: sharedStage ? config.expectedStageSha : undefined,
      expectedBackendSha: sharedStage ? config.expectedBackendSha : undefined,
      runId: sharedStage ? config.runId : undefined,
    });
    if (sharedStage) {
      const deploymentBefore = await assertSharedStageDeployment(config, abortController.signal);
      const seedIdentity = await loginSharedStageSeed(config, abortController.signal);
      fixtureUsers = await provisionStageFixtures(config.runId, config.seedUserId, Math.ceil(config.clients / config.connectionsPerUser));
      evidence.log('stage_fixtures_created', { count: fixtureUsers.length });
      const identities = mintStageIdentities(config, seedIdentity, fixtureUsers);
      cpuWatchdog = startSharedStageCpuWatchdog(abortController, evidence);
      summary = await runSharedStageLoad(
        config,
        identities,
        abortController,
        activeConnections,
        evidence,
        cpuWatchdog,
      );
      const deploymentAfter = await assertSharedStageDeployment(config, abortController.signal);
      summary = { ...summary, deploymentBefore, deploymentAfter };
    } else {
      const identities = await loginAll(config, credentials, abortController.signal);
      summary = await runIsolatedLoad(config, identities, abortController, activeConnections, evidence);
    }
    evidence.log('load_completed', summary);
  } catch (error) {
    if (!abortController.signal.aborted) abortController.abort(error);
    summary = {
      status: sharedStage ? 'shared_stage_load_failed' : 'isolated_load_failed',
      error: safeErrorMessage(abortController.signal.reason || error),
    };
    evidence.log('load_failed', summary);
    process.exitCode = 1;
  } finally {
    cpuWatchdog?.stop();
    process.removeListener('SIGINT', sigint);
    process.removeListener('SIGTERM', sigterm);
    if (!abortController.signal.aborted) abortController.abort(new Error('load cleanup'));
    const cleanup = await closeConnections(activeConnections, 5000);
    let fixtureCleanup = { deleted: 0, remaining: 0 };
    if (sharedStage && config.runId) {
      try {
        fixtureCleanup = await cleanupStageFixtures(config.runId);
      } catch (error) {
        fixtureCleanup = { deleted: 0, remaining: fixtureUsers.length, error: safeErrorMessage(error) };
      }
    }
    if (cleanup.timedOut || cleanup.remaining > 0 || fixtureCleanup.remaining > 0 || fixtureCleanup.error) {
      summary = {
        ...(summary || {}),
        status: sharedStage ? 'shared_stage_load_failed' : 'isolated_load_failed',
      };
      process.exitCode = 1;
    }
    summary = { ...(summary || {}), cleanup: { connections: cleanup, fixtures: fixtureCleanup } };
    evidence.log(
      cleanup.timedOut || cleanup.remaining > 0 || fixtureCleanup.remaining > 0 || fixtureCleanup.error
        ? 'cleanup_failed'
        : 'cleanup_verified',
      summary.cleanup,
    );
    try {
      evidence.validate();
      evidence.writeSummary(summary);
    } finally {
      evidence.close();
    }
  }
}

async function runIsolatedLoad(config, identities, abortController, activeConnections, evidence) {
  let openedTotal = 0;
  let unexpectedDisconnects = 0;
  let heartbeatCount = 0;
  for (let round = 1; round <= config.reconnectRounds; round += 1) {
    const connections = await openRound(config, identities, abortController.signal, activeConnections);
    openedTotal += connections.length;
    evidence.log('load_round_opened', { round, opened: connections.length });
    await delay(config.roundSeconds * 1000, abortController.signal);
    const closed = await closeRoundConnections(connections, activeConnections);
    unexpectedDisconnects += closed.unexpectedDisconnects;
    heartbeatCount += closed.heartbeatCount;
    evidence.log('load_round_closed', { round, unexpectedDisconnects, heartbeatCount });
    if (unexpectedDisconnects > 0) throw new Error('Unexpected SSE disconnect during isolated load round');
    if (closed.connectionsWithoutHeartbeat > 0) {
      throw new Error('One or more isolated SSE connections received no heartbeat');
    }
  }
  return {
    status: 'isolated_load_passed',
    clients: config.clients,
    reconnectRounds: config.reconnectRounds,
    openedTotal,
    unexpectedDisconnects,
    heartbeatCount,
  };
}

async function runSharedStageLoad(
  config,
  identities,
  abortController,
  activeConnections,
  evidence,
  cpuWatchdog,
) {
  const assignments = createConnectionAssignments(config, identities);
  const backendBaseline = await readBackendProcessMetrics();
  let backendMaximumRssKb = backendBaseline.rssKb;
  let backendMaximumFdCount = backendBaseline.fdCount;
  let openedTotal = 0;
  let heartbeatCount = 0;
  let maximumOpenLatencyMs = 0;
  const fanoutLatencyMs = [];
  for (let round = 1; round <= config.reconnectRounds; round += 1) {
    const connections = [];
    for (const target of config.rampClients) {
      const opened = await openAssignmentRange(
        config,
        assignments.slice(connections.length, target),
        abortController.signal,
        activeConnections,
      );
      connections.push(...opened);
      openedTotal += opened.length;
      maximumOpenLatencyMs = Math.max(
        maximumOpenLatencyMs,
        ...opened.map((connection) => connection.metrics.openLatencyMs),
      );
      if (maximumOpenLatencyMs > 5000) {
        throw new Error(`Shared-stage SSE open latency ${maximumOpenLatencyMs}ms exceeds 5000ms`);
      }
      const holdSeconds = target === config.clients ? config.roundSeconds : config.stageStepSeconds;
      evidence.log('shared_stage_ramp_opened', {
        round,
        target,
        opened: connections.length,
        holdSeconds,
        maximumOpenLatencyMs,
      });
      if (target === config.rampClients[0]) {
        const connectionLimitStatus = await assertPerUserConnectionLimit(
          config,
          connections[0],
          abortController.signal,
        );
        evidence.log('shared_stage_per_user_limit_verified', { round, status: connectionLimitStatus });
      }
      if (target === config.clients) {
        const fanout = await emitAndMeasureStageFanout(
          config,
          connections,
          round,
          abortController.signal,
        );
        fanoutLatencyMs.push(...fanout.latencyMs);
        evidence.log('shared_stage_invalidation_fanout', {
          round,
          delivered: fanout.delivered,
          p95LatencyMs: percentile(fanout.latencyMs, 95),
          maximumLatencyMs: Math.max(...fanout.latencyMs),
          convergenceStatus: fanout.convergenceStatus,
        });
      }
      await delay(holdSeconds * 1000, abortController.signal);
      const disconnected = connections.filter((connection) => connection.metrics.unexpectedDisconnect).length;
      if (disconnected > 0) throw new Error('Unexpected SSE disconnect during shared-stage ramp');
      if (activeConnections.size !== target) {
        throw new Error(`Shared-stage tracked connection mismatch: expected ${target}, found ${activeConnections.size}`);
      }
      const backend = await readBackendProcessMetrics();
      if (backend.pid !== backendBaseline.pid) throw new Error('Shared-stage backend restarted during load');
      if (backend.rssKb - backendBaseline.rssKb > 256 * 1024) {
        throw new Error('Shared-stage backend RSS grew by more than 256 MiB');
      }
      if (backend.fdCount >= 900) throw new Error(`Shared-stage backend file descriptor count is unsafe: ${backend.fdCount}`);
      backendMaximumRssKb = Math.max(backendMaximumRssKb, backend.rssKb);
      backendMaximumFdCount = Math.max(backendMaximumFdCount, backend.fdCount);
      evidence.log('shared_stage_ramp_held', {
        round,
        target,
        heartbeatCount: connections.reduce((sum, connection) => sum + connection.metrics.heartbeats, 0),
        cpu: cpuWatchdog.snapshot(),
        backend,
      });
    }

    const closed = await closeRoundConnections(connections, activeConnections);
    heartbeatCount += closed.heartbeatCount;
    evidence.log('load_round_closed', { round, ...closed });
    if (closed.unexpectedDisconnects > 0) {
      throw new Error('Unexpected SSE disconnect during shared-stage load round');
    }
    if (closed.connectionsWithoutHeartbeat > 0) {
      throw new Error('One or more shared-stage SSE connections received no heartbeat');
    }
  }
  return {
    status: 'shared_stage_load_passed',
    gateEligible: true,
    clients: config.clients,
    connectionsPerUser: config.connectionsPerUser,
    fixtureUsers: identities.length,
    reconnectRounds: config.reconnectRounds,
    rampClients: config.rampClients,
    openedTotal,
    unexpectedDisconnects: 0,
    heartbeatCount,
    maximumOpenLatencyMs,
    fanoutEvents: config.reconnectRounds,
    fanoutDeliveries: fanoutLatencyMs.length,
    fanoutP95LatencyMs: percentile(fanoutLatencyMs, 95),
    fanoutMaximumLatencyMs: Math.max(...fanoutLatencyMs),
    backend: {
      pid: backendBaseline.pid,
      baselineRssKb: backendBaseline.rssKb,
      maximumRssKb: backendMaximumRssKb,
      maximumRssGrowthKb: backendMaximumRssKb - backendBaseline.rssKb,
      baselineFdCount: backendBaseline.fdCount,
      maximumFdCount: backendMaximumFdCount,
    },
    cpu: cpuWatchdog.snapshot(),
  };
}

async function assertPerUserConnectionLimit(config, connection, parentSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('Shared-stage connection-limit probe timed out')),
    10000,
  );
  try {
    const response = await fetch(`${config.backendUrl}/orders/${config.orderId}/live-events`, {
      headers: {
        authorization: `Bearer ${connection.identity.accessToken}`,
        accept: 'text/event-stream',
        'last-event-id': connection.initialCursor,
      },
      signal: controller.signal,
    });
    const status = response.status;
    if (response.body) await response.body.cancel().catch(() => undefined);
    if (status !== 429) throw new Error(`Shared-stage per-user connection limit expected HTTP 429, received ${status}`);
    return status;
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', abort);
    controller.abort();
  }
}

async function emitAndMeasureStageFanout(config, connections, round, signal) {
  const baselines = connections.map((connection) => connection.metrics.invalidations);
  const emittedAt = Date.now();
  const emitted = await emitStageInvalidation(config, round);
  if (emitted?.emitted !== true || emitted?.notified !== true) {
    throw new Error('Shared-stage synthetic invalidation was not emitted and notified');
  }
  const deadline = emittedAt + 5000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason || new Error('Shared-stage fanout aborted');
    if (connections.every((connection, index) => connection.metrics.invalidations > baselines[index])) break;
    await delay(25, signal);
  }
  const delivered = connections.filter(
    (connection, index) => connection.metrics.invalidations > baselines[index],
  );
  if (delivered.length !== connections.length) {
    throw new Error(`Shared-stage invalidation fanout incomplete: ${delivered.length}/${connections.length}`);
  }
  for (const connection of delivered) {
    const event = connection.metrics.lastInvalidation;
    if (
      connection.metrics.invalidFrames > 0 ||
      !event ||
      Number(event.data?.orderId) !== config.orderId ||
      event.data?.cursor !== event.id ||
      !Array.isArray(event.data?.domains) ||
      !event.data.domains.includes('detail_status')
    ) {
      throw new Error('Shared-stage invalidation payload is invalid');
    }
  }
  const latencyMs = delivered.map((connection) => connection.metrics.lastInvalidationAt - emittedAt);
  const p95LatencyMs = percentile(latencyMs, 95);
  if (p95LatencyMs > 2000) {
    throw new Error(`Shared-stage invalidation p95 latency ${p95LatencyMs}ms exceeds 2000ms`);
  }
  const first = connections[0];
  const { response: convergence } = await fetchBounded(
    `${config.backendUrl}/orders/${config.orderId}/detail-live-state`,
    {
      headers: {
        authorization: `Bearer ${first.identity.accessToken}`,
        accept: 'application/json',
        'if-none-match': first.snapshotEtag,
      },
    },
    signal,
    10000,
    (response) => response.arrayBuffer(),
  );
  const convergedCursor = convergence.headers.get('x-erp-stream-cursor');
  if (convergence.status !== 304 || !convergedCursor || convergedCursor === first.initialCursor) {
    throw new Error(`Shared-stage convergence failed: HTTP ${convergence.status}`);
  }
  return {
    delivered: delivered.length,
    convergenceStatus: convergence.status,
    latencyMs,
  };
}

async function emitStageInvalidation(config, round) {
  const source = `e2e_sse_load.${config.runId}.${round}`;
  const sql = `
WITH emitted AS MATERIALIZED (
  SELECT order_realtime_emit_one(
    ${Number(config.orderId)}::bigint,
    ARRAY['detail_status']::text[],
    NULL::bigint[],
    '${sqlLiteral(source)}'::text
  ) AS ok
), notified AS MATERIALIZED (
  SELECT pg_notify('erp_realtime', '${Number(config.orderId)}:wake')
  FROM emitted
  WHERE ok
)
SELECT json_build_object(
  'emitted', (SELECT ok FROM emitted),
  'notified', EXISTS (SELECT 1 FROM notified)
)::text;
`;
  return runStagePsqlJson(sql);
}

async function assertSharedStageDeployment(config, signal) {
  const runtimeUrl = 'https://app-test.mebelkz.app/runtime-config.json';
  const healthUrl = `${new URL(config.backendUrl).origin}/health/ready`;
  const [{ response: runtimeResponse, consumed: runtime }, { response: healthResponse, consumed: health }] =
    await Promise.all([
      fetchBounded(runtimeUrl, {}, signal, 10000, (response) => response.json()),
      fetchBounded(healthUrl, {}, signal, 10000, (response) => response.json()),
    ]);
  if (!runtimeResponse.ok || !healthResponse.ok) {
    throw new Error(`Shared-stage deployment check failed: runtime ${runtimeResponse.status}, health ${healthResponse.status}`);
  }
  if (runtime?.deployment?.gitCommitSha !== config.expectedStageSha) {
    throw new Error('Shared-stage frontend SHA does not match the expected gate SHA');
  }
  if (health?.deployment?.gitCommitSha !== config.expectedBackendSha) {
    throw new Error('Shared-stage backend SHA does not match the expected gate SHA');
  }
  if (runtime?.features?.orderRealtime !== true || health?.checks?.realtime?.status !== 'ok') {
    throw new Error('Shared-stage realtime runtime is not enabled and healthy');
  }
  return {
    frontendSha: runtime.deployment.gitCommitSha,
    backendSha: health.deployment.gitCommitSha,
    realtimeEnabled: true,
    realtimeStatus: health.checks.realtime.status,
  };
}

async function loginSharedStageSeed(config, signal) {
  const username = String(process.env.ERP_WORKER_LOGIN || '').trim();
  const password = String(process.env.ERP_WORKER_PASSWORD || '');
  if (!username || !password) throw new Error('ERP_WORKER_LOGIN and ERP_WORKER_PASSWORD are required');
  const [identity] = await loginAll(config, [{ username, password, orderId: config.orderId }], signal);
  const payload = jwt.decode(identity.accessToken);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.sub !== String(config.seedUserId)) {
    throw new Error(`Shared-stage seed login must resolve user ${config.seedUserId}`);
  }
  return { ...identity, payload };
}

function mintStageIdentities(config, seedIdentity, fixtureUsers) {
  const secret = process.env.JWT_ACCESS_SECRET || process.env.HASURA_JWT_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET or HASURA_JWT_SECRET is required');
  const basePayload = { ...seedIdentity.payload };
  for (const claim of ['sub', 'username', 'iat', 'exp', 'nbf', 'jti', 'sessionId']) delete basePayload[claim];
  return fixtureUsers.map((user) => ({
    orderId: config.orderId,
    accessToken: jwt.sign({
      ...basePayload,
      sub: String(user.userId),
      username: user.username,
      'https://hasura.io/jwt/claims': {
        ...basePayload['https://hasura.io/jwt/claims'],
        'x-hasura-user-id': String(user.userId),
      },
    }, secret, { algorithm: 'HS256', expiresIn: 30 * 60 }),
  }));
}

async function provisionStageFixtures(runId, seedUserId, count) {
  const prefix = stageFixturePrefix(runId);
  const sql = `
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE username::text LIKE 'e2e_sse_load_%') THEN
    RAISE EXCEPTION 'stale E2E SSE load fixtures exist';
  END IF;
END
$guard$;
WITH seed AS (
  SELECT user_id, password_hash, role_id, login_policy
  FROM users
  WHERE user_id = ${Number(seedUserId)} AND is_active = true
), inserted AS (
  INSERT INTO users (
    username, password_hash, role_id, employee_id, is_active, last_login_at,
    ref_key_1c, created_by, edited_by, full_name, email, login_policy,
    workos_self_link_enabled, workos_self_unlink_enabled
  )
  SELECT
    ('${sqlLiteral(prefix)}' || sequence)::citext,
    seed.password_hash,
    seed.role_id,
    NULL,
    true,
    NULL,
    NULL,
    seed.user_id,
    seed.user_id,
    'E2E SSE Load ${sqlLiteral(runId)} ' || sequence,
    ('${sqlLiteral(prefix)}' || sequence || '@example.invalid')::citext,
    seed.login_policy,
    false,
    false
  FROM seed
  CROSS JOIN generate_series(1, ${Number(count)}) AS sequence
  RETURNING user_id, username::text
)
SELECT COALESCE(
  json_agg(json_build_object('userId', user_id::text, 'username', username) ORDER BY user_id)::text,
  '[]'
)
FROM inserted;
`;
  const users = await runStagePsqlJson(sql);
  if (!Array.isArray(users) || users.length !== count) {
    throw new Error(`Shared-stage fixture provisioning expected ${count} users`);
  }
  return users;
}

async function cleanupStageFixtures(runId) {
  const prefix = stageFixturePrefix(runId);
  const deleted = await runStagePsqlJson(`
WITH deleted AS (
  DELETE FROM users
  WHERE left(username::text, ${prefix.length}) = '${sqlLiteral(prefix)}'
  RETURNING user_id
)
SELECT json_build_object('deleted', (SELECT count(*) FROM deleted))::text;
`);
  const verification = await runStagePsqlJson(`
SELECT json_build_object(
  'remaining', count(*)
)::text
FROM users
WHERE left(username::text, ${prefix.length}) = '${sqlLiteral(prefix)}';
`);
  return {
    deleted: Number(deleted?.deleted || 0),
    remaining: Number(verification?.remaining || 0),
  };
}

function runStagePsqlJson(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('rtk', [
      'docker', 'exec', '-i', 'erp_test-postgresdb-1', 'sh', '-lc',
      'exec psql -X -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Shared-stage fixture SQL failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      const candidate = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try {
        resolve(JSON.parse(candidate || ''));
      } catch {
        reject(new Error('Shared-stage fixture SQL returned invalid JSON'));
      }
    });
    child.stdin.end(sql);
  });
}

async function readBackendProcessMetrics() {
  const output = await runStageCommandText([
    'docker', 'inspect', '--format', '{{.State.Pid}}', 'erp_test-backend-1',
  ]);
  const pid = Number(output.trim());
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Shared-stage backend PID is invalid');
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  if (!rssMatch) throw new Error('Shared-stage backend RSS is unavailable');
  const fdOutput = await runStageCommandText([
    'docker', 'exec', 'erp_test-backend-1', 'node', '-e',
    'process.stdout.write(String(require("node:fs").readdirSync("/proc/1/fd").length))',
  ]);
  const fdCount = Number(fdOutput.trim());
  if (!Number.isSafeInteger(fdCount) || fdCount < 1) {
    throw new Error('Shared-stage backend file descriptor count is unavailable');
  }
  return {
    pid,
    rssKb: Number(rssMatch[1]),
    fdCount,
  };
}

function runStageCommandText(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('rtk', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Shared-stage command failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

function startSharedStageCpuWatchdog(abortController, evidence) {
  let previous = parseProcStatCpuSnapshot(readFileSync('/proc/stat', 'utf8'));
  let consecutiveBreaches = 0;
  const metrics = { samples: 0, breaches: 0, maxBusyPercent: [0, 0, 0, 0] };
  const timer = setInterval(() => {
    try {
      const current = parseProcStatCpuSnapshot(readFileSync('/proc/stat', 'utf8'));
      const busyPercent = calculateCpuBusyPercent(previous, current);
      previous = current;
      const safety = evaluateSharedStageCpuSafety(busyPercent);
      metrics.samples += 1;
      metrics.maxBusyPercent = metrics.maxBusyPercent.map((value, index) => Math.max(value, busyPercent[index]));
      consecutiveBreaches = safety.safe ? 0 : consecutiveBreaches + 1;
      if (!safety.safe) metrics.breaches += 1;
      evidence.log('shared_stage_cpu_sample', { busyPercent, safety, consecutiveBreaches });
      if (consecutiveBreaches >= 2 && !abortController.signal.aborted) {
        abortController.abort(new Error(`Shared-stage CPU safety breach: ${safety.reason}`));
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        abortController.abort(new Error(`Shared-stage CPU watchdog failed: ${safeErrorMessage(error)}`));
      }
    }
  }, 5000);
  return {
    snapshot: () => ({ ...metrics, maxBusyPercent: [...metrics.maxBusyPercent], consecutiveBreaches }),
    stop: () => clearInterval(timer),
  };
}

function stageFixturePrefix(runId) {
  return `e2e_sse_load_${runId}_`;
}

function sqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

async function loginAll(config, credentials, signal) {
  return Promise.all(credentials.map(async (credential) => {
    const { response, consumed: body } = await fetchBounded(`${config.backendUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: credential.username, password: credential.password }),
    }, signal, 10000, async (loginResponse) => (
      loginResponse.ok ? loginResponse.json() : loginResponse.arrayBuffer().then(() => null)
    ));
    if (!response.ok) throw new Error(`Load login failed: HTTP ${response.status}`);
    if (!body.accessToken) throw new Error('Load login returned no access token');
    return { accessToken: body.accessToken, orderId: credential.orderId };
  }));
}

async function openRound(config, identities, parentSignal, activeConnections) {
  return openAssignmentRange(
    config,
    createConnectionAssignments(config, identities),
    parentSignal,
    activeConnections,
  );
}

function createConnectionAssignments(config, identities) {
  const assignments = [];
  for (const identity of identities) {
    for (let index = 0; index < config.connectionsPerUser && assignments.length < config.clients; index += 1) {
      assignments.push(identity);
    }
  }
  if (assignments.length !== config.clients) {
    throw new Error(`Identity capacity is lower than requested client count: ${assignments.length}/${config.clients}`);
  }
  return assignments;
}

async function openAssignmentRange(config, assignments, parentSignal, activeConnections) {
  const connections = [];
  for (let offset = 0; offset < assignments.length; offset += config.openBatchSize) {
    const batch = assignments.slice(offset, offset + config.openBatchSize);
    const opened = await Promise.all(batch.map(async (identity) => {
      const connection = await openConnection(config, identity, parentSignal);
      activeConnections.add(connection);
      return connection;
    }));
    connections.push(...opened);
    if (connections.length < assignments.length) await delay(config.openBatchDelayMs, parentSignal);
  }
  return connections;
}

async function openConnection(config, identity, parentSignal) {
  const startedAt = Date.now();
  const headers = { authorization: `Bearer ${identity.accessToken}` };
  const { response: snapshot } = await fetchBounded(`${config.backendUrl}/orders/${identity.orderId}/detail-live-state`, {
    headers: { ...headers, accept: 'application/json' },
  }, parentSignal, 10000, (snapshotResponse) => snapshotResponse.arrayBuffer());
  if (snapshot.status !== 200 || snapshot.headers.get('x-erp-realtime-enabled') !== 'true') {
    throw new Error(`Load snapshot failed: HTTP ${snapshot.status}`);
  }
  const cursor = snapshot.headers.get('x-erp-stream-cursor');
  const snapshotEtag = snapshot.headers.get('etag');
  if (!cursor || !snapshotEtag) throw new Error('Load snapshot returned no cursor or ETag');

  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  let response;
  const handshakeTimeout = setTimeout(
    () => controller.abort(new Error('SSE handshake timeout after 15000ms')),
    15000,
  );
  handshakeTimeout.unref?.();
  try {
    response = await fetch(`${config.backendUrl}/orders/${identity.orderId}/live-events`, {
      headers: { ...headers, accept: 'text/event-stream', 'last-event-id': cursor },
      signal: controller.signal,
    });
    if (response.status !== 200 || !String(response.headers.get('content-type')).includes('text/event-stream')) {
      throw new Error(`Load SSE open failed: HTTP ${response.status}`);
    }
  } catch (error) {
    controller.abort();
    parentSignal.removeEventListener('abort', abort);
    if (response?.body) await response.body.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(handshakeTimeout);
  }
  const metrics = {
    heartbeats: 0,
    invalidations: 0,
    invalidFrames: 0,
    lastInvalidation: null,
    lastInvalidationAt: 0,
    openLatencyMs: Date.now() - startedAt,
    unexpectedDisconnect: false,
  };
  const reader = consumeStream(response.body, controller.signal, metrics)
    .finally(() => parentSignal.removeEventListener('abort', abort));
  reader.then(
    () => { if (!controller.signal.aborted) metrics.unexpectedDisconnect = true; },
    () => { if (!controller.signal.aborted) metrics.unexpectedDisconnect = true; },
  );
  reader.catch(() => undefined);
  return {
    controller,
    reader,
    metrics,
    identity,
    snapshotEtag,
    initialCursor: cursor,
  };
}

async function closeRoundConnections(connections, activeConnections) {
  for (const connection of connections) connection.controller.abort();
  const results = await Promise.allSettled(connections.map((connection) => connection.reader));
  for (const connection of connections) activeConnections.delete(connection);
  return {
    opened: connections.length,
    unexpectedDisconnects: connections.filter((connection) => connection.metrics.unexpectedDisconnect).length +
      results.filter((result) => result.status === 'rejected').length,
    heartbeatCount: connections.reduce((sum, connection) => sum + connection.metrics.heartbeats, 0),
    connectionsWithoutHeartbeat: connections.filter((connection) => connection.metrics.heartbeats === 0).length,
  };
}

async function fetchBounded(url, init, parentSignal, timeoutMs, consume) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error(`Request timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timeout.unref?.();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const consumed = await consume(response);
    return { response, consumed };
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', abort);
  }
}

async function consumeStream(body, signal, metrics) {
  if (!body) throw new Error('Load SSE response body is missing');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let remainder = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done && !signal.aborted) throw new Error('Isolated SSE stream ended unexpectedly');
      if (value) {
        const parsed = consumeSseLoadChunk(remainder, decoder.decode(value, { stream: true }));
        remainder = parsed.remainder;
        metrics.heartbeats += parsed.heartbeats;
        metrics.invalidFrames += parsed.invalidFrames;
        metrics.invalidations += parsed.invalidations.length;
        if (parsed.invalidations.length > 0) {
          metrics.lastInvalidation = parsed.invalidations.at(-1);
          metrics.lastInvalidationAt = Date.now();
        }
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function closeConnections(activeConnections, timeoutMs) {
  const pending = [...activeConnections];
  for (const connection of pending) connection.controller.abort();
  let timedOut = false;
  if (pending.length > 0) {
    let timeout;
    try {
      await Promise.race([
        Promise.allSettled(pending.map((connection) => connection.reader)),
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!timedOut) {
    for (const connection of pending) activeConnections.delete(connection);
  }
  return {
    aborted: true,
    tracked: pending.length,
    remaining: activeConnections.size,
    timedOut,
  };
}

function delay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), milliseconds);
    const abort = () => {
      clearTimeout(timer);
      finish(() => reject(signal.reason || new Error('Load aborted')));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function printUsage() {
  process.stdout.write([
    'Order SSE connection load generator.',
    '',
    'Isolated mode: --target-env isolated-load --backend-url <url> --credential-file <0600-json> --log-root <dir>',
    'Isolated approval: ORDER_SSE_LOAD_APPROVE_ISOLATED=true',
    'Shared-stage mode is accepted only through scripts/order-sse-stage-load-guarded.sh.',
    'Shared-stage shape: 200 clients, 3/user, ramp 25,50,100,200, at least two rounds.',
    'Production and non-canonical shared targets remain hard-denied.',
  ].join('\n') + '\n');
}

function percentile(values, percentileValue) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  cleanupStageFixtures,
  provisionStageFixtures,
};
