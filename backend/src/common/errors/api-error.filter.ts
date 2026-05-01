import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiError, createInternalError, formatApiError } from './api-error';

interface RequestWithRequestId {
  requestId?: string;
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
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

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(createInternalError(requestId));
  }
}
