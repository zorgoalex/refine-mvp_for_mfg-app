import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { DailyDigestSettingsInput } from './daily-digest.types';

const uuid = z.string().uuid();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const settingsInput = z.object({
  version: z.number().int().positive(),
  enabled: z.boolean(),
  groupChatId: z.string().trim().min(1).max(120).nullable(),
  sendTime: time,
  sendWindowMinutes: z.number().int().min(0).max(1439).optional(),
  cardsPerMessage: z.union([z.literal(1), z.literal(2)]),
  catchUpPolicy: z.enum(['skip', 'until_deadline', 'end_of_day']),
  catchUpDeadline: time,
  partialPolicy: z.enum(['remaining', 'repeat_all', 'manual']),
  duplicateRiskConfirmed: z.boolean().default(false),
}).strict();

const runInput = z.object({
  settingsVersion: z.number().int().positive(),
  idempotencyKey: uuid,
  confirmed: z.literal(true),
}).strict();

const retryInput = z.object({
  mode: z.enum(['remaining', 'all']),
  idempotencyKey: uuid,
  duplicateRiskConfirmed: z.boolean().default(false),
}).strict();

export function parseDailyDigestSettingsInput(value: unknown): DailyDigestSettingsInput {
  const input = parse(settingsInput, value);
  if (input.groupChatId && !/^\d{5,24}(?:-\d{5,24})?@g\.us$/.test(input.groupChatId)) invalid();
  if (input.enabled && !input.groupChatId) invalid();
  if (input.partialPolicy === 'repeat_all' && !input.duplicateRiskConfirmed) {
    throw new ApiError(409, 'WHATSAPP_DAILY_DIGEST_DUPLICATE_CONFIRMATION_REQUIRED', 'Повторная отправка может создать дубликаты; подтвердите риск');
  }
  // A send window may never end at or beyond local midnight. When the client
  // omits sendWindowMinutes the stored value applies and is revalidated under
  // the settings lock in the repository; the window end is at least sendTime.
  const windowEnd = timeMinutes(input.sendTime) + (input.sendWindowMinutes ?? 0);
  if (windowEnd >= 1440) invalid();
  if (input.catchUpPolicy === 'until_deadline' && timeMinutes(input.catchUpDeadline) < windowEnd) invalid();
  return input;
}

export const parseDailyDigestRunInput = (value: unknown) => parse(runInput, value);
export const parseDailyDigestRetryInput = (value: unknown) => parse(retryInput, value);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid();
  return result.data;
}

function invalid(): never {
  throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректные настройки ежедневной рассылки');
}

function timeMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}
