import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';

/**
 * «Переделка» (production rounds), plan 2026-09-27-order-rework-status-plan v18.
 * Pure request contracts and rules shared by the rework commands.
 */

export const ORDER_REWORK_COMMENT_MAX = 2000;
export const ORDER_REWORK_MAX_DETAILS = 500;

export type OrderReworkMode = 'after_ready' | 'in_production';

/** «Готов к выдаче», «Выдан»: the order enters «Переделка». */
export const REWORK_AFTER_READY_STATUS_CODES: readonly string[] = ['legacy_6', 'legacy_7'];
/** «Оформлен», «Запланирован», «В производстве», «Распилен»: a round opens, the order status stays (D6). */
export const REWORK_IN_PRODUCTION_STATUS_CODES: readonly string[] = ['legacy_2', 'legacy_3', 'legacy_4', 'legacy_5'];
export const REWORK_STATUS_CODE = 'rework';
export const REWORK_SYSTEM_REASON_CODE = 'unclarified';

export function resolveReworkMode(orderStatusCode: string): OrderReworkMode | null {
  if (REWORK_AFTER_READY_STATUS_CODES.includes(orderStatusCode)) return 'after_ready';
  if (REWORK_IN_PRODUCTION_STATUS_CODES.includes(orderStatusCode)) return 'in_production';
  return null;
}

const commentSchema = z.string().max(ORDER_REWORK_COMMENT_MAX * 2).nullable().optional();

export const startOrExtendReworkRequestSchema = z
  .object({
    /** Required when a round is started; must be absent when details join the open round. */
    reasonId: z.number().int().positive().optional(),
    comment: commentSchema,
    details: z
      .array(
        z
          .object({
            detailId: z.number().int().positive(),
            productionStatusId: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(ORDER_REWORK_MAX_DETAILS),
  })
  .strict();

export type StartOrExtendReworkRequest = z.infer<typeof startOrExtendReworkRequestSchema>;

export const clarifyReworkReasonRequestSchema = z
  .object({
    reasonId: z.number().int().positive(),
    comment: commentSchema,
  })
  .strict();

export type ClarifyReworkReasonRequest = z.infer<typeof clarifyReworkReasonRequestSchema>;

export const falsePositiveReworkRequestSchema = z
  .object({
    comment: commentSchema,
  })
  .strict();

export type FalsePositiveReworkRequest = z.infer<typeof falsePositiveReworkRequestSchema>;

export function parseReworkRequest<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректные параметры переделки', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

/** Trims; empty becomes null. Enforces the length limit and the reason's «comment required» rule. */
export function normalizeReworkComment(value: string | null | undefined, requiresComment: boolean): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > ORDER_REWORK_COMMENT_MAX) {
    throw new ApiError(422, 'ORDER_REWORK_COMMENT_TOO_LONG', `Комментарий длиннее ${ORDER_REWORK_COMMENT_MAX} символов`);
  }
  if (requiresComment && trimmed.length === 0) {
    throw new ApiError(422, 'ORDER_REWORK_COMMENT_REQUIRED', 'Для этой причины нужен комментарий');
  }
  return trimmed.length === 0 ? null : trimmed;
}

export function assertUniqueReworkDetails(details: readonly { detailId: number }[]): void {
  const seen = new Set<number>();
  for (const detail of details) {
    if (seen.has(detail.detailId)) {
      throw new ApiError(422, 'ORDER_REWORK_DUPLICATE_DETAIL', 'Деталь указана несколько раз', {
        detailId: detail.detailId,
      });
    }
    seen.add(detail.detailId);
  }
}

/** Outbox key for a rework domain event: orderId + round + event + per-round sequence. */
export function reworkOutboxKey(orderId: number, roundNo: number, event: string, seq: number): string {
  return `order:${orderId}:rework:${roundNo}:${event}:${seq}`;
}
