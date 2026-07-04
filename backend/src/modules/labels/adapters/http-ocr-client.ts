import { ApiError } from '../../../common/errors/api-error';
import type { OcrLine, OcrPort } from '../application/labels.types';

export type OcrFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10000;

export interface HttpOcrClientOptions {
  /** Request timeout in ms (AbortSignal.timeout). Default 10000. Injectable for tests. */
  timeoutMs?: number;
  /** Injectable fetch implementation (default: global fetch). */
  fetchFn?: OcrFetchFn;
}

/**
 * HTTP adapter for the standalone ocr-service (T1: POST /ocr, raw image bytes in →
 * {lines:[{text,score,box}],durationMs} out; 429 when busy).
 *
 * Recognition boxes are intentionally dropped when mapping the response — the backend
 * only needs text + score for downstream matching (see OcrLine).
 */
export class HttpOcrClient implements OcrPort {
  private readonly fetchFn: OcrFetchFn;
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    options?: HttpOcrClientOptions,
  ) {
    this.fetchFn = options?.fetchFn ?? (fetch as unknown as OcrFetchFn);
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async recognize(image: Buffer, contentType: string): Promise<{ lines: OcrLine[]; durationMs: number }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: image,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Network error, DNS failure, connection refused, or timeout abort — all
      // surface identically to callers: the ocr-service is not reachable right now.
      throw new ApiError(503, 'OCR_SERVICE_UNAVAILABLE', 'OCR service is unavailable');
    }

    if (res.status === 429) {
      throw new ApiError(503, 'OCR_SERVICE_BUSY', 'OCR service is busy');
    }
    if (!res.ok) {
      throw new ApiError(503, 'OCR_SERVICE_UNAVAILABLE', 'OCR service is unavailable');
    }

    let json: { lines?: Array<{ text: string; score: number }>; durationMs?: number };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new ApiError(503, 'OCR_SERVICE_UNAVAILABLE', 'OCR service returned an invalid response');
    }

    const lines: OcrLine[] = (json.lines ?? []).map((line) => ({ text: line.text, score: line.score }));
    return { lines, durationMs: json.durationMs ?? 0 };
  }
}

/** Fail-closed OcrPort used when OCR_SERVICE_BASE_URL is not configured (pattern: UnavailableLabelsRepository et al.). */
export class UnavailableOcrClient implements OcrPort {
  async recognize(): Promise<{ lines: OcrLine[]; durationMs: number }> {
    throw new ApiError(503, 'OCR_SERVICE_UNAVAILABLE', 'OCR service is not configured');
  }
}

/**
 * Construct the OcrPort implementation from env config. Exported standalone (rather than
 * wired into LabelsModule) so this task (T3) does not need to touch labels.module.ts or
 * LabelsService's constructor — T4 wires OcrPort into LabelsService and is expected to call
 * `createOcrClientFromEnv(config.get('OCR_SERVICE_BASE_URL', { infer: true }))` from the
 * module's useFactory, mirroring the VlmModule / labels.module.ts DI pattern.
 */
export function createOcrClientFromEnv(baseUrl: string | undefined | null): OcrPort {
  return baseUrl ? new HttpOcrClient(baseUrl) : new UnavailableOcrClient();
}
