import { z } from 'zod';

import { ApiError } from '../../../common/errors/api-error';

export const GROUP_ENTITY_TYPE_CODES = [
  'order',
  'user',
  'employee',
  'client',
  'workshop',
  'deadline_instance',
] as const;

export type GroupEntityTypeCode = (typeof GROUP_ENTITY_TYPE_CODES)[number];

export interface GroupEntityLinkDto {
  id: string;
  entityType: GroupEntityTypeCode;
  entityId: string;
  displayLabel: string | null;
  relationType: string;
  validFrom: string;
  validTo: string | null;
  metadata: Record<string, unknown>;
}

export interface GroupEntityLinksResponseDto {
  groupId: string;
  links: GroupEntityLinkDto[];
  requestId: string;
  changed?: boolean;
  auditId?: string;
  outboxEventId?: string | null;
  createdLinks?: GroupEntityLinkDto[];
  existingLinks?: GroupEntityLinkDto[];
}

export interface ReplaceGroupEntityLinkDto {
  entityType: GroupEntityTypeCode;
  entityId: string;
  relationType: string;
  metadata: Record<string, unknown>;
}

export interface ReplaceGroupEntityLinksRequestDto {
  idempotencyKey: string;
  links: ReplaceGroupEntityLinkDto[];
  reason?: string | null;
}

const relationTypeSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/).default('related');
const metadataSchema = z.record(z.string(), z.unknown()).default({});

const groupEntityLinkInputSchema = z.object({
  entityType: z.enum(GROUP_ENTITY_TYPE_CODES),
  entityId: z.string().trim().min(1).max(200),
  relationType: relationTypeSchema,
  metadata: metadataSchema,
});

const replaceGroupEntityLinksRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    links: z.array(groupEntityLinkInputSchema).max(500),
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
          message: 'Duplicate group entity link relation',
          path: ['links', index],
        });
      }
      seen.add(duplicateKey);
    }
  });

export function parseReplaceGroupEntityLinksRequest(
  body: unknown,
): ReplaceGroupEntityLinksRequestDto {
  const parsed = replaceGroupEntityLinksRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw groupEntityLinksValidationError(parsed.error);
  }
  return parsed.data;
}

export const parseAppendGroupEntityLinksRequest = parseReplaceGroupEntityLinksRequest;

function groupEntityLinksValidationError(error: z.ZodError): ApiError {
  const duplicateIssue = error.issues.find((issue) => issue.message.includes('Duplicate'));
  if (duplicateIssue) {
    return new ApiError(422, 'VALIDATION_ERROR', duplicateIssue.message, { issues: error.issues });
  }

  return new ApiError(422, 'VALIDATION_ERROR', 'VALIDATION_ERROR: Group entity link payload validation failed', {
    issues: error.issues,
  });
}

function hasValidEntityIdShape(entityType: GroupEntityTypeCode, entityId: string): boolean {
  if (entityType === 'deadline_instance') {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entityId);
  }

  return /^[1-9]\d*$/.test(entityId);
}
