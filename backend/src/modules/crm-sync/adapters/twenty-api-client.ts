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

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * HTTP adapter for the Twenty CRM REST API.
 * Inject a custom fetch fn for unit tests (default: global fetch).
 * NEVER logs the apiKey.
 */
export class TwentyApiClient implements TwentyApiPort {
  private readonly f: FetchFn;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    fetchFn?: FetchFn,
  ) {
    this.f = fetchFn ?? (fetch as unknown as FetchFn);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async createRecord(object: TwentyObject, body: Record<string, unknown>): Promise<{ id: string }> {
    const res = await this.f(`${this.baseUrl}/rest/${object}`, {
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
    const res = await this.f(`${this.baseUrl}/rest/${object}/${id}`, {
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
    const res = await this.f(url, {
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
    const res = await this.f(`${this.baseUrl}/rest/${object}/${id}`, {
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
