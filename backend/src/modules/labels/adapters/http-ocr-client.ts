import { ApiError } from '../../../common/errors/api-error';
import type { OcrLine, OcrPort } from '../application/labels.types';

export type OcrFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 20_000;

export interface HttpOcrClientOptions {
  /** Request timeout in ms (AbortSignal.timeout). Default 10000. Injectable for tests. */
  timeoutMs?: number;
  /** Injectable fetch implementation (default: global fetch). */
  fetchFn?: OcrFetchFn;
}

/**
 * HTTP adapter for the standalone ocr-service (T1: POST /ocr, raw image bytes in →
 * {lines:[{text,score,box}],durationMs,imageWidth,imageHeight} out; 429 when busy).
 *
 * Recognition boxes and processed-image dims are passed through (shape-safe: malformed
 * `box`/dims are dropped, never thrown). The scan path (scanResolveImage/scanResolveFields)
 * still only reads text/score and ignores box/dims; preview/testOcrTemplate use them to let
 * the FE overlay boxes on the uploaded photo.
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

  async recognize(
    image: Buffer,
    contentType: string,
  ): Promise<{ lines: OcrLine[]; durationMs: number; imageWidth?: number; imageHeight?: number }> {
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
    if (res.status === 400) {
      // ocr-service 400 = input problem (unreadable image / image-bomb dimensions
      // guard), not a service outage. Surface as a client-fixable 422 instead of
      // collapsing it into the generic 503 UNAVAILABLE — the raw service detail
      // goes in `details`, never interpolated into the message shown to users.
      let detail: string | undefined;
      try {
        const body = (await res.json()) as { detail?: unknown } | null;
        detail = typeof body?.detail === 'string' ? body.detail : undefined;
      } catch {
        detail = undefined;
      }
      throw new ApiError(422, 'OCR_IMAGE_UNREADABLE', 'Could not read the label image', {
        ocrServiceDetail: detail,
      });
    }
    if (!res.ok) {
      throw new ApiError(503, 'OCR_SERVICE_UNAVAILABLE', 'OCR service is unavailable');
    }

    // Shape-safe parsing: a 2xx with a malformed body (unparsable JSON, `null`,
    // non-array `lines`, junk line entries) must surface as the contractual
    // ApiError 503, never as a raw TypeError leaking out of the adapter.
    try {
      const json = (await res.json()) as
        | { lines?: unknown; durationMs?: unknown; imageWidth?: unknown; imageHeight?: unknown }
        | null;
      if (json == null || !Array.isArray(json.lines)) {
        throw new Error('malformed ocr response shape');
      }
      const lines: OcrLine[] = (
        json.lines as Array<{ text?: unknown; score?: unknown; box?: unknown } | null>
      ).map((line) => ({
        text: String(line?.text ?? ''),
        score: Number(line?.score ?? 0),
        box: parseBox(line?.box),
      }));
      const durationMs = Number(json.durationMs ?? 0);
      const imageWidth = Number(json.imageWidth);
      const imageHeight = Number(json.imageHeight);
      return {
        lines,
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
        imageWidth: Number.isFinite(imageWidth) ? imageWidth : undefined,
        imageHeight: Number.isFinite(imageHeight) ? imageHeight : undefined,
      };
    } catch {
      throw new ApiError(503, 'OCR_SERVICE_UNAVAILABLE', 'OCR service returned an invalid response');
    }
  }
}

/** Shape-safe `box` parse: only accept an array of 4 [x,y] pairs (length-2 finite-number
 *  arrays). Anything else (missing, wrong shape, non-numeric entries) → undefined, never throws. */
function parseBox(value: unknown): number[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points: number[][] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) return undefined;
    const [x, y] = point;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return undefined;
    }
    points.push([x, y]);
  }
  return points.length > 0 ? points : undefined;
}

/** Fail-closed OcrPort used when OCR_SERVICE_BASE_URL is not configured (pattern: UnavailableLabelsRepository et al.). */
export class UnavailableOcrClient implements OcrPort {
  async recognize(): Promise<{ lines: OcrLine[]; durationMs: number; imageWidth?: number; imageHeight?: number }> {
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
