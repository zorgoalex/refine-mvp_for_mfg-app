const { existsSync, readFileSync, statSync } = require('node:fs');
const { lookup } = require('node:dns').promises;
const os = require('node:os');
const path = require('node:path');

const SHARED_RUNNER_HOSTNAME = 'vps-01fca05c';
const SHARED_RUNNER_MARKER = '/home/ovhtest/projects/erp_dev/.shared-host-no-sse-load';
const SHARED_STAGE_TARGET_HOST = 'backend-test.mebelkz.app';
const SHARED_STAGE_TARGET_ENV = 'shared-stage';
const SHARED_STAGE_REQUIRED_CLIENTS = 200;
const SHARED_STAGE_CONNECTIONS_PER_USER = 3;
const SHARED_STAGE_RAMP_CLIENTS = [25, 50, 100, 200];
const SHARED_STAGE_MIN_RECONNECT_ROUNDS = 2;
const SHARED_STAGE_MIN_FINAL_HOLD_SECONDS = 180;
const SHARED_STAGE_MIN_STEP_HOLD_SECONDS = 30;
const SHARED_STAGE_RESERVED_CPU = 3;
const SHARED_STAGE_RESERVED_CPU_MAX_BUSY_PERCENT = 50;
const SHARED_STAGE_SATURATED_CPU_PERCENT = 85;
const SHARED_STAGE_MAX_SATURATED_CPUS = 2;
const IMMUTABLE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,79}$/;
const SHARED_TARGET_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '135.125.181.241',
]);
const SHARED_TARGET_ADDRESSES = new Set([
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  '135.125.181.241',
]);

function parseOrderSseLoadArgs(rawArgs) {
  const result = {
    targetEnv: '',
    backendUrl: '',
    credentialFile: '',
    logRoot: '',
    clients: 200,
    connectionsPerUser: 20,
    reconnectRounds: 3,
    roundSeconds: 600,
    openBatchSize: 10,
    openBatchDelayMs: 100,
    rampClients: [...SHARED_STAGE_RAMP_CLIENTS],
    stageStepSeconds: 45,
    expectedStageSha: '',
    expectedBackendSha: '',
    runId: '',
    cleanupRunId: '',
    seedUserId: 83,
    orderId: 0,
    preflightOnly: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const [name, inlineValue] = arg.startsWith('--') && arg.includes('=')
      ? arg.split(/=(.*)/s, 2)
      : [arg, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const value = rawArgs[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      index += 1;
      return value;
    };
    switch (name) {
      case '--target-env': result.targetEnv = readValue(); break;
      case '--backend-url': result.backendUrl = normalizeBaseUrl(readValue()); break;
      case '--credential-file': result.credentialFile = path.resolve(readValue()); break;
      case '--log-root': result.logRoot = path.resolve(readValue()); break;
      case '--clients': result.clients = parseInteger(readValue(), name, 1, 2000); break;
      case '--connections-per-user': result.connectionsPerUser = parseInteger(readValue(), name, 1, 20); break;
      case '--reconnect-rounds': result.reconnectRounds = parseInteger(readValue(), name, 1, 20); break;
      case '--round-seconds': result.roundSeconds = parseInteger(readValue(), name, 30, 3600); break;
      case '--open-batch-size': result.openBatchSize = parseInteger(readValue(), name, 1, 100); break;
      case '--open-batch-delay-ms': result.openBatchDelayMs = parseInteger(readValue(), name, 0, 10000); break;
      case '--ramp-clients': result.rampClients = parseRampClients(readValue()); break;
      case '--stage-step-seconds': result.stageStepSeconds = parseInteger(readValue(), name, 30, 600); break;
      case '--expected-stage-sha': result.expectedStageSha = parseImmutableSha(readValue(), name); break;
      case '--expected-backend-sha': result.expectedBackendSha = parseImmutableSha(readValue(), name); break;
      case '--run-id': result.runId = parseRunId(readValue(), name); break;
      case '--cleanup-run-id': result.cleanupRunId = parseRunId(readValue(), name); break;
      case '--seed-user-id': result.seedUserId = parseInteger(readValue(), name, 1, 2147483647); break;
      case '--order-id': result.orderId = parseInteger(readValue(), name, 1, Number.MAX_SAFE_INTEGER); break;
      case '--preflight-only': result.preflightOnly = true; break;
      case '--help':
      case '-h': result.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function assertSharedStageLoadAllowed(config, env = process.env, runner = defaultRunnerIdentity()) {
  if (config.targetEnv !== SHARED_STAGE_TARGET_ENV) {
    throw new Error(`target-env must be ${SHARED_STAGE_TARGET_ENV}`);
  }
  if (env.ORDER_SSE_LOAD_APPROVE_SHARED_STAGE !== 'true') {
    throw new Error('ORDER_SSE_LOAD_APPROVE_SHARED_STAGE=true is required');
  }
  if (runner.hostname !== SHARED_RUNNER_HOSTNAME || !runner.sharedMarkerPresent) {
    throw new Error('Shared-stage load must run on the guarded ERP shared host');
  }
  if (
    !config.backendUrl ||
    !config.logRoot ||
    !config.expectedStageSha ||
    !config.expectedBackendSha ||
    !config.runId ||
    !config.orderId
  ) {
    throw new Error(
      '--backend-url, --log-root, --expected-stage-sha, --expected-backend-sha, --run-id and --order-id are required',
    );
  }
  const url = new URL(config.backendUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== SHARED_STAGE_TARGET_HOST ||
    normalizeApiPath(url.pathname) !== '/api/v1'
  ) {
    throw new Error(`Shared-stage load target must be https://${SHARED_STAGE_TARGET_HOST}/api/v1`);
  }
  if (config.clients !== SHARED_STAGE_REQUIRED_CLIENTS) {
    throw new Error(`Shared-stage gate requires exactly ${SHARED_STAGE_REQUIRED_CLIENTS} clients`);
  }
  if (config.connectionsPerUser !== SHARED_STAGE_CONNECTIONS_PER_USER) {
    throw new Error(`Shared-stage gate requires exactly ${SHARED_STAGE_CONNECTIONS_PER_USER} connections per user`);
  }
  if (config.reconnectRounds < SHARED_STAGE_MIN_RECONNECT_ROUNDS) {
    throw new Error(`Shared-stage gate requires at least ${SHARED_STAGE_MIN_RECONNECT_ROUNDS} reconnect rounds`);
  }
  if (config.roundSeconds < SHARED_STAGE_MIN_FINAL_HOLD_SECONDS) {
    throw new Error(`Shared-stage final hold must be at least ${SHARED_STAGE_MIN_FINAL_HOLD_SECONDS} seconds`);
  }
  if (config.stageStepSeconds < SHARED_STAGE_MIN_STEP_HOLD_SECONDS) {
    throw new Error(`Shared-stage ramp hold must be at least ${SHARED_STAGE_MIN_STEP_HOLD_SECONDS} seconds`);
  }
  if (!sameIntegerArray(config.rampClients, SHARED_STAGE_RAMP_CLIENTS)) {
    throw new Error(`Shared-stage ramp must be ${SHARED_STAGE_RAMP_CLIENTS.join(',')}`);
  }
}

function assertSharedStageCleanupAllowed(config, env = process.env, runner = defaultRunnerIdentity()) {
  if (config.targetEnv !== SHARED_STAGE_TARGET_ENV || !config.cleanupRunId) {
    throw new Error(`Cleanup requires --target-env ${SHARED_STAGE_TARGET_ENV} and --cleanup-run-id`);
  }
  if (env.ORDER_SSE_LOAD_APPROVE_SHARED_STAGE !== 'true') {
    throw new Error('ORDER_SSE_LOAD_APPROVE_SHARED_STAGE=true is required');
  }
  if (runner.hostname !== SHARED_RUNNER_HOSTNAME || !runner.sharedMarkerPresent) {
    throw new Error('Shared-stage cleanup must run on the ERP shared host');
  }
}

async function assertSharedStageTargetResolution(config, lookupHost = lookup) {
  const hostname = new URL(config.backendUrl).hostname.toLowerCase();
  const records = await lookupHost(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`Shared-stage target resolved no addresses: ${hostname}`);
  }
  for (const record of records) {
    const address = normalizeAddress(record?.address);
    if (!SHARED_TARGET_ADDRESSES.has(address)) {
      throw new Error(`Shared-stage target resolves outside the ERP shared host: ${address}`);
    }
  }
}

function assertIsolatedLoadAllowed(config, env = process.env, runner = defaultRunnerIdentity()) {
  if (config.targetEnv !== 'isolated-load') {
    throw new Error('target-env must be isolated-load');
  }
  if (env.ORDER_SSE_LOAD_APPROVE_ISOLATED !== 'true') {
    throw new Error('ORDER_SSE_LOAD_APPROVE_ISOLATED=true is required');
  }
  if (runner.hostname === SHARED_RUNNER_HOSTNAME || runner.sharedMarkerPresent) {
    throw new Error('200-client Order SSE load is forbidden on the ERP shared host');
  }
  if (!config.backendUrl || !config.credentialFile || !config.logRoot) {
    throw new Error('--backend-url, --credential-file and --log-root are required');
  }
  const url = new URL(config.backendUrl);
  const hostname = url.hostname.toLowerCase();
  if (SHARED_TARGET_HOSTS.has(hostname) || hostname === 'mebelkz.app' || hostname.endsWith('.mebelkz.app')) {
    throw new Error(`Shared/stage/production target is forbidden: ${hostname}`);
  }
  if (url.protocol !== 'https:' && env.ORDER_SSE_LOAD_ALLOW_PRIVATE_HTTP !== 'true') {
    throw new Error('Isolated load target must use HTTPS unless private HTTP is explicitly approved');
  }
}

async function assertIsolatedTargetResolution(config, lookupHost = lookup) {
  const hostname = new URL(config.backendUrl).hostname.toLowerCase();
  const records = await lookupHost(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`Isolated load target resolved no addresses: ${hostname}`);
  }
  for (const record of records) {
    const address = normalizeAddress(record?.address);
    if (SHARED_TARGET_ADDRESSES.has(address)) {
      throw new Error(`Isolated load target resolves to a forbidden shared address: ${address}`);
    }
  }
}

function readLoadCredentials(config) {
  const stats = statSync(config.credentialFile);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error('Credential file must not be readable by group or other users');
  }
  const credentials = JSON.parse(readFileSync(config.credentialFile, 'utf8'));
  if (!Array.isArray(credentials) || credentials.length === 0) {
    throw new Error('Credential file must contain a non-empty JSON array');
  }
  const normalized = credentials.map((entry, index) => {
    const username = String(entry?.username || '').trim();
    const password = String(entry?.password || '');
    const orderId = Number(entry?.orderId);
    if (!username || !password || !Number.isSafeInteger(orderId) || orderId < 1) {
      throw new Error(`Credential entry ${index + 1} is invalid`);
    }
    return { username, password, orderId };
  });
  const uniqueUsernames = new Set(normalized.map((entry) => entry.username.toLowerCase()));
  if (uniqueUsernames.size !== normalized.length) {
    throw new Error('Credential file must contain distinct usernames');
  }
  if (normalized.length * config.connectionsPerUser < config.clients) {
    throw new Error('Credential capacity is lower than requested client count');
  }
  return normalized;
}

function consumeSseCommentChunk(remainder, chunk) {
  const lines = `${remainder}${chunk}`.split('\n');
  const nextRemainder = lines.pop() || '';
  const heartbeats = lines.reduce((count, rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    return count + (line.startsWith(':') ? 1 : 0);
  }, 0);
  return { remainder: nextRemainder, heartbeats };
}

function consumeSseLoadChunk(remainder, chunk) {
  const normalized = `${remainder}${chunk}`.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  const nextRemainder = frames.pop() || '';
  let heartbeats = 0;
  let invalidFrames = 0;
  const invalidations = [];
  for (const frame of frames) {
    const lines = frame.split('\n');
    if (lines.some((line) => line.startsWith(':'))) {
      heartbeats += 1;
      continue;
    }
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
    if (eventName !== 'order.invalidate') continue;
    const id = lines.find((line) => line.startsWith('id:'))?.slice('id:'.length).trim() || '';
    const dataText = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    try {
      const data = JSON.parse(dataText);
      if (!id || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid frame');
      invalidations.push({ id, data });
    } catch {
      invalidFrames += 1;
    }
  }
  return { remainder: nextRemainder, heartbeats, invalidations, invalidFrames };
}

function parseProcStatCpuSnapshot(value) {
  const cpus = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.match(/^cpu(\d+)\s+(.+)$/);
    if (!match) continue;
    const fields = match[2].trim().split(/\s+/).map(Number);
    if (fields.length < 5 || fields.some((field) => !Number.isFinite(field) || field < 0)) {
      throw new Error(`/proc/stat CPU${match[1]} sample is invalid`);
    }
    const total = fields.slice(0, 8).reduce((sum, field) => sum + (field || 0), 0);
    const idle = fields[3] + (fields[4] || 0);
    cpus[Number(match[1])] = { total, idle };
  }
  if (cpus.length !== 4 || cpus.some((cpu) => !cpu)) {
    throw new Error('Shared-stage CPU watchdog requires exactly four online CPUs');
  }
  return cpus;
}

function calculateCpuBusyPercent(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current) || previous.length !== 4 || current.length !== 4) {
    throw new Error('Shared-stage CPU watchdog requires two four-core samples');
  }
  return current.map((cpu, index) => {
    const totalDelta = cpu.total - previous[index].total;
    const idleDelta = cpu.idle - previous[index].idle;
    if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) {
      throw new Error(`Shared-stage CPU${index} delta is invalid`);
    }
    return Math.round((100 - (idleDelta / totalDelta) * 100) * 100) / 100;
  });
}

function evaluateSharedStageCpuSafety(busyPercent) {
  if (!Array.isArray(busyPercent) || busyPercent.length !== 4 || busyPercent.some((value) => !Number.isFinite(value))) {
    throw new Error('Shared-stage CPU busy sample is invalid');
  }
  const reservedCpuBusy = busyPercent[SHARED_STAGE_RESERVED_CPU];
  const saturatedCpuCount = busyPercent.filter((value) => value >= SHARED_STAGE_SATURATED_CPU_PERCENT).length;
  if (reservedCpuBusy > SHARED_STAGE_RESERVED_CPU_MAX_BUSY_PERCENT) {
    return {
      safe: false,
      reason: 'reserved_cpu_busy',
      reservedCpuBusy,
      saturatedCpuCount,
    };
  }
  if (saturatedCpuCount > SHARED_STAGE_MAX_SATURATED_CPUS) {
    return {
      safe: false,
      reason: 'three_or_more_cpus_saturated',
      reservedCpuBusy,
      saturatedCpuCount,
    };
  }
  return { safe: true, reservedCpuBusy, saturatedCpuCount };
}

function defaultRunnerIdentity() {
  return {
    hostname: os.hostname(),
    sharedMarkerPresent: existsSync(SHARED_RUNNER_MARKER),
  };
}

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function parseRampClients(value) {
  const values = String(value).split(',').map((part) => Number(part.trim()));
  if (
    values.length === 0 ||
    values.some((entry) => !Number.isSafeInteger(entry) || entry < 1 || entry > 2000) ||
    values.some((entry, index) => index > 0 && entry <= values[index - 1])
  ) {
    throw new Error('--ramp-clients must be a strictly increasing integer list');
  }
  return values;
}

function parseImmutableSha(value, name) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!IMMUTABLE_SHA_PATTERN.test(normalized)) {
    throw new Error(`${name} must be a 40-character hexadecimal git SHA`);
  }
  return normalized;
}

function parseRunId(value, name) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!RUN_ID_PATTERN.test(normalized)) {
    throw new Error(`${name} must match ${RUN_ID_PATTERN}`);
  }
  return normalized;
}

function normalizeApiPath(value) {
  const normalized = `/${String(value || '').replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

function sameIntegerArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

module.exports = {
  SHARED_RUNNER_HOSTNAME,
  SHARED_RUNNER_MARKER,
  SHARED_STAGE_CONNECTIONS_PER_USER,
  SHARED_STAGE_RAMP_CLIENTS,
  SHARED_STAGE_REQUIRED_CLIENTS,
  SHARED_STAGE_TARGET_ENV,
  SHARED_STAGE_TARGET_HOST,
  SHARED_TARGET_ADDRESSES,
  SHARED_TARGET_HOSTS,
  assertIsolatedLoadAllowed,
  assertIsolatedTargetResolution,
  assertSharedStageCleanupAllowed,
  assertSharedStageLoadAllowed,
  assertSharedStageTargetResolution,
  calculateCpuBusyPercent,
  consumeSseCommentChunk,
  consumeSseLoadChunk,
  evaluateSharedStageCpuSafety,
  parseOrderSseLoadArgs,
  parseProcStatCpuSnapshot,
  readLoadCredentials,
};
