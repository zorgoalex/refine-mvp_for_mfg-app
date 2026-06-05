import { z } from 'zod';

import { ApiError } from '../../../common/errors/api-error';

export const PROJECT_PARTICIPANT_TYPES = ['user', 'employee'] as const;
export type ProjectParticipantType = (typeof PROJECT_PARTICIPANT_TYPES)[number];

export const PROJECT_PARTICIPANT_ROLE_CODES = [
  'owner',
  'manager',
  'participant',
  'observer',
] as const;

export type ProjectParticipantRoleCode = (typeof PROJECT_PARTICIPANT_ROLE_CODES)[number];

export interface ProjectParticipantRoleDto {
  code: string;
  label: string;
}

export interface ProjectParticipantDto {
  id: string;
  participantType: ProjectParticipantType;
  participantId: string | null;
  displayName: string | null;
  role: ProjectParticipantRoleDto;
  validFrom: string;
  validTo: string | null;
  metadata: Record<string, unknown>;
}

export interface ProjectParticipantsResponseDto {
  projectId: string;
  participants: ProjectParticipantDto[];
  requestId: string;
  changed?: boolean;
  auditId?: string;
}

export interface ProjectParticipantRoleListResponseDto {
  roles: ProjectParticipantRoleDto[];
  requestId: string;
}

export interface ReplaceProjectParticipantDto {
  participantType: ProjectParticipantType;
  participantId: string;
  roleCode: string;
  metadata: Record<string, unknown>;
}

export interface ReplaceProjectParticipantsRequestDto {
  idempotencyKey: string;
  participants: ReplaceProjectParticipantDto[];
  reason?: string | null;
}

const participantIdSchema = z.string().trim().min(1).max(200);
const roleCodeSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/);
const metadataSchema = z.record(z.string(), z.unknown()).default({});

const projectParticipantInputSchema = z.object({
  participantType: z.enum(PROJECT_PARTICIPANT_TYPES),
  participantId: participantIdSchema,
  roleCode: roleCodeSchema,
  metadata: metadataSchema,
});

const replaceProjectParticipantsRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    participants: z.array(projectParticipantInputSchema).max(500),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((request, context) => {
    const seen = new Set<string>();

    for (const [index, participant] of request.participants.entries()) {
      if (!/^[1-9]\d*$/.test(participant.participantId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid project participant id',
          path: ['participants', index, 'participantId'],
        });
      }
      const duplicateKey = `${participant.participantType}:${participant.participantId}`;
      if (seen.has(duplicateKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate project participant',
          path: ['participants', index],
        });
      }
      seen.add(duplicateKey);
    }
  });

export function parseReplaceProjectParticipantsRequest(
  body: unknown,
): ReplaceProjectParticipantsRequestDto {
  const parsed = replaceProjectParticipantsRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw projectParticipantsValidationError(parsed.error);
  }
  return parsed.data;
}

function projectParticipantsValidationError(error: z.ZodError): ApiError {
  const duplicateIssue = error.issues.find((issue) => issue.message.includes('Duplicate'));
  if (duplicateIssue) {
    return new ApiError(422, 'VALIDATION_ERROR', duplicateIssue.message, { issues: error.issues });
  }

  return new ApiError(422, 'VALIDATION_ERROR', 'VALIDATION_ERROR: Project participant payload validation failed', {
    issues: error.issues,
  });
}
