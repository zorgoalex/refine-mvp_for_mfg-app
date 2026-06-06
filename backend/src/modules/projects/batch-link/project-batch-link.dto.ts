import { z } from 'zod';

import { ApiError } from '../../../common/errors/api-error';
import {
  PROJECT_ENTITY_TYPE_CODES,
  type ProjectEntityTypeCode,
} from '../entity-links/project-entity-registry';

export interface ProjectBatchLinkSourceDto {
  type: string;
  reference: string;
}

export interface ProjectBatchLinkItemDto {
  entityId: string;
  reason: string;
  confidence: string;
  sourceRow?: string;
}

export interface ProjectBatchLinkRequestDto {
  mode: 'dry-run';
  fixtureKey: string;
  idempotencyKey: string;
  entityType: ProjectEntityTypeCode;
  source: ProjectBatchLinkSourceDto;
  items: ProjectBatchLinkItemDto[];
}

export interface ProjectBatchLinkProposalDto {
  entityType: ProjectEntityTypeCode;
  entityId: string;
  action: 'link';
  source: string;
  confidence: string;
  reason: string;
}

export interface ProjectBatchLinkSkippedDto {
  entityType: ProjectEntityTypeCode;
  entityId: string;
  source: string;
  sourceRow: string | null;
  confidence: string;
  reasonCode: 'entity_not_found';
  reasonText: string;
  evidence: Record<string, unknown>;
}

export interface ProjectBatchLinkSampleEvidenceDto {
  projectId: string;
  entityType: ProjectEntityTypeCode;
  entityId: string;
  source: string;
  sourceRow: string;
  reason: string;
  skipReason: string | null;
  fixtureKey: string;
  idempotencyKey: string;
  requestId: string | null;
  actorUserId: string;
  actorUsername: string;
}

export interface ProjectBatchLinkResponseDto {
  projectId: string;
  mode: 'dry-run';
  summary: {
    proposed: number;
    skipped: number;
    conflicts: number;
    sampledEvidenceRows: number;
  };
  proposals: ProjectBatchLinkProposalDto[];
  skipped: ProjectBatchLinkSkippedDto[];
  sampleEvidence: ProjectBatchLinkSampleEvidenceDto[];
  writeEnabled: false;
}

const sourceSchema = z.object({
  type: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9_:-]{0,99}$/),
  reference: z.string().trim().min(1).max(200),
});

const itemSchema = z.object({
  entityId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(500),
  confidence: z.string().trim().min(1).max(100),
  sourceRow: z.string().trim().min(1).max(200).optional(),
});

const batchLinkRequestSchema = z
  .object({
    mode: z.literal('dry-run'),
    fixtureKey: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(1).max(200),
    entityType: z.enum(PROJECT_ENTITY_TYPE_CODES),
    source: sourceSchema,
    items: z.array(itemSchema).max(500),
  })
  .superRefine((request, context) => {
    for (const [index, item] of request.items.entries()) {
      if (!hasValidEntityIdShape(request.entityType, item.entityId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid ${request.entityType} entityId`,
          path: ['items', index, 'entityId'],
        });
      }
    }
  });

export function parseProjectBatchLinkRequest(body: unknown): ProjectBatchLinkRequestDto {
  const mode = (body && typeof body === 'object' && 'mode' in body)
    ? (body as { mode?: unknown }).mode
    : undefined;
  if (mode !== 'dry-run') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Only dry-run batch link mode is accepted', {
      field: 'mode',
      writeEnabled: false,
    });
  }

  const parsed = batchLinkRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'VALIDATION_ERROR: Project batch link payload validation failed', {
      issues: parsed.error.issues,
      writeEnabled: false,
    });
  }
  return parsed.data;
}

function hasValidEntityIdShape(entityType: ProjectEntityTypeCode, entityId: string): boolean {
  if (entityType === 'deadline_instance') {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entityId);
  }

  return /^[1-9]\d*$/.test(entityId);
}
