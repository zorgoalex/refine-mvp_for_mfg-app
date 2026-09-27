import { z } from 'zod';
import { canonicalizeValue, foldKey, type CanonicalResult } from '../canonical-json/canonical-json';

/** Agent operating modes (spec §6). */
export const ONEC_AGENT_MODES = ['Normal', 'PauseEtl', 'PauseCommands', 'Drain', 'Maintenance', 'Disabled'] as const;
export type OnecAgentMode = (typeof ONEC_AGENT_MODES)[number];

/** Business command types the agent may execute; admin commands are separate. */
export const ONEC_BUSINESS_COMMAND_TYPES = [
  'integration_probe',
  'create_customer_order',
  'update_customer_order',
  'post_customer_order',
  'cancel_customer_order',
  'create_material_movement',
  'create_material_receipt',
  'create_material_writeoff',
  'create_payment_document',
] as const;

/** Configuration size limit (spec §9: configuration ≤ 1 MiB). */
export const ONEC_CONFIG_MAX_BYTES = 1024 * 1024;

const identifier = z.string().trim().min(1).max(200);
const odataName = z.string().min(1).max(200).regex(/^[^\s/?#]+$/u, 'must be a single OData name');

export const onecEtlEntitySchema = z
  .object({
    entityCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lowercase code: a-z, 0-9, _'),
    oDataPath: odataName,
    keyField: odataName.optional(),
    keyFields: z.array(odataName).min(1).max(8).optional(),
    updatedAtField: odataName.nullable().optional(),
    updatedAtEdmType: z.enum(['Edm.DateTimeOffset', 'Edm.DateTime']).nullable().optional(),
    deletedField: odataName.nullable().optional(),
    select: z.array(odataName).min(1).max(200),
    syncMode: z.string().regex(/^[a-z][a-z_]{0,31}$/),
    pageSize: z.number().int().min(1).max(10000),
    overlapMinutes: z.number().int().min(0).max(10080),
    schemaVersion: z.number().int().min(1).max(1000).optional(),
    oDataVersion: z.union([z.literal(3), z.literal(4)]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((entity, ctx) => {
    if (!entity.keyField && !entity.keyFields) {
      ctx.addIssue({ code: 'custom', message: 'keyField or keyFields is required', path: ['keyField'] });
    }
    const selected = new Set(entity.select);
    if (selected.size !== entity.select.length) {
      ctx.addIssue({ code: 'custom', message: 'select contains duplicates', path: ['select'] });
    }
    for (const key of entity.keyFields ?? (entity.keyField ? [entity.keyField] : [])) {
      if (!selected.has(key)) ctx.addIssue({ code: 'custom', message: `key field ${key} must be selected`, path: ['select'] });
    }
  });

export const onecAgentConfigurationSchema = z
  .object({
    mode: z.enum(ONEC_AGENT_MODES),
    commandTypes: z.array(identifier).max(64),
    etlIntervalMinutes: z.number().int().min(1).max(10080),
    etlEntities: z.array(onecEtlEntitySchema).max(64),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (new Set(config.commandTypes).size !== config.commandTypes.length) {
      ctx.addIssue({ code: 'custom', message: 'commandTypes must be unique', path: ['commandTypes'] });
    }
    for (const [index, type] of config.commandTypes.entries()) {
      if (!(ONEC_BUSINESS_COMMAND_TYPES as readonly string[]).includes(type)) {
        ctx.addIssue({ code: 'custom', message: `unknown command type ${type}`, path: ['commandTypes', index] });
      }
    }
    const codes = config.etlEntities.map((entity) => entity.entityCode);
    if (new Set(codes).size !== codes.length) {
      ctx.addIssue({ code: 'custom', message: 'entityCode must be unique', path: ['etlEntities'] });
    }
  });

export type OnecAgentConfiguration = z.infer<typeof onecAgentConfigurationSchema>;

export const DEFAULT_ONEC_AGENT_CONFIGURATION: OnecAgentConfiguration = {
  mode: 'Normal',
  commandTypes: [],
  etlIntervalMinutes: 60,
  etlEntities: [],
};

export interface OnecConfigIssue {
  path: string;
  message: string;
}

export type OnecConfigValidation =
  | { ok: true; configuration: OnecAgentConfiguration; canonical: CanonicalResult }
  | { ok: false; issues: OnecConfigIssue[] };

/**
 * Validates an operator-supplied configuration with the agent's own rules and
 * returns its canonical bytes/hash (configHash = same algorithm as payloadHash).
 */
export function validateOnecConfiguration(input: unknown): OnecConfigValidation {
  const caseIssues = findCaseInsensitiveDuplicates(input);
  if (caseIssues.length > 0) return { ok: false, issues: caseIssues };
  const parsed = onecAgentConfigurationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  }
  const canonical = canonicalizeValue(parsed.data);
  if (canonical.bytes > ONEC_CONFIG_MAX_BYTES) {
    return { ok: false, issues: [{ path: '', message: `configuration exceeds ${ONEC_CONFIG_MAX_BYTES} bytes` }] };
  }
  return { ok: true, configuration: parsed.data, canonical };
}

/** The agent rejects configurations whose property names differ only by case (spec §2.4). */
function findCaseInsensitiveDuplicates(value: unknown, path: string[] = []): OnecConfigIssue[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findCaseInsensitiveDuplicates(item, [...path, String(index)]));
  if (value === null || typeof value !== 'object') return [];
  const issues: OnecConfigIssue[] = [];
  const seen = new Map<string, string>();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const folded = foldKey(key);
    const previous = seen.get(folded);
    if (previous !== undefined) issues.push({ path: [...path, key].join('.'), message: `property differs from ${previous} only by case` });
    seen.set(folded, key);
    issues.push(...findCaseInsensitiveDuplicates(item, [...path, key]));
  }
  return issues;
}

/** Modes in which session/start reports maintenanceMode=true. */
export function isMaintenanceMode(mode: OnecAgentMode): boolean {
  return mode === 'Maintenance' || mode === 'Disabled';
}
