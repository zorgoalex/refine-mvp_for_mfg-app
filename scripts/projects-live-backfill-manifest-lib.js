const PROJECT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEADLINE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const ENTITY_TYPES = new Set(['order', 'user', 'employee', 'client', 'workshop', 'deadline_instance']);
const CHUNK_SIZE = 500;

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

module.exports = {
  buildProjectsLiveBackfillPlan,
  parseProjectsLiveBackfillManifest,
  validateProjectsLiveBackfillDryRunResponse,
};
