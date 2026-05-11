import { ApiError } from '../../../common/errors/api-error';

export class ProductionActionOrderNotFoundError extends ApiError {
  constructor(orderId: number) {
    super(404, 'ORDER_NOT_FOUND', 'Order not found', { orderId });
  }
}

export class ProductionActionStatusNotFoundError extends ApiError {
  constructor(statusType: 'order_status' | 'production_status', statusId: number) {
    super(422, 'VALIDATION_ERROR', 'Status not found or inactive', {
      errors: [{ field: statusType, message: 'Status not found or inactive' }],
      statusType,
      statusId,
    });
  }
}

export class ProductionActionVersionConflictError extends ApiError {
  constructor(orderId: number, expectedVersion: number, currentVersion: number) {
    super(409, 'VERSION_CONFLICT', 'Order version conflict', {
      orderId,
      expectedVersion,
      currentVersion,
    });
  }
}

export class ProductionActionIdempotencyKeyReusedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey,
    });
  }
}

export class ProductionActionIdempotencyInProgressError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey,
    });
  }
}

export class ProductionActionIdempotencyFailedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey,
    });
  }
}
