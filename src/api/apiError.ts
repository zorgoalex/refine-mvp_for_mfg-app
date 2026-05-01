export type ApiErrorCode =
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'VALIDATION_ERROR'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_VERSION_CONFLICT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR'
  | string;

export interface ApiErrorParams {
  code: ApiErrorCode;
  message: string;
  status: number;
  requestId?: string;
  details?: unknown;
}

export interface BackendErrorBody {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  code: ApiErrorCode;
  status: number;
  requestId?: string;
  details?: unknown;

  constructor(params: ApiErrorParams) {
    super(params.message);
    this.name = 'ApiError';
    this.code = params.code;
    this.status = params.status;
    this.requestId = params.requestId;
    this.details = params.details;
  }
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  return code ? error.code === code : true;
}

export function createApiErrorFromBody(
  status: number,
  statusText: string,
  body: BackendErrorBody | null,
): ApiError {
  const backendError = body?.error;

  return new ApiError({
    code: backendError?.code || `HTTP_${status}`,
    message: backendError?.message || statusText || 'Request failed',
    status,
    requestId: backendError?.requestId,
    details: backendError?.details,
  });
}
