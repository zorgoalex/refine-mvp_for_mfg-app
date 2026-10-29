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

export class ClientPhoneOwnerChangedError extends ApiError {
  constructor(phoneId: number, currentClientId: number, expectedClientId: number) {
    super(409, 'CLIENT_PHONE_OWNER_CHANGED', 'Телефон уже принадлежит другому клиенту; обновите карточку', { phoneId, currentClientId, expectedClientId });
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

/** The phones of the client are not the ones the screen saw (another editor, an order import, the Bitrix24 sync). */
export class ClientPhonesStaleError extends ApiError {
  constructor(clientId: number, phones: unknown[]) {
    super(409, 'CLIENT_PHONES_STALE', 'Телефоны клиента уже изменились; показаны текущие', { clientId, phones });
  }
}

export class ClientPhoneSetInvalidError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(422, 'CLIENT_PHONE_SET_INVALID', message, details);
  }
}
