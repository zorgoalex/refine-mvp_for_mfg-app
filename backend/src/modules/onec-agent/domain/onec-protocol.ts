import { z } from 'zod';

/** Agent API wire contracts (spec §3, §5). Unknown fields are ignored (zod strips them). */

const text = (max: number) => z.string().max(max);
const clipped = (max: number) =>
  z
    .string()
    .nullable()
    .optional()
    .transform((value) => (typeof value === 'string' ? value.slice(0, max) : (value ?? null)));
const isoDate = z.string().datetime({ offset: true });
const nonNegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const AGENT_VERSION_PATTERN = /^[0-9]{1,9}\.[0-9]{1,9}(\.[0-9]{1,9})?$/;

export const sourceIdentitySchema = z
  .object({
    databaseId: text(128),
    exportEpoch: text(128),
    environment: text(32),
  })
  .nullable()
  .optional();

export const sessionStartSchema = z.object({
  agentId: text(64),
  siteId: text(64),
  agentVersion: z.string().regex(AGENT_VERSION_PATTERN),
  localSchemaVersion: z.number().int().min(0).max(1_000_000).nullable().optional(),
  capabilities: z.array(text(64)).max(64).default([]),
  systemTimeUtc: isoDate.nullable().optional(),
  sourceIdentity: sourceIdentitySchema,
});
export type SessionStartRequest = z.infer<typeof sessionStartSchema>;

export const HEARTBEAT_STATES = [
  'healthy',
  'degraded',
  'offline_onec',
  'storage_critical',
  'maintenance',
  'incompatible_version',
] as const;

export const heartbeatSchema = z.object({
  agentId: text(64),
  version: text(64),
  state: z.enum(HEARTBEAT_STATES),
  stateReason: clipped(128),
  uptimeSeconds: nonNegative.optional(),
  oneC: z
    .object({
      odataAvailable: z.boolean().optional(),
      commandApiAvailable: z.boolean().optional(),
      lastSuccessAtUtc: isoDate.nullable().optional(),
      lastError: clipped(512),
    })
    .optional(),
  queues: z
    .object({
      commandsPending: nonNegative.optional(),
      resultsPending: nonNegative.optional(),
      etlBatchesPending: nonNegative.optional(),
      deadLetters: nonNegative.optional(),
    })
    .optional(),
  etl: z
    .object({
      lastSuccessAtUtc: isoDate.nullable().optional(),
      currentRunId: z.string().uuid().nullable().optional(),
    })
    .optional(),
  machine: z
    .object({
      diskFreeBytes: nonNegative.optional(),
      workingSetBytes: nonNegative.optional(),
      cpuPercent: z.number().min(0).max(100_000).optional(),
      sqliteSizeBytes: nonNegative.optional(),
      spoolSizeBytes: nonNegative.optional(),
    })
    .optional(),
  certificate: z.object({ expiresAtUtc: isoDate.nullable().optional() }).optional(),
  activeConfigVersion: nonNegative.nullable().optional(),
  rejectedConfigVersion: nonNegative.nullable().optional(),
  rejectedReason: clipped(128),
  sourceIdentity: sourceIdentitySchema,
});
export type HeartbeatRequest = z.infer<typeof heartbeatSchema>;

export function parseAgentVersion(version: string): [number, number, number] | null {
  if (!AGENT_VERSION_PATTERN.test(version)) return null;
  const [major, minor, build] = version.split('.').map(Number);
  return [major!, minor!, build ?? 0];
}

/** True when `version` >= `minimum`; build defaults to 0 when omitted. */
export function isVersionAtLeast(version: string, minimum: string): boolean {
  const a = parseAgentVersion(version);
  const b = parseAgentVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

export function sameSourceIdentity(
  a: { databaseId: string; exportEpoch: string; environment: string },
  b: { databaseId: string; exportEpoch: string; environment: string },
): boolean {
  return a.databaseId === b.databaseId && a.exportEpoch === b.exportEpoch && a.environment === b.environment;
}
