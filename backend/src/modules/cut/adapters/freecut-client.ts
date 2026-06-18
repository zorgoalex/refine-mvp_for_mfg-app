import { ApiError } from '../../../common/errors/api-error';
import type {
  FreecutOptimizeResponse,
  OptimizeRequest,
} from '../application/cut-freecut-mapping';

type FetchLike = typeof fetch;

export interface FreecutClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

interface FreecutErrorBody {
  status?: string;
  error_code?: string;
  message?: string;
  details?: unknown;
}

/**
 * Thin client for the internal-only freecut optimizer (plan §6/§8). Native fetch
 * + AbortController timeout (no axios/retry lib, matching pg-order-exporter).
 * Freecut error mapping: 429/408/timeout -> retryable; 422 (CONSTRAINT_ERROR) /
 * 413 (body too large) -> non-retryable client errors surfaced with the reason.
 */
export class FreecutClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: FreecutClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async optimize(request: OptimizeRequest): Promise<FreecutOptimizeResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw await this.mapErrorResponse(response);
      }

      return (await response.json()) as FreecutOptimizeResponse;
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async mapErrorResponse(response: Response): Promise<ApiError> {
    const body = await this.safeJson(response);
    const message = body?.message ?? `freecut responded with ${response.status}`;
    const details = { freecutStatus: response.status, errorCode: body?.error_code, freecutMessage: body?.message };

    switch (response.status) {
      case 413:
        return new ApiError(413, 'FREECUT_REQUEST_TOO_LARGE', message, details);
      case 422:
        return new ApiError(422, 'FREECUT_CONSTRAINT_ERROR', message, details);
      case 400:
        return new ApiError(422, 'FREECUT_VALIDATION_ERROR', message, details);
      case 408:
        return new ApiError(504, 'FREECUT_TIMEOUT', message, details);
      case 429:
        return new ApiError(503, 'FREECUT_OVERLOADED', message, details);
      default:
        return new ApiError(502, 'FREECUT_PROVIDER_ERROR', message, details);
    }
  }

  private async safeJson(response: Response): Promise<FreecutErrorBody | null> {
    try {
      return (await response.json()) as FreecutErrorBody;
    } catch {
      return null;
    }
  }

  private normalizeError(error: unknown): ApiError {
    if (error instanceof ApiError) {
      return error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new ApiError(504, 'FREECUT_TIMEOUT', 'freecut optimization timed out', {
        timeoutMs: this.timeoutMs,
      });
    }
    return new ApiError(502, 'FREECUT_PROVIDER_ERROR', 'freecut optimization failed');
  }
}
