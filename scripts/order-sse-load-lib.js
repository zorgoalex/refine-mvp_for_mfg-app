const { existsSync, readFileSync, statSync } = require('node:fs');
const { lookup } = require('node:dns').promises;
const os = require('node:os');
const path = require('node:path');

const SHARED_RUNNER_HOSTNAME = 'vps-01fca05c';
const SHARED_RUNNER_MARKER = '/home/ovhtest/projects/erp_dev/.shared-host-no-sse-load';
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
      case '--help':
      case '-h': result.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
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
  SHARED_TARGET_ADDRESSES,
  SHARED_TARGET_HOSTS,
  assertIsolatedLoadAllowed,
  assertIsolatedTargetResolution,
  consumeSseCommentChunk,
  parseOrderSseLoadArgs,
  readLoadCredentials,
};
