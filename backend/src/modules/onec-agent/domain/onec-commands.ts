import { z } from 'zod';
import {
  CanonicalJsonError,
  canonicalize,
  commandPayloadStats,
  sha256Base64,
  toJsonNode,
  type JsonNode,
} from '../canonical-json/canonical-json';
import { ONEC_BUSINESS_COMMAND_TYPES } from './onec-config';

/**
 * Command payload limits = the agent's CommandPayloadPolicy (agent-bridge to-erp/0011):
 * a payload ERP accepts must always pass the agent and the 1C extension parser.
 */
export const ONEC_COMMAND_PAYLOAD_LIMITS = {
  maxBytes: 61440,
  maxDepth: 31,
  maxNodes: 4089,
  maxObjectFields: 128,
} as const;

/** Commands executed by the agent itself (spec §4.6); reconcile_* are not implemented by the agent. */
export const ONEC_ADMIN_COMMAND_TYPES = [
  'start_full_sync',
  'reload_entity',
  'pause_etl',
  'resume_etl',
  'run_connectivity_test',
  'collect_diagnostics',
  'rotate_certificate_hint',
] as const;
export type OnecAdminCommandType = (typeof ONEC_ADMIN_COMMAND_TYPES)[number];

const empty = z.object({}).strict();
const entityCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** Payload schemas the ERP admin UI may send (admin commands + the business probe). */
export const OPERATOR_COMMAND_SCHEMAS: Record<string, z.ZodType<Record<string, unknown>>> = {
  start_full_sync: z.object({ entities: z.array(entityCode).max(64) }).strict(),
  reload_entity: z.object({ entity: entityCode }).strict(),
  pause_etl: empty,
  resume_etl: empty,
  run_connectivity_test: empty,
  collect_diagnostics: empty,
  rotate_certificate_hint: empty,
  integration_probe: z.object({ marker: z.string().min(1).max(256) }).strict(),
};

export function commandKindOf(commandType: string): 'admin' | 'business' | null {
  if ((ONEC_ADMIN_COMMAND_TYPES as readonly string[]).includes(commandType)) return 'admin';
  if ((ONEC_BUSINESS_COMMAND_TYPES as readonly string[]).includes(commandType)) return 'business';
  return null;
}

export type PayloadCheck =
  | { ok: true; node: JsonNode; canonical: string; hash: string; bytes: number }
  | { ok: false; code: 'PAYLOAD_TOO_LARGE' | 'INVALID_PAYLOAD'; message: string };

/** Canonicalizes and enforces the agent limits (same codes the agent would use). */
export function checkCommandPayload(payload: unknown): PayloadCheck {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'payload must be a JSON object' };
  }
  let node: JsonNode;
  try {
    node = toJsonNode(payload);
  } catch (error) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: error instanceof CanonicalJsonError ? error.message : 'invalid payload' };
  }
  const canonical = canonicalize(node);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  if (bytes > ONEC_COMMAND_PAYLOAD_LIMITS.maxBytes) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: `payload is ${bytes} bytes (max ${ONEC_COMMAND_PAYLOAD_LIMITS.maxBytes})` };
  }
  const stats = commandPayloadStats(node);
  if (stats.depth > ONEC_COMMAND_PAYLOAD_LIMITS.maxDepth) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: `payload depth ${stats.depth} > ${ONEC_COMMAND_PAYLOAD_LIMITS.maxDepth}` };
  }
  if (stats.nodes > ONEC_COMMAND_PAYLOAD_LIMITS.maxNodes) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: `payload has ${stats.nodes} nodes (max ${ONEC_COMMAND_PAYLOAD_LIMITS.maxNodes})` };
  }
  if (stats.maxObjectFields > ONEC_COMMAND_PAYLOAD_LIMITS.maxObjectFields) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: `object with ${stats.maxObjectFields} properties (max ${ONEC_COMMAND_PAYLOAD_LIMITS.maxObjectFields})` };
  }
  return { ok: true, node, canonical, hash: sha256Base64(canonical), bytes };
}

/** Wire contracts of the agent command API (spec §4). */
export const leaseRequestSchema = z.object({
  sessionId: z.string().uuid(),
  supportedCommandTypes: z.array(z.string().max(64)).max(64).default([]),
  maxWaitSeconds: z.number().int().min(1).max(120).default(25),
  currentLoad: z
    .object({ executing: z.number().int().min(0).max(10_000), capacity: z.number().int().min(0).max(10_000) })
    .optional(),
});
export type LeaseRequest = z.infer<typeof leaseRequestSchema>;

export const receivedRequestSchema = z.object({
  leaseId: z.string().uuid(),
  receivedAtUtc: z.string().datetime({ offset: true }).optional(),
  payloadHash: z.string().min(1).max(100),
});

export const RESULT_STATUSES = ['succeeded', 'business_error', 'dead_letter', 'expired'] as const;
export const resultBodySchema = z.object({
  commandId: z.string().uuid(),
  status: z.enum(RESULT_STATUSES),
  resultVersion: z.literal(1),
  error: z.object({ code: z.string().max(100).optional() }).passthrough().nullable().optional(),
});

/** Lease duration (decision В-3: 60 s, no renew). */
export const LEASE_SECONDS = 60;
