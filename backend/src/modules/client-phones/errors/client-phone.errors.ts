import { ApiError } from '../../../common/errors/api-error';

export class ClientPhoneClientNotFoundError extends ApiError {
  constructor(clientId: number) {
    super(404, 'CLIENT_NOT_FOUND', 'Client not found', { clientId });
  }
}

export class ClientPhoneNotFoundError extends ApiError {
  constructor(phoneId: number) {
    super(404, 'CLIENT_PHONE_NOT_FOUND', 'Client phone not found', { phoneId });
  }
}

export class ClientPhoneDuplicateError extends ApiError {
  constructor(clientId: number, phoneNumber: string) {
    super(409, 'CLIENT_PHONE_DUPLICATE', 'Client phone already exists', {
      clientId,
      phoneNumber,
    });
  }
}

export class ClientPhoneRefKeyDuplicateError extends ApiError {
  constructor(refKey1c: string) {
    super(409, 'CLIENT_PHONE_REF_KEY_DUPLICATE', 'Client phone 1C reference already exists', {
      refKey1c,
    });
  }
}

export class ClientPhoneClientChangeUnsupportedError extends ApiError {
  constructor(phoneId: number, currentClientId: number, requestedClientId: number) {
    super(
      409,
      'CLIENT_PHONE_CLIENT_CHANGE_UNSUPPORTED',
      'Changing client for a phone is not supported',
      { phoneId, currentClientId, requestedClientId },
    );
  }
}

export class ClientPhoneIdempotencyKeyReusedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey,
    });
  }
}

export class ClientPhoneIdempotencyInProgressError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey,
    });
  }
}

export class ClientPhoneIdempotencyFailedError extends ApiError {
  constructor(idempotencyKey: string) {
    super(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey,
    });
  }
}
