const PROJECT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEADLINE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const ENTITY_TYPES = new Set(['order', 'user', 'employee', 'client', 'workshop', 'deadline_instance']);
const CHUNK_SIZE = 500;
const DEFAULT_BACKEND_URL = 'https://backend-test.mebelkz.app/api/v1';
const DEFAULT_USERNAME_ENVS = ['PROJECTS_LIVE_BACKFILL_USERNAME', 'CODEX_PLAYWRIGHT_USERNAME'];
const DEFAULT_PASSWORD_ENVS = ['PROJECTS_LIVE_BACKFILL_PASSWORD', 'CODEX_PLAYWRIGHT_PASSWORD'];

function parseProjectsLiveBackfillManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Manifest must be an object');
  }

  const source = requireSource(input.source);
  if (source.type !== 'manual_selected_ids') {
    throw new Error('source.type must be manual_selected_ids; inference is not accepted');
  }

  const manifest = {
    fixtureKey: requireFixtureKey(input.fixtureKey),
    projectId: requireProjectId(input.projectId),
    entityType: requireEntityType(input.entityType),
    relationType: requireSlug(input.relationType, 'relationType'),
    source,
    items: requireItems(input.entityType, input.items),
  };

  return manifest;
}

function buildProjectsLiveBackfillPlan(manifestInput) {
  const manifest = parseProjectsLiveBackfillManifest(manifestInput);
  const chunks = [];
  for (let start = 0; start < manifest.items.length; start += CHUNK_SIZE) {
    const chunkNumber = chunks.length + 1;
    const items = manifest.items.slice(start, start + CHUNK_SIZE);
    chunks.push({
      chunkNumber,
      projectId: manifest.projectId,
      dryRunPayload: buildPayload(manifest, items, 'dry-run', chunkNumber),
      writePayload: buildPayload(manifest, items, 'write', chunkNumber),
    });
  }

  return {
    summary: {
      projectId: manifest.projectId,
      entityType: manifest.entityType,
      itemCount: manifest.items.length,
      chunkCount: chunks.length,
    },
    chunks,
  };
}

function validateProjectsLiveBackfillDryRunResponse(chunk, response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('dry-run response must be an object');
  }
  if (response.mode !== 'dry-run' || response.writeEnabled !== false) {
    throw new Error('Expected a dry-run response with writeEnabled=false');
  }
  const expectedCount = chunk.dryRunPayload.items.length;
  const summary = response.summary ?? {};
  if (response.projectId !== undefined && response.projectId !== chunk.projectId) {
    throw new Error('dry-run response projectId does not match the manifest chunk');
  }
  if (summary.proposed !== expectedCount) {
    throw new Error(`dry-run proposed count must be ${expectedCount}`);
  }
  if (!Array.isArray(response.proposals) || !Array.isArray(response.skipped) || !Array.isArray(response.sampleEvidence)) {
    throw new Error('dry-run response must include proposals, skipped, and sampleEvidence arrays');
  }

  return {
    projectId: response.projectId,
    mode: response.mode,
    proposed: summary.proposed,
    skipped: summary.skipped,
    sampleEvidenceRows: response.sampleEvidence.length,
  };
}

function buildProjectsLiveBackfillProofSql(manifestInput) {
  const plan = buildProjectsLiveBackfillPlan(manifestInput);
  const entityIds = plan.chunks.flatMap((chunk) => chunk.writePayload.items.map((item) => item.entityId));
  const firstWritePayload = plan.chunks[0]?.writePayload;
  const projectId = sqlLiteral(plan.summary.projectId);
  const entityType = sqlLiteral(plan.summary.entityType);
  const entityIdList = entityIds.map(sqlLiteral).join(', ');
  const writeIdempotencyKeys = plan.chunks.map((chunk) => sqlLiteral(chunk.writePayload.idempotencyKey)).join(', ');
  const outboxIdempotencyKeys = plan.chunks
    .map((chunk) => sqlLiteral(`${chunk.writePayload.idempotencyKey}:project_entity_links_changed`))
    .join(', ');

  return {
    summary: {
      projectId: plan.summary.projectId,
      entityType: plan.summary.entityType,
      itemCount: plan.summary.itemCount,
      chunkCount: plan.summary.chunkCount,
      firstWriteIdempotencyKey: firstWritePayload?.idempotencyKey ?? null,
    },
    queries: {
      project:
        `select id, code, name, status, metadata from project_projects where id=${projectId};`,
      links:
        `select id, project_id, entity_type_code, entity_id_text, relation_type, valid_to, metadata ` +
        `from project_entity_links where project_id=${projectId} and entity_type_code=${entityType} ` +
        `and entity_id_text in (${entityIdList}) order by entity_id_text;`,
      activeLinkCount:
        `select count(*) as active_links from project_entity_links where project_id=${projectId} ` +
        `and entity_type_code=${entityType} and entity_id_text in (${entityIdList}) and valid_to is null;`,
      audit:
        `select audit_id, source, entity_type, entity_id, action, created_at from audit_log ` +
        `where source='projects-batch-link' and entity_id=${projectId} order by created_at desc limit 10;`,
      outbox:
        `select outbox_event_id, event_type, aggregate_type, aggregate_id, idempotency_key, status, created_at, processed_at ` +
        `from outbox_events where aggregate_id=${projectId} and idempotency_key in (${outboxIdempotencyKeys}) ` +
        `order by created_at desc;`,
      idempotency:
        `select idempotency_key, command_name, entity_type, entity_id, status, created_at, completed_at ` +
        `from command_idempotency_keys where idempotency_key in (${writeIdempotencyKeys}) order by created_at;`,
      privacyScan:
        `with rows as (` +
        `select metadata_json::text as body from audit_log where source='projects-batch-link' and entity_id=${projectId} ` +
        `union all select payload_json::text from outbox_events where aggregate_id=${projectId} ` +
        `and idempotency_key in (${outboxIdempotencyKeys})` +
        `) select count(*) filter (where body ~* '(authorization|bearer|password|access[_-]?token|refresh[_-]?token|cookie)') ` +
        `as suspect_rows, count(*) as scanned_rows from rows;`,
    },
  };
}

function parseProjectsLiveBackfillRunArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const parsed = {
    manifestPath: undefined,
    mode: undefined,
    backendUrl: DEFAULT_BACKEND_URL,
    targetEnv: undefined,
    approveWrite: false,
    usernameEnv: undefined,
    passwordEnv: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--manifest':
        parsed.manifestPath = requireArgValue(args, index, arg);
        index += 1;
        break;
      case '--mode':
        parsed.mode = requireArgValue(args, index, arg);
        index += 1;
        break;
      case '--backend-url':
        parsed.backendUrl = requireArgValue(args, index, arg);
        index += 1;
        break;
      case '--target-env':
        parsed.targetEnv = requireArgValue(args, index, arg);
        index += 1;
        break;
      case '--approve-write':
        parsed.approveWrite = true;
        break;
      case '--username-env':
        parsed.usernameEnv = requireArgValue(args, index, arg);
        index += 1;
        break;
      case '--password-env':
        parsed.passwordEnv = requireArgValue(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!parsed.manifestPath) throw new Error('--manifest <path> is required');
  if (!parsed.mode) throw new Error('--mode dry-run|write is required');
  if (!['dry-run', 'write'].includes(parsed.mode)) throw new Error('--mode must be dry-run or write');

  return parsed;
}

function resolveProjectsLiveBackfillRunConfig(parsedArgs, env = process.env) {
  const targetEnv = parsedArgs.targetEnv ?? env.PROJECTS_LIVE_BACKFILL_TARGET_ENV;
  const approveWrite = parsedArgs.approveWrite || env.PROJECTS_LIVE_BACKFILL_APPROVE_WRITE === 'true';
  const username = parsedArgs.usernameEnv
    ? readNamedEnv(env, parsedArgs.usernameEnv, '--username-env')
    : readFirstEnv(env, DEFAULT_USERNAME_ENVS, 'PROJECTS_LIVE_BACKFILL_USERNAME or CODEX_PLAYWRIGHT_USERNAME');
  const password = parsedArgs.passwordEnv
    ? readNamedEnv(env, parsedArgs.passwordEnv, '--password-env')
    : readFirstEnv(env, DEFAULT_PASSWORD_ENVS, 'PROJECTS_LIVE_BACKFILL_PASSWORD or CODEX_PLAYWRIGHT_PASSWORD');

  const config = {
    ...parsedArgs,
    backendUrl: trimTrailingSlash(parsedArgs.backendUrl ?? DEFAULT_BACKEND_URL),
    targetEnv: typeof targetEnv === 'string' ? targetEnv.trim() : '',
    approveWrite,
    username,
    password,
  };

  assertProjectsLiveBackfillRunAllowed(config);
  return config;
}

function assertProjectsLiveBackfillRunAllowed(config) {
  if (!config.manifestPath) throw new Error('--manifest <path> is required');
  if (!['dry-run', 'write'].includes(config.mode)) throw new Error('--mode must be dry-run or write');
  if (config.targetEnv !== 'backend-test') {
    throw new Error('PROJECTS_LIVE_BACKFILL_TARGET_ENV=backend-test or --target-env backend-test is required');
  }
  const backendUrl = new URL(config.backendUrl);
  if (/prod|production|live/i.test(backendUrl.hostname)) {
    throw new Error('Refusing Projects live backfill runner against prod/production/live backend host');
  }
  const backendHostname = backendUrl.hostname.replace(/^\[(.*)\]$/, '$1');
  const allowedBackendHosts = new Set(['backend-test.mebelkz.app', 'localhost', '127.0.0.1', '::1']);
  if (!allowedBackendHosts.has(backendHostname)) {
    throw new Error('Refusing Projects live backfill runner against non-backend-test backend host');
  }
  if (config.mode === 'write' && config.approveWrite !== true) {
    throw new Error('write mode requires --approve-write or PROJECTS_LIVE_BACKFILL_APPROVE_WRITE=true');
  }
  if (!config.username) throw new Error('Projects live backfill username is required');
  if (!config.password) throw new Error('Projects live backfill password is required');
}

async function runProjectsLiveBackfill(configInput) {
  const config = {
    ...configInput,
    backendUrl: trimTrailingSlash(configInput.backendUrl ?? DEFAULT_BACKEND_URL),
  };
  assertProjectsLiveBackfillRunAllowed(config);

  const { readFileSync } = require('node:fs');
  const manifest = JSON.parse(readFileSync(config.manifestPath, 'utf8'));
  const plan = buildProjectsLiveBackfillPlan(manifest);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');

  const token = await loginProjectsLiveBackfill(config, fetchImpl);
  const chunks = [];

  for (const chunk of plan.chunks) {
    const payload = config.mode === 'write' ? chunk.writePayload : chunk.dryRunPayload;
    const response = await postProjectsLiveBackfillChunk(config, fetchImpl, token, chunk, payload);
    if (config.mode === 'dry-run') validateProjectsLiveBackfillDryRunResponse(chunk, response.body);
    chunks.push({
      chunkNumber: chunk.chunkNumber,
      status: response.status,
      summary: response.body.summary ?? null,
      auditId: response.body.auditId ?? null,
      outboxEventId: response.body.outboxEventId ?? null,
      requestIdPresent: Boolean(response.body.requestId),
    });
  }

  return {
    mode: config.mode,
    projectId: plan.summary.projectId,
    chunkCount: plan.summary.chunkCount,
    itemCount: plan.summary.itemCount,
    chunks,
  };
}

async function loginProjectsLiveBackfill(config, fetchImpl) {
  const response = await fetchJson(fetchImpl, `${config.backendUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  }, 'login');

  if (!response.body?.accessToken || typeof response.body.accessToken !== 'string') {
    throw new Error('login response did not include an access token');
  }
  return response.body.accessToken;
}

async function postProjectsLiveBackfillChunk(config, fetchImpl, token, chunk, payload) {
  return fetchJson(fetchImpl, `${config.backendUrl}/projects/${chunk.projectId}/batch-link`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  }, `chunk ${chunk.chunkNumber}`);
}

async function fetchJson(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(async () => {
    await response.text().catch(() => '');
    return null;
  });
  if (!response.ok) {
    throw new Error(`Projects live backfill ${label} failed with HTTP ${response.status}`);
  }
  return { status: response.status, body };
}

function requireArgValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function readNamedEnv(env, envName, label) {
  const key = requireEnvName(envName, label);
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} ${key} is not set`);
  }
  return value;
}

function readFirstEnv(env, envNames, label) {
  for (const envName of envNames) {
    const value = env[envName];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new Error(`${label} is required`);
}

function requireEnvName(value, label) {
  if (typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be an environment variable name`);
  }
  return value;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function buildPayload(manifest, items, mode, chunkNumber) {
  const payload = {
    mode,
    fixtureKey: manifest.fixtureKey,
    idempotencyKey: buildIdempotencyKey(manifest, mode, chunkNumber),
    entityType: manifest.entityType,
    relationType: manifest.relationType,
    source: manifest.source,
    items,
  };

  if (mode === 'write') {
    payload.writeIntent = 'explicit-selected-ids';
  }

  return payload;
}

function buildIdempotencyKey(manifest, mode, chunkNumber) {
  const dateToken = manifest.fixtureKey.replace(/^projects-live-backfill-/, '');
  const paddedChunk = String(chunkNumber).padStart(3, '0');
  return `projects-live-backfill-${mode}-${dateToken}-project-${manifest.projectId}-chunk-${paddedChunk}`;
}

function requireFixtureKey(value) {
  const fixtureKey = requireSlug(value, 'fixtureKey');
  if (!fixtureKey.startsWith('projects-live-backfill-')) {
    throw new Error('fixtureKey must start with projects-live-backfill-');
  }
  return fixtureKey;
}

function requireSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('source must be an object');
  }

  return {
    type: requireSlug(value.type, 'source.type'),
    reference: requireText(value.reference, 'source.reference', 200),
  };
}

function requireItems(entityTypeInput, value) {
  const entityType = requireEntityType(entityTypeInput);
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Manifest must contain at least one selected item');
  }

  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`items[${index}] must be an object`);
    }
    const entityId = requireText(item.entityId, `items[${index}].entityId`, 200);
    if (!isValidEntityId(entityType, entityId)) {
      throw new Error(`items[${index}].entityId is invalid for ${entityType}`);
    }
    return {
      entityId,
      reason: requireText(item.reason, `items[${index}].reason`, 500),
      confidence: requireManualConfidence(item.confidence, index),
      ...(item.sourceRow == null ? {} : { sourceRow: requireText(item.sourceRow, `items[${index}].sourceRow`, 200) }),
    };
  });
}

function requireManualConfidence(value, index) {
  const confidence = requireText(value, `items[${index}].confidence`, 100);
  if (confidence !== 'manual') {
    throw new Error(`items[${index}].confidence must be manual`);
  }
  return confidence;
}

function requireProjectId(value) {
  const projectId = requireText(value, 'projectId', 36);
  if (!PROJECT_UUID_PATTERN.test(projectId)) {
    throw new Error('projectId must be an explicit UUID');
  }
  return projectId;
}

function requireEntityType(value) {
  const entityType = requireText(value, 'entityType', 100);
  if (!ENTITY_TYPES.has(entityType)) {
    throw new Error(`entityType must be one of ${[...ENTITY_TYPES].join(', ')}`);
  }
  return entityType;
}

function requireSlug(value, fieldName) {
  const text = requireText(value, fieldName, 200);
  if (!/^[a-z][a-z0-9_:-]{0,199}$/.test(text)) {
    throw new Error(`${fieldName} must be a lowercase slug`);
  }
  return text;
}

function requireText(value, fieldName, maxLength) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength) {
    throw new Error(`${fieldName} must be 1-${maxLength} characters`);
  }
  return text;
}

function isValidEntityId(entityType, entityId) {
  if (entityType === 'deadline_instance') {
    return DEADLINE_UUID_PATTERN.test(entityId);
  }
  return POSITIVE_INTEGER_PATTERN.test(entityId);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

module.exports = {
  buildProjectsLiveBackfillProofSql,
  buildProjectsLiveBackfillPlan,
  parseProjectsLiveBackfillRunArgs,
  parseProjectsLiveBackfillManifest,
  resolveProjectsLiveBackfillRunConfig,
  assertProjectsLiveBackfillRunAllowed,
  runProjectsLiveBackfill,
  validateProjectsLiveBackfillDryRunResponse,
};
