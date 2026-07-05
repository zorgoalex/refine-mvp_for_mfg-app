import { z } from 'zod';

import { ApiError } from '../../../common/errors/api-error';

export const GROUP_PARTICIPANT_TYPES = ['user', 'employee'] as const;
export type GroupParticipantType = (typeof GROUP_PARTICIPANT_TYPES)[number];

export const GROUP_PARTICIPANT_ROLE_CODES = [
  'owner',
  'manager',
  'participant',
  'observer',
] as const;

export type GroupParticipantRoleCode = (typeof GROUP_PARTICIPANT_ROLE_CODES)[number];

export interface GroupParticipantRoleDto {
  code: string;
  label: string;
}

export interface GroupParticipantDto {
  id: string;
  participantType: GroupParticipantType;
  participantId: string | null;
  displayName: string | null;
  role: GroupParticipantRoleDto;
  validFrom: string;
  validTo: string | null;
  metadata: Record<string, unknown>;
}

export interface GroupParticipantsResponseDto {
  groupId: string;
  participants: GroupParticipantDto[];
  requestId: string;
  changed?: boolean;
  auditId?: string;
}

export interface GroupParticipantRoleListResponseDto {
  roles: GroupParticipantRoleDto[];
  requestId: string;
}

export interface ReplaceGroupParticipantDto {
  participantType: GroupParticipantType;
  participantId: string;
  roleCode: string;
  metadata: Record<string, unknown>;
}

export interface ReplaceGroupParticipantsRequestDto {
  idempotencyKey: string;
  participants: ReplaceGroupParticipantDto[];
  reason?: string | null;
}

const participantIdSchema = z.string().trim().min(1).max(200);
const roleCodeSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/);
const metadataSchema = z.record(z.string(), z.unknown()).default({});

const groupParticipantInputSchema = z.object({
  participantType: z.enum(GROUP_PARTICIPANT_TYPES),
  participantId: participantIdSchema,
  roleCode: roleCodeSchema,
  metadata: metadataSchema,
});

const replaceGroupParticipantsRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    participants: z.array(groupParticipantInputSchema).max(500),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((request, context) => {
    const seen = new Set<string>();

    for (const [index, participant] of request.participants.entries()) {
      if (!/^[1-9]\d*$/.test(participant.participantId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid group participant id',
          path: ['participants', index, 'participantId'],
        });
      }
      const duplicateKey = `${participant.participantType}:${participant.participantId}`;
      if (seen.has(duplicateKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate group participant',
          path: ['participants', index],
        });
      }
      seen.add(duplicateKey);
    }
  });

export function parseReplaceGroupParticipantsRequest(
  body: unknown,
): ReplaceGroupParticipantsRequestDto {
  const parsed = replaceGroupParticipantsRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw groupParticipantsValidationError(parsed.error);
  }
  return parsed.data;
}

function groupParticipantsValidationError(error: z.ZodError): ApiError {
  const duplicateIssue = error.issues.find((issue) => issue.message.includes('Duplicate'));
  if (duplicateIssue) {
    return new ApiError(422, 'VALIDATION_ERROR', duplicateIssue.message, { issues: error.issues });
  }

  return new ApiError(422, 'VALIDATION_ERROR', 'VALIDATION_ERROR: Group participant payload validation failed', {
    issues: error.issues,
  });
}
