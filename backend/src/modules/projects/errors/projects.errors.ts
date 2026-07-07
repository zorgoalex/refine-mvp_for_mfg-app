import { ApiError } from '../../../common/errors/api-error';

export class ProjectNotFoundError extends ApiError {
  constructor(projectId: number) {
    super(404, 'PROJECT_NOT_FOUND', `Проект ${projectId} не найден`);
  }
}

export class ProjectArchivedError extends ApiError {
  constructor(projectId: number) {
    super(422, 'PROJECT_ARCHIVED', `Проект ${projectId} архивирован`);
  }
}

export class ProjectClientMismatchError extends ApiError {
  constructor() {
    super(422, 'PROJECT_CLIENT_MISMATCH', 'Клиент заказа не совпадает с клиентом проекта');
  }
}

export class ProjectCodeTakenError extends ApiError {
  constructor(code: string) {
    super(409, 'PROJECT_CODE_TAKEN', `Код «${code}» уже занят`);
  }
}

export class ProjectVersionConflictError extends ApiError {
  constructor() {
    super(409, 'VERSION_CONFLICT', 'Проект изменён другим пользователем');
  }
}

export class ProjectHasOrdersError extends ApiError {
  constructor() {
    super(422, 'PROJECT_HAS_ORDERS', 'Нельзя удалить проект с заказами');
  }
}

export class ProjectDatabaseUnavailableError extends ApiError {
  constructor() {
    super(503, 'DATABASE_UNAVAILABLE', 'База данных недоступна');
  }
}
