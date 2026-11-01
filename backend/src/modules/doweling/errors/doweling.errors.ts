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
    super(404, 'DOWELING_REFERENCE_NOT_FOUND', 'Связанная запись Базис-проекта не найдена', details);
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
    super(404, 'DOWELING_ORDER_NOT_FOUND', 'Базис-проект не найден', { dowelingOrderId });
  }
}

export class DowelingLinkedOrderNotFoundError extends ApiError {
  constructor(orderIds: number[]) {
    super(404, 'ORDER_NOT_FOUND', 'Заказ не найден', { orderIds });
  }
}

export class DowelingVersionConflictError extends ApiError {
  constructor(dowelingOrderId: number, expectedVersion: number, currentVersion: number) {
    super(409, 'DOWELING_VERSION_CONFLICT', 'Базис-проект уже изменили. Обновите карточку и повторите', {
      dowelingOrderId,
      expectedVersion,
      currentVersion,
    });
  }
}

export class DowelingLinksConflictError extends ApiError {
  constructor(dowelingOrderId: number, baseOrderIds: number[], currentOrderIds: number[]) {
    super(409, 'DOWELING_LINKS_CONFLICT', 'Заказы Базис-проекта уже изменили. Обновите карточку и повторите', {
      dowelingOrderId,
      baseOrderIds,
      currentOrderIds,
    });
  }
}

export class DowelingConcurrentChangeError extends ApiError {
  constructor(dowelingOrderId: number) {
    super(409, 'DOWELING_CONCURRENT_CHANGE', 'Базис-проект одновременно изменяют. Повторите сохранение', { dowelingOrderId });
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
  if (constraint === 'idx_doweling_orders__ref_key_1c') return 'Базис-проект с таким Ref Key 1C уже есть';
  if (constraint === 'uq_doweling_orders_order_name_active') return 'У заказа уже есть Базис-проект с таким названием';
  return 'Такой Базис-проект уже есть';
}

const AMOUNT_MESSAGES: Record<string, string> = {
  chk_doweling_orders_final_amount_consistent: '«Итого со скидкой» должно быть равно: сумма − скидка + наценка',
  chk_doweling_orders_discount_valid: '«Итого со скидкой» не может быть больше суммы',
  chk_doweling_orders_payment_valid: '«Оплачено» не может быть больше итога',
  chk_doweling_orders_payment_date_not_future: 'Дата оплаты не может быть в будущем',
  chk_doweling_orders_parts_count: 'Количество деталей не может быть отрицательным',
};

function amountsMessage(constraint: string | null): string {
  return (constraint && AMOUNT_MESSAGES[constraint]) || 'Суммы Базис-проекта не согласованы';
}

/** The card, its live orders and its attached XML projects belong to one client (migration 279). */
export class BazisProjectClientMismatchError extends ApiError {
  constructor(dowelingOrderId: number | null, orderIds: number[], bazisProjectIds: number[] = []) {
    super(409, 'BAZIS_PROJECT_CLIENT_MISMATCH', 'Клиент Базис-проекта не совпадает с клиентом заказа', {
      dowelingOrderId,
      orderIds,
      bazisProjectIds,
    });
  }
}

/** A new Bazis project card needs its client: given, or taken from the order it is created for. */
export class BazisProjectClientRequiredError extends ApiError {
  constructor() {
    super(422, 'VALIDATION_ERROR', 'Укажите клиента Базис-проекта', {
      errors: [{ field: 'clientId', message: 'Укажите клиента Базис-проекта' }],
    });
  }
}

/** A card of an unknown client (written by the previous backend) links orders of several clients: pick the client. */
export class BazisProjectClientAmbiguousError extends ApiError {
  constructor(dowelingOrderId: number, clientIds: number[]) {
    super(409, 'BAZIS_PROJECT_CLIENT_AMBIGUOUS', 'У Базис-проекта заказы разных клиентов — выберите клиента', {
      dowelingOrderId,
      clientIds,
    });
  }
}
