import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import { validateOrderSendCaption } from './order-send-caption';
import { ORDER_FORM_CODES, ORDER_SEND_MAX_CHATS, type OrderFormCode, type OrderSendSettingsInput, type OrderSendTarget } from './order-send.types';

const GROUP_ID = /^\d{5,24}(?:-\d{5,24})?@g\.us$/;
const form = z.enum(ORDER_FORM_CODES as [OrderFormCode, ...OrderFormCode[]]);
const forms = z.array(form).max(ORDER_FORM_CODES.length).transform((list) => [...new Set(list)]);

const settingsInput = z.object({
  version: z.number().int().positive(),
  enabled: z.boolean(),
  minIntervalMinutes: z.number().int().min(1).max(1440),
  sendWindowMinutes: z.number().int().min(0).max(720),
  clientForms: forms,
  clientCaption: z.string().max(1000),
  chats: z.array(z.object({
    chatKey: z.string().uuid().nullable(),
    groupChatId: z.string().trim().regex(GROUP_ID),
    label: z.string().trim().min(1).max(100),
    forms,
    caption: z.string().max(1000),
  }).strict()).max(ORDER_SEND_MAX_CHATS),
}).strict();

const sendInput = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('client') }).strict(),
    z.object({ kind: z.literal('chat'), chatKey: z.string().uuid() }).strict(),
  ]),
  form,
  idempotencyKey: z.string().uuid(),
  /** Explicit «send again» after the previous send of the same order, recipient and form ended unknown. */
  confirmAfterUnknown: z.string().uuid().nullable().optional(),
}).strict();

export function parseOrderSendSettings(value: unknown): OrderSendSettingsInput {
  const parsed = settingsInput.safeParse(value);
  if (!parsed.success) throw validation(parsed.error);
  const input = parsed.data;
  if (input.sendWindowMinutes * 2 > input.minIntervalMinutes) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Окно отправки — не больше половины порога частоты');
  }
  const groups = new Set<string>();
  for (const chat of input.chats) {
    if (groups.has(chat.groupChatId)) throw new ApiError(422, 'VALIDATION_ERROR', 'Одна группа указана в списке чатов дважды');
    groups.add(chat.groupChatId);
    validateOrderSendCaption(chat.caption);
  }
  const keys = input.chats.map((chat) => chat.chatKey).filter((key): key is string => key !== null);
  if (new Set(keys).size !== keys.length) throw new ApiError(422, 'VALIDATION_ERROR', 'Чат указан в списке дважды');
  validateOrderSendCaption(input.clientCaption);
  return input;
}

export function parseOrderSendCommand(value: unknown): { target: OrderSendTarget; form: OrderFormCode; idempotencyKey: string; confirmAfterUnknown?: string | null } {
  const parsed = sendInput.safeParse(value);
  if (!parsed.success) throw validation(parsed.error);
  return parsed.data;
}

export function parseOrderId(value: string): number {
  if (!/^[1-9]\d{0,15}$/.test(value)) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный ID заказа');
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный ID заказа');
  return id;
}

function validation(error: z.ZodError): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Некорректный запрос', { issues: error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
}
