import { z } from 'zod';

/** ETL intake limits agreed with the agent (plan §6.5, agent to-erp/0003). */
export const ONEC_ETL_LIMITS = {
  maxCompressedBytes: 100 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxRows: 1_000_000,
  maxLineBytes: 8 * 1024 * 1024,
  /** Concurrent uploads: one per agent, two per backend process. */
  uploadsPerAgent: 1,
  uploadsPerBackend: 2,
  /** Rows per staging insert transaction. */
  parseChunkRows: 1000,
  /** complete waits this long for parsing before 503 RUN_NOT_READY. */
  completeWaitMs: 25_000,
  reservationHeartbeatMs: 10_000,
  reservationStaleMs: 10 * 60_000,
  parseStaleMs: 10 * 60_000,
  maxParseAttempts: 3,
  abandonRunAfterMs: 24 * 60 * 60_000,
  spoolRetentionMs: 7 * 24 * 60 * 60_000,
  orphanFileAgeMs: 60 * 60_000,
  journalRetentionDays: 90,
} as const;

export const ETL_COMMAND_TYPES = ['start_full_sync', 'reload_entity'] as const;

const uuid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
  .transform((value) => value.toLowerCase());
const entityCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const intHeader = (min: number, max: number) =>
  z
    .string()
    .regex(/^[0-9]{1,10}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

/** `1c-identity:v1:{databaseId}:{exportEpoch}:{test|production}` (agent to-erp/0002). */
export const SOURCE_NAMESPACE_PATTERN = /^1c-identity:v1:[0-9a-f-]{36}:[0-9a-f-]{36}:(test|production)$/;
const generationToken = z.string().regex(/^[!-~]{1,128}$/);

export const batchHeadersSchema = z.object({
  'idempotency-key': uuid,
  'x-batch-id': uuid,
  'x-run-id': uuid,
  'x-entity': entityCode,
  'x-schema-version': intHeader(1, 1000),
  'x-row-count': intHeader(0, ONEC_ETL_LIMITS.maxRows),
  'x-content-sha256': z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'base64 SHA-256'),
  'content-encoding': z.literal('gzip'),
  // The limit itself is checked before parsing headers (413, not 400).
  'content-length': intHeader(1, 4_000_000_000).optional(),
  'x-source-namespace': z.string().regex(SOURCE_NAMESPACE_PATTERN).optional(),
  'x-source-generation': generationToken.optional(),
});
export type BatchHeaders = z.infer<typeof batchHeadersSchema>;

export function sourceNamespaceOf(identity: { databaseId: string; exportEpoch: string; environment: string }): string {
  return `1c-identity:v1:${identity.databaseId}:${identity.exportEpoch}:${identity.environment}`;
}

// ---------------------------------------------------------------- complete (spec §7.2, agent OpenAPI 1.3.0)

const int64 = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const isoDate = z.string().datetime({ offset: true });
const errorText = z.string().max(4096).nullable();

const entityV2 = z
  .object({
    entity: entityCode,
    status: z.enum(['done', 'failed']),
    readScope: z.enum(['full', 'delta']),
    rowsRead: int64,
    batchesCreated: int64,
    errorCode: errorText,
    errorMessage: errorText,
    completeness: z.enum(['verified', 'unverified', 'not_checked']).optional(),
    completenessReason: z.string().max(64).nullable().optional(),
    snapshotAtUtc: isoDate.optional(),
  })
  .strict();

const entityPartialV1 = z
  .object({
    entity: entityCode,
    status: z.enum(['done', 'failed']),
    rowsRead: int64,
    batchesCreated: int64,
    errorCode: errorText,
    errorMessage: errorText,
  })
  .strict();

const identity = z
  .object({ databaseId: z.string().max(128), exportEpoch: z.string().max(128), environment: z.string().max(32) })
  .strict();

const completionV2 = z
  .object({
    runId: uuid,
    status: z.enum(['succeeded', 'partial_success']),
    mode: z.enum(['bootstrap_full', 'entity_reload', 'incremental']),
    sourceIdentity: identity.optional(),
    sourceGeneration: generationToken.optional(),
    rowsRead: int64,
    batchesCreated: int64,
    batchesAcknowledged: int64,
    completedAtUtc: isoDate,
    entitiesFailed: int64,
    entities: z.array(entityV2).max(256),
  })
  .strict();

const completionPartialV1 = z
  .object({
    runId: uuid,
    status: z.literal('partial_success'),
    rowsRead: int64,
    batchesCreated: int64,
    batchesAcknowledged: int64,
    completedAtUtc: isoDate,
    entitiesFailed: int64,
    entities: z.array(entityPartialV1).max(256),
  })
  .strict();

const completionV1 = z
  .object({
    runId: uuid,
    status: z.literal('succeeded'),
    rowsRead: int64,
    batchesCreated: int64,
    batchesAcknowledged: int64,
    completedAtUtc: isoDate,
  })
  .strict();

export type EtlMode = 'bootstrap_full' | 'entity_reload' | 'incremental';

export interface CompletionEntity {
  entity: string;
  status: 'done' | 'failed';
  readScope: 'full' | 'delta' | null;
  rowsRead: number;
  errorCode: string | null;
  errorMessage: string | null;
  completeness: string | null;
  completenessReason: string | null;
  snapshotAtUtc: string | null;
}

export interface Completion {
  version: 'v1' | 'partial_v1' | 'v2';
  runId: string;
  status: 'succeeded' | 'partial_success';
  mode: EtlMode | null;
  sourceIdentity: { databaseId: string; exportEpoch: string; environment: string } | null;
  sourceGeneration: string | null;
  batchesAcknowledged: number;
  entitiesFailed: number;
  /** null for v1: every entity of the run is done. */
  entities: CompletionEntity[] | null;
}

/** Accepts the three bodies the agent may replay byte for byte (v2 for E3+ agents). */
export function parseCompletion(body: unknown): { ok: true; completion: Completion } | { ok: false; message: string } {
  const v2 = completionV2.safeParse(body);
  if (v2.success) {
    const d = v2.data;
    return {
      ok: true,
      completion: {
        version: 'v2',
        runId: d.runId,
        status: d.status,
        mode: d.mode,
        sourceIdentity: d.sourceIdentity ?? null,
        sourceGeneration: d.sourceGeneration ?? null,
        batchesAcknowledged: d.batchesAcknowledged,
        entitiesFailed: d.entitiesFailed,
        entities: d.entities.map((e) => ({
          entity: e.entity,
          status: e.status,
          readScope: e.readScope,
          rowsRead: e.rowsRead,
          errorCode: e.errorCode,
          errorMessage: e.errorMessage,
          completeness: e.completeness ?? null,
          completenessReason: e.completenessReason ?? null,
          snapshotAtUtc: e.snapshotAtUtc ?? null,
        })),
      },
    };
  }
  const partial = completionPartialV1.safeParse(body);
  if (partial.success) {
    const d = partial.data;
    return {
      ok: true,
      completion: {
        version: 'partial_v1',
        runId: d.runId,
        status: d.status,
        mode: null,
        sourceIdentity: null,
        sourceGeneration: null,
        batchesAcknowledged: d.batchesAcknowledged,
        entitiesFailed: d.entitiesFailed,
        entities: d.entities.map((e) => ({
          entity: e.entity,
          status: e.status,
          readScope: null,
          rowsRead: e.rowsRead,
          errorCode: e.errorCode,
          errorMessage: e.errorMessage,
          completeness: null,
          completenessReason: null,
          snapshotAtUtc: null,
        })),
      },
    };
  }
  const v1 = completionV1.safeParse(body);
  if (v1.success) {
    const d = v1.data;
    return {
      ok: true,
      completion: {
        version: 'v1',
        runId: d.runId,
        status: d.status,
        mode: null,
        sourceIdentity: null,
        sourceGeneration: null,
        batchesAcknowledged: d.batchesAcknowledged,
        entitiesFailed: 0,
        entities: null,
      },
    };
  }
  return { ok: false, message: 'body matches none of RunCompletionV2, RunCompletionPartialV1, RunCompletionV1' };
}

/**
 * Whether a done entity was read in full (plan §6.7 step 4, §20): readScope=full,
 * or — for bodies without readScope — a full run mode.
 */
export function readInFull(entity: CompletionEntity, mode: EtlMode): boolean {
  if (entity.readScope) return entity.readScope === 'full';
  return mode === 'bootstrap_full' || mode === 'entity_reload';
}

// ---------------------------------------------------------------- NDJSON rows (spec §7.1)

export interface ParsedRow {
  sourceKey: string;
  /** ISO-8601 with an explicit zone (source precision kept), or null. */
  sourceUpdatedAt: string | null;
  deleted: boolean;
}

export type RowCheck = { ok: true; row: ParsedRow } | { ok: false; reason: string };

/**
 * Validates one NDJSON line. The line text itself (not a re-serialization) is
 * what gets stored, so numeric lexemes of 1C values stay exact.
 */
export function checkRowLine(line: string): RowCheck {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'ROW_NOT_JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'ROW_NOT_OBJECT' };
  const row = value as Record<string, unknown>;
  if (typeof row.sourceId !== 'string' || row.sourceId.length === 0 || row.sourceId.length > 1024) {
    return { ok: false, reason: 'ROW_SOURCE_ID' };
  }
  if (typeof row.deleted !== 'boolean') return { ok: false, reason: 'ROW_DELETED' };
  if (row.data === null || typeof row.data !== 'object' || Array.isArray(row.data)) return { ok: false, reason: 'ROW_DATA' };
  let sourceUpdatedAt: string | null = null;
  if (row.sourceUpdatedAt !== undefined && row.sourceUpdatedAt !== null) {
    if (typeof row.sourceUpdatedAt !== 'string') return { ok: false, reason: 'ROW_UPDATED_AT' };
    sourceUpdatedAt = normalizeUpdatedAt(row.sourceUpdatedAt);
    if (!sourceUpdatedAt) return { ok: false, reason: 'ROW_UPDATED_AT' };
  }
  return { ok: true, row: { sourceKey: row.sourceId, sourceUpdatedAt, deleted: row.deleted } };
}

/**
 * Edm.DateTime has no offset; the agent sends UTC, so a missing designator means UTC.
 * The string itself (not a JS Date, which keeps only milliseconds) goes to
 * PostgreSQL, so sub-millisecond order is preserved (microsecond precision).
 */
export function normalizeUpdatedAt(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/.test(value)) return null;
  const withZone = /(Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  // Validity only (rejects e.g. month 13); the value itself is not rounded here.
  if (!Number.isFinite(Date.parse(withZone.replace(/(\.\d{3})\d+/, '$1')))) return null;
  return withZone;
}
