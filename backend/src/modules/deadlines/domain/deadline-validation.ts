import { z } from 'zod';
import { DEADLINE_STATUSES } from './deadline-status';

export const DEADLINE_ENTITY_TYPES = ['order', 'order_stage', 'client_action', 'project', 'task'] as const;
export const DEADLINE_SOURCES = ['policy', 'manual', 'imported', 'recalculated', 'system'] as const;
export const DEADLINE_PAUSE_MODES = [
  'pause_without_shift',
  'pause_and_shift_deadline',
] as const;

export type DeadlineEntityType = (typeof DEADLINE_ENTITY_TYPES)[number];
export type DeadlineSource = (typeof DEADLINE_SOURCES)[number];
export type DeadlinePauseMode = (typeof DEADLINE_PAUSE_MODES)[number];

export const metadataSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .refine(
    (value) => value === undefined || JSON.stringify(value).length <= 10_000,
    'metadata must be 10000 bytes or fewer',
  );

export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid ISO datetime');

export const deadlineEntityTypeSchema = z.enum(DEADLINE_ENTITY_TYPES);
export const deadlineStatusSchema = z.enum(DEADLINE_STATUSES);
export const deadlineSourceSchema = z.enum(DEADLINE_SOURCES);
export const deadlinePauseModeSchema = z.enum(DEADLINE_PAUSE_MODES);

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
