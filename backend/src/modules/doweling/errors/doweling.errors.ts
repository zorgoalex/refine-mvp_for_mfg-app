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
