export type TwentyObject = 'companies' | 'erpOrders';

export interface TwentyApiPort {
  createRecord(object: TwentyObject, body: Record<string, unknown>): Promise<{ id: string }>;
  updateRecord(object: TwentyObject, id: string, body: Record<string, unknown>): Promise<void>;
  findIdByErpId(object: TwentyObject, erpId: string): Promise<string | null>;
  deleteRecord(object: TwentyObject, id: string): Promise<void>;
}

/** Map from plural object name → create envelope key in Twenty REST response */
const CREATE_KEY_MAP: Record<TwentyObject, string> = {
  companies: 'createCompany',
  erpOrders: 'createErpOrder',
};

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Retry/backoff tuning for the Twenty REST client. All fields optional; the
 * defaults are chosen for the in-process relay + the host backfill, both of
 * which can exhaust Twenty's API rate limiter (HTTP 429).
 */
export interface TwentyApiClientRetryOptions {
  /** Max retries AFTER the first attempt (total tries = maxRetries + 1). Default 5. */
  maxRetries?: number;
  /** Base delay for exponential backoff when no Retry-After header. Default 1000ms. */
  baseDelayMs?: number;
  /** Upper bound on a single SYNTHETIC exponential-backoff delay. Default 30000ms. */
  maxDelayMs?: number;
  /**
   * Upper bound on honoring a server `Retry-After` header. Default 120000ms.
   * A server header is authoritative and is NOT clamped to maxDelayMs (clamping
   * a legit 60s Retry-After to 30s would retry early and re-trip the limit);
   * this only bounds a pathological/hostile value so it cannot stall the relay.
   */
  maxRetryAfterMs?: number;
  /** Sleep implementation (injectable for tests). Default real setTimeout. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Jitter source in [0,1) (injectable for tests). Default Math.random. */
  randomFn?: () => number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_MAX_RETRY_AFTER_MS = 120000;

/**
 * HTTP adapter for the Twenty CRM REST API.
 * Inject a custom fetch fn for unit tests (default: global fetch).
 * NEVER logs the apiKey.
 *
 * Resilient to Twenty's API rate limiter: an HTTP 429 is retried with a bounded
 * exponential backoff (honoring a Retry-After header when present). 429 is
 * rejected by Twenty BEFORE the request handler runs, so retrying is
 * side-effect-safe even for POST/PATCH/DELETE. Non-429 errors are never
 * retried — they surface immediately as before.
 */
export class TwentyApiClient implements TwentyApiPort {
  private readonly f: FetchFn;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    fetchFn?: FetchFn,
    opts?: TwentyApiClientRetryOptions,
  ) {
    this.f = fetchFn ?? (fetch as unknown as FetchFn);
    this.maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = opts?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxRetryAfterMs = opts?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.sleep = opts?.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = opts?.randomFn ?? Math.random;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Perform the request, retrying on HTTP 429 up to maxRetries with backoff.
   * Returns the final Response (ok or not) so callers keep their own
   * status-specific error handling for everything except the retry-on-429.
   */
  private async request(url: string, init: RequestInit): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const res = await this.f(url, init);
      if (res.status !== 429 || attempt >= this.maxRetries) {
        return res;
      }
      await this.sleep(this.retryDelayMs(res, attempt));
      attempt += 1;
    }
  }

  /** Delay before the next retry: Retry-After if usable, else capped exponential backoff with full jitter. */
  private retryDelayMs(res: Response, attempt: number): number {
    const retryAfter = this.parseRetryAfterMs(res);
    if (retryAfter !== null) {
      // Server header is authoritative — honor it, bounded only by the (much
      // larger) maxRetryAfterMs, never the synthetic-backoff cap.
      return Math.min(retryAfter, this.maxRetryAfterMs);
    }
    const capped = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    // Full jitter in [0.5*capped, capped] — randomFn=()=>1 yields exactly `capped`.
    return Math.floor(capped * (0.5 + 0.5 * this.random()));
  }

  /** Parse a Retry-After header (delta-seconds or HTTP-date) to ms, or null when absent/unusable. */
  private parseRetryAfterMs(res: Response): number | null {
    const raw = res.headers?.get?.('retry-after');
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(raw);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
    return null;
  }

  async createRecord(object: TwentyObject, body: Record<string, unknown>): Promise<{ id: string }> {
    const res = await this.request(`${this.baseUrl}/rest/${object}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Twenty create ${object} failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: Record<string, { id?: string } | undefined> };
    const envelopeKey = CREATE_KEY_MAP[object];
    const record = json.data?.[envelopeKey];
    if (!record?.id) {
      throw new Error(`Twenty create ${object}: unexpected response shape ${JSON.stringify(json)}`);
    }
    return { id: record.id };
  }

  async updateRecord(object: TwentyObject, id: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.request(`${this.baseUrl}/rest/${object}/${id}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Twenty update ${object}/${id} failed: ${res.status} ${await res.text()}`);
    }
  }

  async findIdByErpId(object: TwentyObject, erpId: string): Promise<string | null> {
    const filterValue = encodeURIComponent(`erpId[eq]:${erpId}`);
    const url = `${this.baseUrl}/rest/${object}?filter=${filterValue}`;
    const res = await this.request(url, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Twenty findIdByErpId ${object} failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: Record<string, Array<{ id?: string }> | undefined> };
    return json.data?.[object]?.[0]?.id ?? null;
  }

  async deleteRecord(object: TwentyObject, id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/rest/${object}/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Twenty delete ${object}/${id} failed: ${res.status} ${await res.text()}`);
    }
  }
}

/**
 * Dry-run (no-op) implementation of TwentyApiPort.
 * Makes ZERO real HTTP calls — safe for dry-run / staging previews.
 */
export class NoopTwentyApiClient implements TwentyApiPort {
  constructor(private readonly log: (msg: string) => void = () => {}) {}

  async createRecord(object: TwentyObject, body: Record<string, unknown>): Promise<{ id: string }> {
    this.log(`[dry-run] create ${object} ${JSON.stringify(body)}`);
    return { id: `dryrun-${object}` };
  }

  async updateRecord(object: TwentyObject, id: string, body: Record<string, unknown>): Promise<void> {
    this.log(`[dry-run] update ${object}/${id} ${JSON.stringify(body)}`);
  }

  async deleteRecord(object: TwentyObject, id: string): Promise<void> {
    this.log(`[dry-run] delete ${object}/${id}`);
  }

  async findIdByErpId(_object: TwentyObject, _erpId: string): Promise<string | null> {
    return null;
  }
}
