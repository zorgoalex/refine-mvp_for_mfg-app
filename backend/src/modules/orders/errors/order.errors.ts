import { ApiError } from '../../../common/errors/api-error';

export interface OrderFieldError {
  field: string;
  message: string;
  code?: string;
}

export class OrderValidationError extends ApiError {
  constructor(errors: OrderFieldError[]) {
    super(422, 'VALIDATION_ERROR', 'Order payload validation failed', { errors });
  }
}

export class OrderFinalAmountNegativeError extends ApiError {
  constructor(finalAmount: number) {
    super(422, 'ORDER_FINAL_AMOUNT_NEGATIVE', 'Order final amount cannot be negative', {
      finalAmount,
    });
  }
}

export class OrderNotFoundError extends ApiError {
  constructor(orderId: number) {
    super(404, 'ORDER_NOT_FOUND', 'Заказ не найден', { orderId });
  }
}

export class OrderVersionConflictError extends ApiError {
  constructor(currentVersion: number, clientVersion: number) {
    super(
      409,
      'ORDER_VERSION_CONFLICT',
      'Заказ был изменён другим пользователем. Обновите данные и повторите действие.',
      {
        currentVersion,
        clientVersion,
      },
    );
  }
}

export class OrderDeleteIdempotencyKeyReusedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey,
    });
  }
}

export class OrderDeleteIdempotencyInProgressError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey,
    });
  }
}

export class OrderDeleteIdempotencyFailedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey,
    });
  }
}

export class ChildEntityNotFoundError extends ApiError {
  constructor(entityType: string, id: number) {
    super(404, 'CHILD_ENTITY_NOT_FOUND', 'Дочерняя запись заказа не найдена', {
      entityType,
      id,
    });
  }
}

export class ChildEntityNotOwnedError extends ApiError {
  constructor(entityType: string, id: number, orderId: number) {
    super(
      422,
      'CHILD_ENTITY_DOES_NOT_BELONG_TO_ORDER',
      'Дочерняя запись не принадлежит этому заказу',
      {
        entityType,
        id,
        orderId,
      },
    );
  }
}

export class PaymentInvalidAmountError extends ApiError {
  constructor(field: string) {
    super(422, 'PAYMENT_INVALID_AMOUNT', 'Payment amount must be greater than zero', { field });
  }
}

export class DetailInvalidDimensionsError extends ApiError {
  constructor(field: string) {
    super(422, 'DETAIL_INVALID_DIMENSIONS', 'Detail dimensions must be greater than zero', {
      field,
    });
  }
}

export class DowelingLinkDuplicateError extends ApiError {
  constructor(dowelingOrderId: number) {
    super(422, 'DOWELING_LINK_DUPLICATE', 'Doweling order can be linked only once', {
      dowelingOrderId,
    });
  }
}
