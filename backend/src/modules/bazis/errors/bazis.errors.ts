import { ApiError } from '../../../common/errors/api-error';

export class BazisDatabaseUnavailableError extends ApiError {
  constructor() {
    super(503, 'BAZIS_DB_UNAVAILABLE', 'База данных недоступна');
  }
}

export class BazisProjectNotFoundError extends ApiError {
  constructor(id: number) {
    super(404, 'BAZIS_PROJECT_NOT_FOUND', `Базис-проект ${id} не найден`);
  }
}

export class BazisRevisionNotFoundError extends ApiError {
  constructor(id: number) {
    super(404, 'BAZIS_REVISION_NOT_FOUND', `Ревизия ${id} не найдена`);
  }
}

export class BazisRevisionDuplicateError extends ApiError {
  constructor(revisionNo: number) {
    super(409, 'BAZIS_REVISION_DUPLICATE', `Этот файл уже импортирован (ревизия ${revisionNo})`, {
      revisionNo,
    });
  }
}

export class BazisParseFailedError extends ApiError {
  constructor(message: string) {
    super(422, 'BAZIS_PARSE_FAILED', `Файл Базиса не распознан: ${message}`);
  }
}

export class BazisNoPanelsSelectedError extends ApiError {
  constructor() {
    super(422, 'BAZIS_NO_PANELS', 'В выбранных узлах нет панелей');
  }
}

export class BazisReferenceNotFoundError extends ApiError {
  constructor(what: string) {
    super(404, 'BAZIS_REFERENCE_NOT_FOUND', `Связанная запись не найдена: ${what}`);
  }
}

export class BazisIdempotencyKeyReusedError extends ApiError {
  constructor() {
    super(409, 'BAZIS_IDEMPOTENCY_REUSED', 'Ключ идемпотентности использован с другими параметрами');
  }
}

export class BazisIdempotencyInProgressError extends ApiError {
  constructor() {
    super(409, 'BAZIS_IDEMPOTENCY_IN_PROGRESS', 'Команда с этим ключом уже выполняется');
  }
}

export class BazisIdempotencyFailedError extends ApiError {
  constructor() {
    super(409, 'BAZIS_IDEMPOTENCY_FAILED', 'Предыдущее выполнение с этим ключом завершилось ошибкой');
  }
}
