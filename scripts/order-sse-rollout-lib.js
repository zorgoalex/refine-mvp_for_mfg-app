const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdirSync, appendFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const STAGE_FRONTEND_URL = 'https://app-test.mebelkz.app';
const STAGE_BACKEND_ORIGIN = 'https://backend-test.mebelkz.app';
const STAGE_BACKEND_URL = 'https://backend-test.mebelkz.app/api/v1';
const STAGE_DB_CONTAINER = 'erp_test-postgresdb-1';
const STAGE_BACKEND_CONTAINER = 'erp_test-backend-1';
const EXPECTED_CANARY_USER_ID = 83;
const ALLOWED_STEPS = [5, 25, 50, 100];
const CHILD_ABORT_INT_GRACE_MS = 500;
const CHILD_ABORT_TERM_GRACE_MS = 500;
const CHILD_ABORT_KILL_GRACE_MS = 1000;

function parseOrderSseRolloutArgs(rawArgs) {
  const result = {
    mode: 'preflight',
    apply: false,
    targetEnv: 'backend-test',
    frontendUrl: STAGE_FRONTEND_URL,
    backendUrl: STAGE_BACKEND_URL,
    dbContainer: STAGE_DB_CONTAINER,
    backendContainer: STAGE_BACKEND_CONTAINER,
    steps: [...ALLOWED_STEPS],
    samplesPerStep: 3,
    sampleIntervalSeconds: 20,
    cacheWaitSeconds: 6,
    maxEventLatencyMs: 2000,
    orderId: null,
    logRoot: null,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const [inlineName, inlineValue] = arg.startsWith('--') && arg.includes('=')
      ? arg.split(/=(.*)/s, 2)
      : [arg, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const value = rawArgs[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${inlineName} requires a value`);
      index += 1;
      return value;
    };

    switch (inlineName) {
      case '--mode':
        result.mode = readValue();
        break;
      case '--apply':
        result.apply = true;
        break;
      case '--target-env':
        result.targetEnv = readValue();
        break;
      case '--frontend-url':
        result.frontendUrl = normalizeBaseUrl(readValue());
        break;
      case '--backend-url':
        result.backendUrl = normalizeBaseUrl(readValue());
        break;
      case '--db-container':
        result.dbContainer = readValue();
        break;
      case '--backend-container':
        result.backendContainer = readValue();
        break;
      case '--steps':
        result.steps = parseSteps(readValue());
        break;
      case '--samples-per-step':
        result.samplesPerStep = parseInteger(readValue(), inlineName, 1, 120);
        break;
      case '--sample-interval-seconds':
        result.sampleIntervalSeconds = parseInteger(readValue(), inlineName, 1, 3600);
        break;
      case '--cache-wait-seconds':
        result.cacheWaitSeconds = parseInteger(readValue(), inlineName, 5, 120);
        break;
      case '--max-event-latency-ms':
        result.maxEventLatencyMs = parseInteger(readValue(), inlineName, 100, 30000);
        break;
      case '--order-id':
        result.orderId = parseInteger(readValue(), inlineName, 1, Number.MAX_SAFE_INTEGER);
        break;
      case '--log-root':
        result.logRoot = path.resolve(readValue());
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

function resolveOrderSseRolloutConfig(parsed, env = process.env, cwd = process.cwd()) {
  const logRoot = parsed.logRoot || env.ORDER_SSE_ROLLOUT_LOG_ROOT || findDefaultLogRoot(cwd);
  return {
    ...parsed,
    logRoot: path.resolve(logRoot),
    backendOrigin: new URL(parsed.backendUrl).origin,
    username: env.ERP_WORKER_LOGIN || '',
    password: env.ERP_WORKER_PASSWORD || '',
    vercelBypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET || '',
    approveStage: env.ORDER_SSE_ROLLOUT_APPROVE_STAGE === 'true',
    rtkBin: env.ORDER_SSE_RTK_BIN || 'rtk',
  };
}

function assertOrderSseRolloutAllowed(config) {
  if (!['preflight', 'shadow-canary', 'rollout'].includes(config.mode)) {
    throw new Error('mode must be preflight, shadow-canary, or rollout');
  }
  if (config.targetEnv !== 'backend-test') {
    throw new Error('Order SSE rollout controller is stage-only: target-env must be backend-test');
  }
  if (normalizeBaseUrl(config.frontendUrl) !== STAGE_FRONTEND_URL) {
    throw new Error(`Refusing non-stage frontend URL: ${config.frontendUrl}`);
  }
  if (normalizeBaseUrl(config.backendUrl) !== STAGE_BACKEND_URL) {
    throw new Error(`Refusing non-stage backend URL: ${config.backendUrl}`);
  }
  if (config.dbContainer !== STAGE_DB_CONTAINER || config.backendContainer !== STAGE_BACKEND_CONTAINER) {
    throw new Error('Refusing non-stage Docker containers');
  }
  if (!config.username || !config.password) {
    throw new Error('ERP_WORKER_LOGIN and ERP_WORKER_PASSWORD are required');
  }
  if (config.mode !== 'preflight' && (!config.apply || !config.approveStage)) {
    throw new Error('Write canary/rollout requires --apply and ORDER_SSE_ROLLOUT_APPROVE_STAGE=true');
  }
  if (config.mode === 'preflight' && config.apply) {
    throw new Error('--apply is not valid in preflight mode');
  }
  parseSteps(config.steps.join(','));
}

function stableCohort(userId) {
  const digest = createHash('sha256').update(`order-realtime:${String(userId)}`).digest();
  return digest.readUInt32BE(0) % 100;
}

function planRolloutSteps(currentPercent, requestedSteps) {
  if (!Number.isInteger(currentPercent) || currentPercent < 0 || currentPercent > 100) {
    throw new Error(`Invalid current rollout percent: ${currentPercent}`);
  }
  return requestedSteps.filter((step) => step > currentPercent);
}

function assertDatabaseState(state) {
  if (!state || typeof state !== 'object') throw new Error('Stage database preflight returned no state');
  if (String(state.user83?.userId) !== String(EXPECTED_CANARY_USER_ID)) {
    throw new Error('Stage canary user 83 does not exist');
  }
  if (state.user83?.isActive !== true) throw new Error('Stage canary user 83 is inactive');
  if (typeof state.user83?.username !== 'string' || !state.user83.username.trim()) {
    throw new Error('Stage canary user 83 has no username');
  }
  if (!state.streamTablePresent || !state.eventLogPresent || !state.emitFunctionPresent) {
    throw new Error('Order realtime migrations 097/098 are not fully available');
  }

  const writes = normalizeWrites(state.writes);
  if (!writes.enabled) throw new Error('order_realtime.writes is disabled');

  const rollout = normalizeRollout(state.rollout);
  if (!rollout.enabled) throw new Error('order_realtime.rollout is disabled');
  if (rollout.userIds.length !== 1 || rollout.userIds[0] !== String(EXPECTED_CANARY_USER_ID)) {
    throw new Error('order_realtime.rollout explicit cohort must contain only user 83');
  }
  if (![0, ...ALLOWED_STEPS].includes(rollout.rolloutPercent)) {
    throw new Error(`Unsupported current rolloutPercent: ${rollout.rolloutPercent}`);
  }
  if (!Array.isArray(state.activeUserIds) || state.activeUserIds.some((value) => !/^\d+$/.test(String(value)))) {
    throw new Error('Stage active user cohort is invalid');
  }
  return { writes, rollout };
}

function assertRuntimeConfig(runtimeConfig, mode) {
  if (!runtimeConfig || typeof runtimeConfig !== 'object') throw new Error('Runtime config is missing');
  if (normalizeBaseUrl(runtimeConfig.apiUrl || '') !== STAGE_BACKEND_ORIGIN) {
    throw new Error(`Stage runtime apiUrl mismatch: ${runtimeConfig.apiUrl || 'missing'}`);
  }
  if (runtimeConfig.features?.backendAuth !== true || runtimeConfig.features?.backendOrdersRead !== true) {
    throw new Error('Stage runtime config must enable backendAuth and backendOrdersRead');
  }
  const realtimeEnabled = runtimeConfig.features?.orderRealtime === true;
  if (mode === 'rollout' && !realtimeEnabled) {
    throw new Error('Live stage runtime config has features.orderRealtime=false; percentage rollout is blocked');
  }
  return realtimeEnabled;
}

async function runRolloutController(config, dependencies) {
  assertOrderSseRolloutAllowed(config);
  const log = dependencies.log || (() => undefined);
  const signal = dependencies.signal;
  let appliedPercent = null;
  let verifiedPercent = null;
  let attemptedPercent = null;
  let rollback = null;

  const preflight = await dependencies.preflight();
  const { rollout } = assertDatabaseState(preflight.database);
  const runtimeRealtimeEnabled = assertRuntimeConfig(preflight.runtimeConfig, config.mode);
  appliedPercent = rollout.rolloutPercent;

  log('preflight_passed', {
    userId: EXPECTED_CANARY_USER_ID,
    username: preflight.database.user83.username,
    currentPercent: appliedPercent,
    runtimeRealtimeEnabled,
    activeUsers: preflight.database.activeUserIds.length,
    eligibleActiveUsers: countEligibleUsers(preflight.database.activeUserIds, appliedPercent),
    orderId: preflight.orderId,
  });

  if (config.mode === 'preflight') {
    return {
      status: 'preflight_passed',
      mode: config.mode,
      currentPercent: appliedPercent,
      runtimeRealtimeEnabled,
      orderId: preflight.orderId,
    };
  }

  const baselineResult = await dependencies.sample({
    phase: 'baseline',
    percent: appliedPercent,
    sampleNumber: 1,
    orderId: preflight.orderId,
    signal,
  });
  verifiedPercent = appliedPercent;
  log('baseline_verified', {
    percent: verifiedPercent,
    orderId: preflight.orderId,
    eventLatencyMs: baselineResult.eventLatencyMs,
    cursorChanged: baselineResult.cursorChanged,
    logErrorCount: baselineResult.logErrorCount,
  });

  if (config.mode === 'shadow-canary') {
    return {
      status: 'shadow_canary_passed',
      mode: config.mode,
      currentPercent: appliedPercent,
      runtimeRealtimeEnabled,
      orderId: preflight.orderId,
      baseline: baselineResult,
    };
  }

  const plannedSteps = planRolloutSteps(appliedPercent, config.steps);
  try {
    for (const nextPercent of plannedSteps) {
      assertNotAborted(signal);
      attemptedPercent = nextPercent;
      await dependencies.setRolloutPercent(appliedPercent, nextPercent);
      log('rollout_percent_applied', {
        previousPercent: appliedPercent,
        percent: nextPercent,
        eligibleActiveUsers: countEligibleUsers(preflight.database.activeUserIds, nextPercent),
      });
      appliedPercent = nextPercent;
      await dependencies.sleep(config.cacheWaitSeconds * 1000, signal);

      for (let sampleNumber = 1; sampleNumber <= config.samplesPerStep; sampleNumber += 1) {
        assertNotAborted(signal);
        const result = await dependencies.sample({
          phase: 'rollout',
          percent: nextPercent,
          sampleNumber,
          orderId: preflight.orderId,
          signal,
        });
        log('rollout_sample_passed', {
          percent: nextPercent,
          sampleNumber,
          eventLatencyMs: result.eventLatencyMs,
          cursorChanged: result.cursorChanged,
          logErrorCount: result.logErrorCount,
        });
        if (sampleNumber < config.samplesPerStep) {
          await dependencies.sleep(config.sampleIntervalSeconds * 1000, signal);
        }
      }

      verifiedPercent = nextPercent;
      attemptedPercent = nextPercent;
      log('rollout_step_verified', { percent: verifiedPercent });
    }
  } catch (error) {
    if (attemptedPercent !== verifiedPercent && verifiedPercent !== null) {
      try {
        const reconciliation = await dependencies.rollbackRolloutPercent(attemptedPercent, verifiedPercent);
        rollback = {
          status: reconciliation.status,
          fromPercent: attemptedPercent,
          toPercent: verifiedPercent,
        };
        appliedPercent = verifiedPercent;
        log('rollback_completed', rollback);
      } catch (rollbackError) {
        rollback = {
          status: 'failed',
          fromPercent: attemptedPercent,
          toPercent: verifiedPercent,
          error: safeErrorMessage(rollbackError),
        };
        log('rollback_failed', rollback);
      }
    }
    const wrapped = new Error(`Order SSE rollout stopped: ${safeErrorMessage(error)}`);
    wrapped.rollback = rollback;
    throw wrapped;
  }

  return {
    status: 'rollout_passed',
    mode: config.mode,
    initialPercent: rollout.rolloutPercent,
    finalPercent: appliedPercent,
    verifiedPercent,
    runtimeRealtimeEnabled,
    orderId: preflight.orderId,
    baseline: baselineResult,
    steps: plannedSteps,
  };
}

function createStageDependencies(config, logger, signal) {
  let auth = null;
  let runSequence = 0;
  const commonHeaders = () => ({
    Accept: 'application/json',
    ...(config.vercelBypassSecret
      ? { 'x-vercel-protection-bypass': config.vercelBypassSecret }
      : {}),
  });

  const queryDatabaseState = async (commandSignal = signal) => {
    const result = await runPsql(config, databaseStateSql(), commandSignal);
    return parseSingleJsonLine(result.stdout, 'database state');
  };

  const login = async () => {
    const response = await fetchWithTimeout(`${config.backendUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: config.username, password: config.password }),
    }, 10000, signal);
    if (!response.ok) throw new Error(`Stage login failed: HTTP ${response.status}`);
    const body = await response.json();
    if (typeof body.accessToken !== 'string' || !body.accessToken) {
      throw new Error('Stage login returned no access token');
    }
    auth = { accessToken: body.accessToken };
    return auth;
  };

  const authenticatedFetch = async (url, init = {}, timeoutMs = 10000) => {
    if (!auth) await login();
    const execute = () => fetchWithTimeout(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        authorization: `Bearer ${auth.accessToken}`,
      },
    }, timeoutMs, signal);
    let response = await execute();
    if (response.status === 401) {
      await login();
      response = await execute();
    }
    return response;
  };

  const preflight = async () => {
    const database = await queryDatabaseState();
    const runtimeResponse = await fetchWithTimeout(
      `${config.frontendUrl}/runtime-config.json`,
      { headers: commonHeaders(), cache: 'no-store' },
      10000,
      signal,
    );
    if (!runtimeResponse.ok) throw new Error(`Runtime config request failed: HTTP ${runtimeResponse.status}`);
    const runtimeConfig = await runtimeResponse.json();
    await assertBackendHealth(config, signal);
    await login();
    const meResponse = await authenticatedFetch(`${config.backendUrl}/me`);
    if (!meResponse.ok) throw new Error(`Stage /me failed: HTTP ${meResponse.status}`);
    const me = await meResponse.json();
    if (String(me.user?.id) !== String(EXPECTED_CANARY_USER_ID)) {
      throw new Error(`ERP_WORKER_LOGIN resolves to user ${me.user?.id || 'missing'}, expected 83`);
    }
    if (me.user?.username !== database.user83?.username) {
      throw new Error('API/DB identity mismatch for user 83');
    }

    const orderId = config.orderId || await findCanaryOrderId(config, authenticatedFetch);
    logger('identity_verified', {
      userId: EXPECTED_CANARY_USER_ID,
      username: me.user.username,
      roleId: me.user.roleId,
      permissionCount: Array.isArray(me.user.permissions) ? me.user.permissions.length : 0,
      orderId,
    });
    return { database, runtimeConfig, orderId };
  };

  const applyRolloutPercent = async (expectedPercent, nextPercent, commandSignal, label) => {
    if (!config.apply || !config.approveStage) throw new Error('Stage write approval is missing');
    if (![0, ...ALLOWED_STEPS].includes(expectedPercent) || ![0, ...ALLOWED_STEPS].includes(nextPercent)) {
      throw new Error('Unsupported rollout percentage transition');
    }
    const result = await runPsql(
      config,
      rolloutUpdateSql(expectedPercent, nextPercent),
      commandSignal,
    );
    const update = parseSingleJsonLine(result.stdout, label);
    if (update.updated !== true || update.rolloutPercent !== nextPercent) {
      throw new Error(`Rollout CAS failed: expected ${expectedPercent}, target ${nextPercent}`);
    }
  };

  const setRolloutPercent = async (expectedPercent, nextPercent) => {
    await applyRolloutPercent(expectedPercent, nextPercent, signal, 'rollout update');
  };

  const rollbackRolloutPercent = async (expectedCurrentPercent, targetPercent) => {
    const state = await queryDatabaseState(null);
    const current = assertDatabaseState(state).rollout.rolloutPercent;
    if (current === targetPercent) return { status: 'already_verified' };
    if (current !== expectedCurrentPercent) {
      throw new Error(
        `Rollback conflict: DB percent is ${current}, expected ${expectedCurrentPercent} or ${targetPercent}`,
      );
    }
    await applyRolloutPercent(current, targetPercent, null, 'rollback update');
    return { status: 'completed' };
  };

  const sample = async ({ phase, percent, sampleNumber, orderId }) => {
    const startedAt = new Date();
    await assertBackendHealth(config, signal);
    const result = await probeRealtimeTransport({
      config,
      authenticatedFetch,
      orderId,
      emit: async () => {
        runSequence += 1;
        const source = `rollout.canary.${Date.now()}.${process.pid}.${runSequence}`;
        const emitted = await runPsql(config, canaryEmitSql(orderId, source), signal);
        const parsed = parseSingleJsonLine(emitted.stdout, 'canary emission');
        if (parsed.emitted !== true) throw new Error('Synthetic realtime invalidation was not emitted');
        if (parsed.notified !== true) throw new Error('Synthetic realtime invalidation was not notified');
      },
      maxEventLatencyMs: config.maxEventLatencyMs,
      signal,
    });
    const realtimeLogErrors = await readRealtimeLogErrors(config, startedAt.toISOString(), signal);
    if (realtimeLogErrors.length > 0) {
      throw new Error(`Backend realtime errors after ${phase} ${percent}% sample ${sampleNumber}: ${realtimeLogErrors[0]}`);
    }
    return { ...result, logErrorCount: realtimeLogErrors.length };
  };

  return {
    preflight,
    setRolloutPercent,
    rollbackRolloutPercent,
    sample,
    sleep,
    signal,
    log: logger,
  };
}

async function assertBackendHealth(config, signal) {
  const backendOrigin = config.backendOrigin || new URL(config.backendUrl).origin;
  const live = await fetchWithTimeout(`${backendOrigin}/health/live`, {}, 10000, signal);
  if (!live.ok) throw new Error(`Backend live health failed: HTTP ${live.status}`);
  const ready = await fetchWithTimeout(`${backendOrigin}/health/ready`, {}, 10000, signal);
  if (!ready.ok) throw new Error(`Backend ready health failed: HTTP ${ready.status}`);
  const body = await ready.json();
  if (body.status !== 'ready') throw new Error(`Backend readiness is ${body.status || 'unknown'}`);
  if (body.checks?.realtime?.status !== 'ok') {
    throw new Error(`Backend realtime health is ${body.checks?.realtime?.status || 'missing'}`);
  }
}

async function findCanaryOrderId(config, authenticatedFetch) {
  const response = await authenticatedFetch(`${config.backendUrl}/orders?page=1&pageSize=50`);
  if (!response.ok) throw new Error(`Order list request failed: HTTP ${response.status}`);
  const body = await response.json();
  const orders = Array.isArray(body.data) ? body.data : [];
  const selected = orders.find((order) => Number(order.partsCount) > 0) || orders[0];
  const orderId = Number(selected?.orderId);
  if (!Number.isSafeInteger(orderId) || orderId < 1) {
    throw new Error('No order visible to stage canary user 83');
  }
  return orderId;
}

async function probeRealtimeTransport({ config, authenticatedFetch, orderId, emit, maxEventLatencyMs, signal }) {
  const snapshotUrl = `${config.backendUrl}/orders/${orderId}/detail-live-state`;
  const first = await authenticatedFetch(snapshotUrl, { headers: { Accept: 'application/json' } });
  if (first.status !== 200) throw new Error(`Initial realtime snapshot failed: HTTP ${first.status}`);
  if (first.headers.get('x-erp-realtime-enabled') !== 'true') {
    throw new Error('Initial realtime snapshot reports rollout disabled for user 83');
  }
  const etag = first.headers.get('etag');
  const initialCursor = first.headers.get('x-erp-stream-cursor');
  if (!etag || !initialCursor) throw new Error('Initial realtime snapshot omitted ETag or cursor');
  await first.arrayBuffer();

  const streamController = new AbortController();
  const unlinkAbort = linkAbortSignal(signal, streamController);
  let streamResponse;
  try {
    streamResponse = await authenticatedFetch(
      `${config.backendUrl}/orders/${orderId}/live-events`,
      {
        headers: {
          Accept: 'text/event-stream',
          'last-event-id': initialCursor,
        },
        signal: streamController.signal,
      },
      10000,
    );
    if (streamResponse.status !== 200) throw new Error(`SSE open failed: HTTP ${streamResponse.status}`);
    if (!String(streamResponse.headers.get('content-type')).includes('text/event-stream')) {
      throw new Error('SSE response has an invalid content type');
    }

    const eventPromise = readSseEvent(streamResponse.body, 'order.invalidate', maxEventLatencyMs + 3000);
    const emittedAt = Date.now();
    await emit();
    const event = await eventPromise;
    const eventLatencyMs = Date.now() - emittedAt;
    if (eventLatencyMs > maxEventLatencyMs) {
      throw new Error(`SSE event latency ${eventLatencyMs}ms exceeds ${maxEventLatencyMs}ms`);
    }
    if (!event.id || event.id === initialCursor) throw new Error('SSE invalidation cursor did not advance');
    if (Number(event.data?.orderId) !== orderId) throw new Error('SSE invalidation orderId mismatch');
    if (event.data?.cursor !== event.id) throw new Error('SSE invalidation payload cursor mismatch');
    if (!Array.isArray(event.data?.domains) || !event.data.domains.includes('detail_status')) {
      throw new Error('SSE invalidation omitted detail_status domain');
    }

    const converged = await authenticatedFetch(snapshotUrl, {
      headers: { Accept: 'application/json', 'if-none-match': etag },
    });
    if (converged.status !== 304) {
      throw new Error(`Synthetic invalidation convergence expected HTTP 304, received ${converged.status}`);
    }
    const convergedCursor = converged.headers.get('x-erp-stream-cursor');
    if (!convergedCursor || convergedCursor === initialCursor) {
      throw new Error('Convergence snapshot cursor did not advance');
    }
    if (convergedCursor !== event.id) throw new Error('SSE and snapshot cursors did not converge');
    return {
      eventLatencyMs,
      cursorChanged: true,
      snapshotStatus: 304,
    };
  } finally {
    streamController.abort();
    unlinkAbort();
    if (streamResponse?.body) await streamResponse.body.cancel().catch(() => undefined);
  }
}

async function readSseEvent(body, expectedEventName, timeoutMs) {
  if (!body || typeof body.getReader !== 'function') throw new Error('SSE response body is not readable');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let eventId = '';
  let dataLines = [];
  let timeout;

  const readLoop = async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`SSE stream ended before ${expectedEventName}`);
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') {
          if (eventName === expectedEventName) {
            const rawData = dataLines.join('\n');
            let data = null;
            try {
              data = rawData ? JSON.parse(rawData) : null;
            } catch {
              throw new Error(`SSE ${expectedEventName} data is not valid JSON`);
            }
            return { event: eventName, id: eventId, data };
          }
          eventName = '';
          eventId = '';
          dataLines = [];
        } else if (!line.startsWith(':')) {
          const separator = line.indexOf(':');
          const field = separator >= 0 ? line.slice(0, separator) : line;
          let valueText = separator >= 0 ? line.slice(separator + 1) : '';
          if (valueText.startsWith(' ')) valueText = valueText.slice(1);
          if (field === 'event') eventName = valueText;
          if (field === 'id') eventId = valueText;
          if (field === 'data') dataLines.push(valueText);
        }
      }
    }
  };

  try {
    return await Promise.race([
      readLoop(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for SSE ${expectedEventName}`)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
  }
}

async function readRealtimeLogErrors(config, sinceIso, signal) {
  const result = await runCommand(
    config.rtkBin,
    ['docker', 'logs', '--since', sinceIso, config.backendContainer],
    { signal, maxOutputBytes: 1024 * 1024 },
  );
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .filter((line) => /order realtime/i.test(line) && /(fail|error|exception|disconnect|overflow)/i.test(line));
  return [...new Set(lines)].slice(0, 20).map((line) => redactText(line).slice(0, 500));
}

function databaseStateSql() {
  return `
SELECT json_build_object(
  'user83', (
    SELECT json_build_object(
      'userId', user_id,
      'username', username,
      'roleId', role_id,
      'isActive', is_active
    )
    FROM users
    WHERE user_id = ${EXPECTED_CANARY_USER_ID}
  ),
  'rollout', (
    SELECT value_json
    FROM app_settings
    WHERE setting_key = 'order_realtime.rollout' AND is_active = true
  ),
  'writes', (
    SELECT value_json
    FROM app_settings
    WHERE setting_key = 'order_realtime.writes' AND is_active = true
  ),
  'streamTablePresent', to_regclass('public.order_realtime_stream') IS NOT NULL,
  'eventLogPresent', to_regclass('public.realtime_event_log') IS NOT NULL,
  'emitFunctionPresent', to_regprocedure('order_realtime_emit_one(bigint,text[],bigint[],text)') IS NOT NULL,
  'activeUserIds', COALESCE((
    SELECT json_agg(user_id ORDER BY user_id)
    FROM users
    WHERE is_active = true
  ), '[]'::json)
)::text;
`;
}

function rolloutUpdateSql(expectedPercent, nextPercent) {
  return `
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('order-sse-rollout-stage-v1'));
WITH updated AS (
  UPDATE app_settings
  SET value_json = jsonb_set(value_json, '{rolloutPercent}', to_jsonb(${nextPercent}::integer)),
      updated_at = now()
  WHERE setting_key = 'order_realtime.rollout'
    AND is_active = true
    AND value_json = jsonb_build_object(
      'enabled', true,
      'userIds', jsonb_build_array(${EXPECTED_CANARY_USER_ID}),
      'rolloutPercent', ${expectedPercent}
    )
  RETURNING (value_json->>'rolloutPercent')::integer AS rollout_percent
)
SELECT json_build_object(
  'updated', EXISTS (SELECT 1 FROM updated),
  'rolloutPercent', (SELECT rollout_percent FROM updated)
)::text;
COMMIT;
`;
}

function canaryEmitSql(orderId, source) {
  if (!Number.isSafeInteger(orderId) || orderId < 1) throw new Error('Invalid canary orderId');
  const safeSource = String(source).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120);
  return `
WITH emitted AS MATERIALIZED (
  SELECT order_realtime_emit_one(
    ${orderId}::bigint,
    ARRAY['detail_status']::text[],
    NULL::bigint[],
    '${safeSource}'::text
  ) AS ok
), notified AS MATERIALIZED (
  SELECT pg_notify('erp_realtime', '${orderId}:wake')
  FROM emitted
  WHERE ok
)
SELECT json_build_object(
  'emitted', (SELECT ok FROM emitted),
  'notified', EXISTS (SELECT 1 FROM notified)
)::text;
`;
}

async function runPsql(config, sql, signal) {
  return runCommand(config.rtkBin, [
    'docker',
    'exec',
    '-i',
    config.dbContainer,
    'sh',
    '-lc',
    'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-${PG_USER}}" -d "${POSTGRES_DB:-${PG_DB:-erpdb}}"',
  ], { input: sql, signal, maxOutputBytes: 1024 * 1024 });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let aborting = false;
    let abortReason = null;
    const cleanupTimers = [];
    const maxOutputBytes = options.maxOutputBytes || 1024 * 1024;

    const capture = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) > maxOutputBytes) {
        const error = new Error(`Command output exceeded ${maxOutputBytes} bytes`);
        beginAbort(error);
        return current;
      }
      return next;
    };

    child.stdout.on('data', (chunk) => {
      try { stdout = capture(stdout, chunk); } catch (error) { rejectOnce(error); }
    });
    child.stderr.on('data', (chunk) => {
      try { stderr = capture(stderr, chunk); } catch (error) { rejectOnce(error); }
    });
    child.on('error', rejectOnce);
    child.on('close', (code, closeSignal) => {
      clearCleanupTimers();
      if (settled) return;
      settled = true;
      if (aborting) {
        reject(abortReason || new Error(`${command} aborted`));
      } else if (code === 0 || options.allowFailure) {
        resolve({ code, signal: closeSignal, stdout, stderr });
      } else {
        reject(new Error(`${command} exited ${code}: ${redactText(stderr || stdout).trim().slice(0, 1000)}`));
      }
    });

    const abortHandler = () => beginAbort(new Error(`${command} aborted`));
    if (options.signal) {
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener('abort', abortHandler, { once: true });
    }
    child.on('close', () => options.signal?.removeEventListener('abort', abortHandler));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();

    function rejectOnce(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    function beginAbort(reason) {
      if (aborting || settled) return;
      aborting = true;
      abortReason = reason;
      child.kill('SIGINT');
      cleanupTimers.push(setTimeout(() => child.kill('SIGTERM'), CHILD_ABORT_INT_GRACE_MS));
      cleanupTimers.push(setTimeout(
        () => child.kill('SIGKILL'),
        CHILD_ABORT_INT_GRACE_MS + CHILD_ABORT_TERM_GRACE_MS,
      ));
      cleanupTimers.push(setTimeout(() => {
        rejectOnce(new Error(`${command} abort cleanup did not complete within ${
          CHILD_ABORT_INT_GRACE_MS + CHILD_ABORT_TERM_GRACE_MS + CHILD_ABORT_KILL_GRACE_MS
        }ms`));
      }, CHILD_ABORT_INT_GRACE_MS + CHILD_ABORT_TERM_GRACE_MS + CHILD_ABORT_KILL_GRACE_MS));
    }

    function clearCleanupTimers() {
      for (const timer of cleanupTimers) clearTimeout(timer);
    }
  });
}

function createEvidenceLogger(logRoot, mode, now = new Date()) {
  mkdirSync(logRoot, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const basename = `${stamp}-${mode}`;
  const jsonlPath = path.join(logRoot, `${basename}.jsonl`);
  const summaryPath = path.join(logRoot, `${basename}.summary.json`);
  let sequence = 0;
  const log = (event, details = {}) => {
    sequence += 1;
    const record = sanitizeValue({
      sequence,
      at: new Date().toISOString(),
      event,
      ...details,
    });
    appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };
  const writeSummary = (summary) => {
    writeFileSync(summaryPath, `${JSON.stringify(sanitizeValue(summary), null, 2)}\n`, { mode: 0o600 });
  };
  return { log, writeSummary, jsonlPath, summaryPath };
}

function parseSingleJsonLine(output, label) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidate = [...lines].reverse().find((line) => line.startsWith('{') && line.endsWith('}'));
  if (!candidate) throw new Error(`${label} returned no JSON result`);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function normalizeRollout(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid order_realtime.rollout setting');
  }
  const userIds = Array.isArray(value.userIds) ? value.userIds.map(String) : [];
  if (typeof value.enabled !== 'boolean' || !Number.isInteger(value.rolloutPercent)) {
    throw new Error('Invalid order_realtime.rollout setting');
  }
  return { enabled: value.enabled, userIds, rolloutPercent: value.rolloutPercent };
}

function normalizeWrites(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid order_realtime.writes setting');
  }
  if (
    typeof value.enabled !== 'boolean' ||
    !Number.isInteger(value.maxFanoutOrders) ||
    value.maxFanoutOrders < 1 ||
    value.maxFanoutOrders > 100000 ||
    !Number.isInteger(value.maxDetailIds) ||
    value.maxDetailIds < 1 ||
    value.maxDetailIds > 10000
  ) {
    throw new Error('Invalid order_realtime.writes setting');
  }
  return value;
}

function countEligibleUsers(userIds, percent, explicitUserIds = [EXPECTED_CANARY_USER_ID]) {
  const explicit = new Set(explicitUserIds.map(String));
  if (percent === 100) return userIds.length;
  return userIds.filter((userId) => explicit.has(String(userId)) || stableCohort(userId) < percent).length;
}

function parseSteps(value) {
  const steps = Array.isArray(value)
    ? value
    : String(value).split(',').map((part) => Number(part.trim()));
  if (
    steps.length === 0 ||
    steps.some((step) => !ALLOWED_STEPS.includes(step)) ||
    new Set(steps).size !== steps.length ||
    steps.some((step, index) => index > 0 && step <= steps[index - 1])
  ) {
    throw new Error('steps must be a strictly increasing subset of 5,25,50,100');
  }
  return steps;
}

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function findDefaultLogRoot(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    const candidate = path.join(current, 'spec_erp', 'logs', 'order-sse-rollout');
    try {
      const fs = require('node:fs');
      if (fs.existsSync(path.join(current, 'spec_erp'))) return candidate;
    } catch {
      // Continue walking to a parent with the project spec directory.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Cannot locate spec_erp; pass --log-root explicitly');
}

function sleep(milliseconds, signal) {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), milliseconds);
    const abort = () => {
      clearTimeout(timer);
      finish(() => reject(new Error('Rollout aborted')));
    };
    if (signal) signal.addEventListener('abort', abort, { once: true });
  });
}

async function fetchWithTimeout(url, init, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const unlinkParent = linkAbortSignal(parentSignal, controller);
  const unlinkRequest = linkAbortSignal(init?.signal, controller);
  const timeout = setTimeout(() => controller.abort(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
  timeout.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Request failed or timed out: ${url}`);
    throw error;
  } finally {
    clearTimeout(timeout);
    unlinkParent();
    unlinkRequest();
  }
}

function linkAbortSignal(parentSignal, controller) {
  if (!parentSignal) return () => undefined;
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  return () => parentSignal.removeEventListener('abort', abort);
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new Error('Rollout aborted');
}

function sanitizeValue(value, key = '') {
  if (/(password|token|authorization|cookie|secret)/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeValue(childValue, childKey),
    ]));
  }
  return typeof value === 'string' ? redactText(value) : value;
}

function redactText(value) {
  return String(value)
    .replace(/\bAuthorization\s*:\s*[^\r\n]*/gi, 'Authorization: [REDACTED]')
    .replace(/\bCookie\s*:\s*[^\r\n]*/gi, 'Cookie: [REDACTED]')
    .replace(/\bSet-Cookie\s*:\s*[^\r\n]*/gi, 'Set-Cookie: [REDACTED]')
    .replace(/\bx-vercel-protection-bypass\s*:\s*[^\r\n]*/gi, 'x-vercel-protection-bypass: [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:["']?(?:password|passphrase|access[_-]?token|refresh[_-]?token|token|secret|cookie|authorization|x-vercel-protection-bypass)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      '$1[REDACTED]',
    );
}

function safeErrorMessage(error) {
  return redactText(error instanceof Error ? error.message : String(error));
}

module.exports = {
  ALLOWED_STEPS,
  EXPECTED_CANARY_USER_ID,
  STAGE_BACKEND_URL,
  STAGE_BACKEND_ORIGIN,
  STAGE_FRONTEND_URL,
  assertDatabaseState,
  assertOrderSseRolloutAllowed,
  assertRuntimeConfig,
  canaryEmitSql,
  countEligibleUsers,
  createEvidenceLogger,
  createStageDependencies,
  databaseStateSql,
  parseOrderSseRolloutArgs,
  planRolloutSteps,
  probeRealtimeTransport,
  resolveOrderSseRolloutConfig,
  rolloutUpdateSql,
  runCommand,
  runRolloutController,
  safeErrorMessage,
  sanitizeValue,
  stableCohort,
};
