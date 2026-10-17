import { ApiError } from '../../../common/errors/api-error';

/**
 * Chosen when `database.isConfigured` is false (DB outage / not wired). This is an INFRA 503 —
 * distinct from the flag-off 503 (SERVICE_UNAVAILABLE) that the controller throws at request time.
 * Mirrors unavailable-client-phone-repository.ts.
 */
export class DowelingDatabaseUnavailableError extends ApiError {
  constructor() {
    super(503, 'DATABASE_UNAVAILABLE', 'Database is not configured', {});
  }
}

export class DowelingReferenceNotFoundError extends ApiError {
  constructor(details: Record<string, unknown>) {
    super(404, 'DOWELING_REFERENCE_NOT_FOUND', 'Связанная запись присадки не найдена', details);
  }
}

export class DowelingIdempotencyKeyReusedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey,
    });
  }
}

export class DowelingIdempotencyInProgressError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey,
    });
  }
}

export class DowelingIdempotencyFailedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey,
    });
  }
}

export class DowelingOrderNotFoundError extends ApiError {
  constructor(dowelingOrderId: number) {
    super(404, 'DOWELING_ORDER_NOT_FOUND', 'Присадка не найдена', { dowelingOrderId });
  }
}

export class DowelingLinkedOrderNotFoundError extends ApiError {
  constructor(orderIds: number[]) {
    super(404, 'ORDER_NOT_FOUND', 'Заказ не найден', { orderIds });
  }
}

export class DowelingVersionConflictError extends ApiError {
  constructor(dowelingOrderId: number, expectedVersion: number, currentVersion: number) {
    super(409, 'DOWELING_VERSION_CONFLICT', 'Присадку уже изменили. Обновите карточку и повторите', {
      dowelingOrderId,
      expectedVersion,
      currentVersion,
    });
  }
}

export class DowelingLinksConflictError extends ApiError {
  constructor(dowelingOrderId: number, baseOrderIds: number[], currentOrderIds: number[]) {
    super(409, 'DOWELING_LINKS_CONFLICT', 'Заказы присадки уже изменили. Обновите карточку и повторите', {
      dowelingOrderId,
      baseOrderIds,
      currentOrderIds,
    });
  }
}

export class DowelingConcurrentChangeError extends ApiError {
  constructor(dowelingOrderId: number) {
    super(409, 'DOWELING_CONCURRENT_CHANGE', 'Присадку одновременно изменяют. Повторите сохранение', { dowelingOrderId });
  }
}

export class DowelingDuplicateError extends ApiError {
  constructor(constraint: string | null) {
    super(409, 'DOWELING_DUPLICATE', duplicateMessage(constraint), { constraint });
  }
}

export class DowelingAmountsInvalidError extends ApiError {
  constructor(constraint: string | null) {
    super(422, 'DOWELING_AMOUNTS_INVALID', amountsMessage(constraint), { constraint });
  }
}

function duplicateMessage(constraint: string | null): string {
  if (constraint === 'idx_doweling_orders__ref_key_1c') return 'Присадка с таким Ref Key 1C уже есть';
  if (constraint === 'uq_doweling_orders_order_name_active') return 'У заказа уже есть присадка с таким названием';
  return 'Такая присадка уже есть';
}

const AMOUNT_MESSAGES: Record<string, string> = {
  chk_doweling_orders_final_amount_consistent: '«Итого со скидкой» должно быть равно: сумма − скидка + наценка',
  chk_doweling_orders_discount_valid: '«Итого со скидкой» не может быть больше суммы',
  chk_doweling_orders_payment_valid: '«Оплачено» не может быть больше итога',
  chk_doweling_orders_payment_date_not_future: 'Дата оплаты не может быть в будущем',
  chk_doweling_orders_parts_count: 'Количество деталей не может быть отрицательным',
};

function amountsMessage(constraint: string | null): string {
  return (constraint && AMOUNT_MESSAGES[constraint]) || 'Суммы присадки не согласованы';
}
