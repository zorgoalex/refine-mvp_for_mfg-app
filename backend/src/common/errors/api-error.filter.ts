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

    const merged = clientMergedError(exception);
    if (merged) {
      response.status(merged.statusCode).json(formatApiError(merged, requestId));
      return;
    }

    this.logger.error(
      `Unhandled exception requestId=${requestId} method=${request.method ?? 'UNKNOWN'} path=${request.url ?? 'UNKNOWN'} error=${describeException(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(createInternalError(requestId));
  }
}

/**
 * A write that referenced a client merged into another one (the guard triggers of migration 268), from any path that
 * does not map it itself: a conflict with the client to use instead.
 */
export function clientMergedError(exception: unknown): ApiError | null {
  const error = exception as { code?: unknown; constraint?: unknown; detail?: unknown } | null;
  if (!error || error.code !== '23514' || error.constraint !== 'chk_client_not_merged') return null;
  const detail = typeof error.detail === 'string' ? error.detail : '';
  const merged = /merged_client_id=(\d+)/.exec(detail)?.[1];
  const survivor = /survivor_id=(\d+)/.exec(detail)?.[1];
  return new ApiError(409, 'CLIENT_MERGED', 'Клиент объединён с другим клиентом; выберите остающегося клиента', {
    mergedClientId: merged ? Number(merged) : null, survivorId: survivor ? Number(survivor) : null,
  });
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
