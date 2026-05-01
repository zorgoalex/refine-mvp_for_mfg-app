export type ApiErrorDetails = Record<string, unknown> | undefined;

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: ApiErrorDetails) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function formatApiError(error: ApiError, requestId: string): ApiErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      requestId,
    },
  };
}

export function createInternalError(requestId: string): ApiErrorResponse {
  return formatApiError(
    new ApiError(500, 'INTERNAL_ERROR', 'Internal server error'),
    requestId,
  );
}
