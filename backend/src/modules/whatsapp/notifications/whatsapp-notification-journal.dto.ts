import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';

const STATES = ['queued', 'sending', 'sent', 'failed', 'unknown', 'cancelled', 'skipped'] as const;

/** A real calendar day (2026-02-30 and year 0000 are refused here, not by PostgreSQL). */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, date] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return year >= 1 && parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date;
});

const querySchema = z.object({
  page: z.coerce.number().int().positive().max(10_000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
  state: z.enum(STATES).optional(),
  level: z.enum(['info', 'warning', 'error']).optional(),
  recipientKind: z.enum(['user', 'chat']).optional(),
  sourceType: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional(),
  /** Days of `created_at` in the server's time zone, both inclusive. */
  from: day.optional(),
  to: day.optional(),
  search: z.string().trim().min(1).max(120).optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to);

export type WhatsAppNotificationJournalQuery = z.infer<typeof querySchema>;

export function parseWhatsAppNotificationJournalQuery(value: Record<string, unknown>): WhatsAppNotificationJournalQuery {
  const parsed = querySchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(422, 'INVALID_WHATSAPP_NOTIFICATION_JOURNAL_QUERY', 'Некорректные фильтры журнала уведомлений WhatsApp');
  }
  return parsed.data;
}
