import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type {
  MdfCncObservationFailureReason,
  MdfCncObservationReport,
} from '../application/mdf-cnc-observations.types';

const claimIdSchema = z.string().uuid();
const claimTokenSchema = z.string().trim().min(32).max(240);
const generationSchema = z.number().int().positive().max(2_147_483_647);
const messageSchema = z.object({
  messageId: z.number().int().positive().max(2_147_483_647),
  chatId: z.string().trim().min(1).max(120),
  role: z.enum(['svg', 'gcode', 'image']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  present: z.literal(true),
  thumbsUp: z.boolean(),
}).strict();

const reportSchema = z.object({
  claimId: claimIdSchema,
  claimToken: claimTokenSchema,
  claimGeneration: generationSchema,
  messages: z.array(messageSchema).min(1).max(3),
}).strict().superRefine((report, context) => {
  const ids = report.messages.map((message) => message.messageId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['messages'], message: 'message ids must be unique' });
  }
  const roles = report.messages.map((message) => message.role);
  if (new Set(roles).size !== roles.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['messages'], message: 'message roles must be unique' });
  }
});

const failureSchema = z.object({
  claimToken: claimTokenSchema,
  claimGeneration: generationSchema,
  reason: z.enum(['FETCH_FAILED', 'MESSAGE_MISSING', 'MESSAGE_MEDIA_MISMATCH', 'MESSAGE_GROUP_INCOMPLETE']),
}).strict();

export interface MdfCncObservationFailureDto {
  claimToken: string;
  claimGeneration: number;
  reason: MdfCncObservationFailureReason;
}

export function parseMdfCncObservationClaimId(value: unknown): string {
  return parse(claimIdSchema, value, 'Invalid CNC observation claim id');
}

export function parseMdfCncObservationReport(value: unknown): MdfCncObservationReport {
  return parse(reportSchema, value, 'Invalid CNC observation report');
}

export function parseMdfCncObservationFailure(value: unknown): MdfCncObservationFailureDto {
  return parse(failureSchema, value, 'Invalid CNC observation failure report');
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', message, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}
