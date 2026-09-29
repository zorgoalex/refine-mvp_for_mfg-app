import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiError, createInternalError, formatApiError } from './api-error';

interface RequestWithRequestId {
  requestId?: string;
  method?: string;
  url?: string;
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithRequestId>();
    const response = context.getResponse();
    const requestId = request.requestId ?? 'req_unknown';

    if (exception instanceof ApiError) {
      response.status(exception.statusCode).json(formatApiError(exception, requestId));
      return;
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const responseBody = exception.getResponse();
      const message =
        typeof responseBody === 'object' && responseBody !== null && 'message' in responseBody
          ? String((responseBody as { message: unknown }).message)
          : exception.message;

      response
        .status(statusCode)
        .json(formatApiError(new ApiError(statusCode, 'HTTP_ERROR', message), requestId));
      return;
    }

    const guard = mapDatabaseGuardError(exception);
    if (guard) {
      response.status(guard.statusCode).json(formatApiError(guard, requestId));
      return;
    }

    this.logger.error(
      `Unhandled exception requestId=${requestId} method=${request.method ?? 'UNKNOWN'} path=${request.url ?? 'UNKNOWN'} error=${describeException(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(createInternalError(requestId));
  }
}

function describeException(exception: unknown): string {
  if (exception instanceof Error) {
    return exception.message;
  }
  if (typeof exception === 'string') {
    return exception;
  }
  return 'Unknown non-Error exception';
}

/**
 * DB guard triggers of production rounds («Переделка», migrations 220–222) raise
 * P0001 with a stable code as the message. They fire on any write path (order
 * save, status change, automation, Bitrix, …); answer 409 with that code instead
 * of an opaque 500.
 */
const DATABASE_GUARD_MESSAGES: Readonly<Record<string, string>> = {
  ORDER_REWORK_REQUIRES_COMMAND: 'Статус «Переделка» ставится только командой переделки',
  ORDER_REWORK_ROUND_OPEN_AT_TERMINAL: 'У заказа открыт круг переделки',
  ORDER_REWORK_STATUS_WITHOUT_ROUND: 'Статус «Переделка» возможен только при открытом круге переделки',
  STAGE_EVENT_WRITE_REQUIRES_BACKEND: 'Отметка этапов выполняется через сервер. Обновите страницу',
  STAGE_EVENT_ROUND_MISMATCH: 'Отметка этапа не относится к текущему кругу производства',
  STAGE_EVENT_PAST_ROUND_DELETE: 'Отметку прошлого круга производства удалить нельзя',
  STAGE_EVENT_PAST_ROUND_UPDATE: 'Отметку прошлого круга производства изменить нельзя',
  STAGE_EVENT_IDENTITY_IMMUTABLE: 'Отметку этапа нельзя перенести в другой круг, заказ или этап',
};

export function mapDatabaseGuardError(exception: unknown): ApiError | null {
  const candidate = exception as { code?: unknown; message?: unknown } | null;
  if (!candidate || candidate.code !== 'P0001' || typeof candidate.message !== 'string') {
    return null;
  }
  const code = candidate.message.trim();
  const message = DATABASE_GUARD_MESSAGES[code];
  return message ? new ApiError(409, code, message) : null;
}
