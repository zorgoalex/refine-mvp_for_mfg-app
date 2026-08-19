import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type {
  CncTelegramWorkerSessionHeartbeatDto,
  CncTelegramWorkerSessionLeaseContext,
  CncTelegramWorkerSessionLeaseDto,
} from '../application/cnc-telegram-worker-session.types';

const workerSessionLeaseSchema = z.object({
  chatId: z.string().trim().min(1).max(120),
  workerInstanceId: z.string().uuid(),
  imageRevision: z.string().trim().regex(/^[0-9a-f]{7,64}$/),
}).strict();

export function parseWorkerSessionLease(body: unknown): CncTelegramWorkerSessionLeaseDto {
  const parsed = workerSessionLeaseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid Telegram worker session lease payload', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return { sourceChatId: parsed.data.chatId, workerInstanceId: parsed.data.workerInstanceId, workerImageRevision: parsed.data.imageRevision };
}

const workerSessionHeartbeatSchema = z.object({
  workerInstanceId: z.string().uuid(),
}).strict();

export function parseWorkerSessionHeartbeat(body: unknown): CncTelegramWorkerSessionHeartbeatDto {
  const parsed = workerSessionHeartbeatSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid Telegram worker session heartbeat payload', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

export function parseWorkerSessionLeaseHeaders(
  token: string | string[] | undefined,
  generation: string | string[] | undefined,
  sourceChatId: string | string[] | undefined,
  workerInstanceId: string | string[] | undefined,
): CncTelegramWorkerSessionLeaseContext {
  const tokenValue = firstHeader(token)?.trim();
  const generationValue = firstHeader(generation)?.trim();
  const sourceChatValue = firstHeader(sourceChatId)?.trim();
  const workerInstanceValue = firstHeader(workerInstanceId)?.trim();
  const parsedGeneration = generationValue ? Number(generationValue) : NaN;
  if (!tokenValue || tokenValue.length < 32 || tokenValue.length > 240
    || (sourceChatValue !== undefined && sourceChatValue.length > 120)
    || !workerInstanceValue || !z.string().uuid().safeParse(workerInstanceValue).success
    || !Number.isSafeInteger(parsedGeneration) || parsedGeneration <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Valid Telegram worker session headers are required', {
      requiredHeaders: [
        'X-CNC-Telegram-Session-Token',
        'X-CNC-Telegram-Session-Generation',
        'X-CNC-Telegram-Chat-Id (optional when exactly one allowed chat is configured)',
        'X-CNC-Telegram-Worker-Instance',
      ],
    });
  }
  return {
    sourceChatId: sourceChatValue ?? '',
    leaseToken: tokenValue,
    leaseGeneration: parsedGeneration,
    workerInstanceId: workerInstanceValue,
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
