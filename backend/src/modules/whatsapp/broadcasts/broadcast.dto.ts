import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import { validateCaptionTemplate } from './broadcast-caption';
import { addDays, businessDate } from './broadcast-time';
import {
  BROADCAST_MAX_ORDER_OFFSET_DAYS, CALENDAR_SEND_MAX_DAYS, type BroadcastInput, type BroadcastUpdateInput, type CalendarSendUpdateInput,
} from './broadcast.types';

const uuid = z.string().uuid();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const GROUP_ID = /^\d{5,24}(?:-\d{5,24})?@g\.us$/;

const broadcastFields = {
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  groupChatId: z.string().trim().min(1).max(120).nullable(),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7),
  sendTime: time,
  sendWindowMinutes: z.number().int().min(0).max(1439),
  catchUpPolicy: z.enum(['skip', 'until_deadline', 'end_of_day']),
  catchUpDeadline: time,
  partialPolicy: z.enum(['remaining', 'repeat_all', 'manual']),
  orderDateOffsetDays: z.number().int().min(0).max(BROADCAST_MAX_ORDER_OFFSET_DAYS),
  cardsPerMessage: z.union([z.literal(1), z.literal(2)]),
  captionTemplate: z.string().max(1000),
  duplicateRiskConfirmed: z.boolean().default(false),
};

const createInput = z.object(broadcastFields).strict();
const updateInput = z.object({ ...broadcastFields, version: z.number().int().positive() }).strict();
const versionInput = z.object({ version: z.number().int().positive() }).strict();
const runInput = z.object({ settingsVersion: z.number().int().positive(), idempotencyKey: uuid, confirmed: z.literal(true) }).strict();
const retryInput = z.object({
  mode: z.enum(['remaining', 'all']),
  idempotencyKey: uuid,
  duplicateRiskConfirmed: z.boolean().default(false),
}).strict();
const replanInput = z.object({ version: z.number().int().positive(), idempotencyKey: uuid }).strict();
const controlInput = z.object({ version: z.number().int().positive(), paused: z.boolean() }).strict();
const calendarSettingsInput = z.object({
  version: z.number().int().positive(),
  groupChatId: broadcastFields.groupChatId,
  cardsPerMessage: broadcastFields.cardsPerMessage,
  captionTemplate: broadcastFields.captionTemplate,
  minIntervalMinutes: z.number().int().min(1).max(1440),
}).strict();
const calendarRunInput = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), idempotencyKey: uuid }).strict();

export function parseBroadcastCreate(value: unknown): BroadcastInput {
  return normalize(parse(createInput, value));
}

export function parseBroadcastUpdate(value: unknown): BroadcastUpdateInput {
  const input = parse(updateInput, value);
  return { ...normalize(input), version: input.version };
}

export const parseBroadcastVersion = (value: unknown) => parse(versionInput, value);
export const parseBroadcastRun = (value: unknown) => parse(runInput, value);
export const parseBroadcastRetry = (value: unknown) => parse(retryInput, value);
export const parseBroadcastReplan = (value: unknown) => parse(replanInput, value);
export const parseBroadcastControl = (value: unknown) => parse(controlInput, value);

export function parseCalendarSendUpdate(value: unknown): CalendarSendUpdateInput {
  const input = parse(calendarSettingsInput, value);
  const groupChatId = input.groupChatId?.trim() || null;
  if (groupChatId && !GROUP_ID.test(groupChatId)) invalid('Некорректный ID группы WhatsApp.');
  return { ...input, groupChatId, captionTemplate: validateCaptionTemplate(input.captionTemplate.trim()) };
}

/** A real calendar day within CALENDAR_SEND_MAX_DAYS of today (Asia/Almaty). */
export function parseCalendarSendRun(value: unknown, now = new Date()): { date: string; idempotencyKey: string } {
  const input = parse(calendarRunInput, value);
  const [year, month, day] = input.date.split('-').map(Number);
  const real = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === input.date;
  const today = businessDate(now);
  if (!real || input.date < addDays(today, -CALENDAR_SEND_MAX_DAYS) || input.date > addDays(today, CALENDAR_SEND_MAX_DAYS)) {
    invalid('Некорректная дата для отправки из календаря.');
  }
  return input;
}

export function parseBroadcastId(value: string): number {
  const id = Number(value);
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(id)) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный идентификатор рассылки');
  return id;
}

export function parseRunId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный идентификатор запуска');
  }
  return value.toLowerCase();
}

export function parseDeliverySeq(value: string): number {
  const seq = Number(value);
  if (!/^[1-9]\d{0,2}$/.test(value) || seq > 560) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный номер сообщения');
  return seq;
}

function normalize(input: z.infer<typeof createInput>): BroadcastInput {
  const weekdays = [...new Set(input.weekdays)].sort((left, right) => left - right);
  const groupChatId = input.groupChatId?.trim() || null;
  if (groupChatId && !GROUP_ID.test(groupChatId)) invalid('Некорректный ID группы WhatsApp.');
  if (input.enabled && !groupChatId) invalid('Для автоматической рассылки укажите группу WhatsApp.');
  if (input.enabled && weekdays.length === 0) invalid('Для автоматической рассылки выберите хотя бы один день недели.');
  const windowEnd = minutes(input.sendTime) + input.sendWindowMinutes;
  if (windowEnd >= 1440) invalid('Окно отправки должно заканчиваться до полуночи.');
  if (input.catchUpPolicy === 'until_deadline' && minutes(input.catchUpDeadline) < windowEnd) {
    invalid('Контрольное время должно быть не раньше конца окна отправки.');
  }
  if (input.partialPolicy === 'repeat_all' && !input.duplicateRiskConfirmed) {
    throw new ApiError(409, 'BROADCAST_DUPLICATE_CONFIRMATION_REQUIRED', 'Повтор всей сводки может создать дубликаты; подтвердите риск');
  }
  return {
    ...input,
    name: input.name.trim(),
    groupChatId,
    weekdays,
    captionTemplate: validateCaptionTemplate(input.captionTemplate.trim()),
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid('Некорректные настройки рассылки.');
  return result.data;
}

function invalid(message: string): never {
  throw new ApiError(422, 'VALIDATION_ERROR', message);
}

function minutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}
