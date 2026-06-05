import { z } from 'zod';

import { ApiError } from '../../../common/errors/api-error';

export const PROJECT_ENTITY_TYPE_CODES = [
  'order',
  'user',
  'employee',
  'client',
  'workshop',
  'deadline_instance',
] as const;

export type ProjectEntityTypeCode = (typeof PROJECT_ENTITY_TYPE_CODES)[number];

export interface ProjectEntityLinkDto {
  id: string;
  entityType: ProjectEntityTypeCode;
  entityId: string;
  displayLabel: string | null;
  relationType: string;
  validFrom: string;
  validTo: string | null;
  metadata: Record<string, unknown>;
}

export interface ProjectEntityLinksResponseDto {
  projectId: string;
  links: ProjectEntityLinkDto[];
  requestId: string;
  changed?: boolean;
  auditId?: string;
}

export interface ReplaceProjectEntityLinkDto {
  entityType: ProjectEntityTypeCode;
  entityId: string;
  relationType: string;
  metadata: Record<string, unknown>;
}

export interface ReplaceProjectEntityLinksRequestDto {
  idempotencyKey: string;
  links: ReplaceProjectEntityLinkDto[];
  reason?: string | null;
}

const relationTypeSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/).default('related');
const metadataSchema = z.record(z.string(), z.unknown()).default({});

const projectEntityLinkInputSchema = z.object({
  entityType: z.enum(PROJECT_ENTITY_TYPE_CODES),
  entityId: z.string().trim().min(1).max(200),
  relationType: relationTypeSchema,
  metadata: metadataSchema,
});

const replaceProjectEntityLinksRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    links: z.array(projectEntityLinkInputSchema).max(500),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((request, context) => {
    const seen = new Set<string>();

    for (const [index, link] of request.links.entries()) {
      if (!hasValidEntityIdShape(link.entityType, link.entityId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid ${link.entityType} entityId`,
          path: ['links', index, 'entityId'],
        });
      }
      const duplicateKey = `${link.entityType}:${link.entityId}:${link.relationType}`;
      if (seen.has(duplicateKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate project entity link relation',
          path: ['links', index],
        });
      }
      seen.add(duplicateKey);
    }
  });

export function parseReplaceProjectEntityLinksRequest(
  body: unknown,
): ReplaceProjectEntityLinksRequestDto {
  const parsed = replaceProjectEntityLinksRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw projectEntityLinksValidationError(parsed.error);
  }
  return parsed.data;
}

export const parseAppendProjectEntityLinksRequest = parseReplaceProjectEntityLinksRequest;

function projectEntityLinksValidationError(error: z.ZodError): ApiError {
  const duplicateIssue = error.issues.find((issue) => issue.message.includes('Duplicate'));
  if (duplicateIssue) {
    return new ApiError(422, 'VALIDATION_ERROR', duplicateIssue.message, { issues: error.issues });
  }

  return new ApiError(422, 'VALIDATION_ERROR', 'VALIDATION_ERROR: Project entity link payload validation failed', {
    issues: error.issues,
  });
}

function hasValidEntityIdShape(entityType: ProjectEntityTypeCode, entityId: string): boolean {
  if (entityType === 'deadline_instance') {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entityId);
  }

  return /^[1-9]\d*$/.test(entityId);
}
