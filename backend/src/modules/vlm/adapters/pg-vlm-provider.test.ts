import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { MemoryRateLimitStore } from '../../../rate-limit/memory-rate-limit.store';
import { RateLimitService } from '../../../rate-limit/rate-limit.service';
import { PgVlmProvider } from './pg-vlm-provider';

describe('PgVlmProvider', () => {
  it('uploads image through provider, stores file_uploads row, and writes audit', async () => {
    const fetchCalls: Array<{ url: string; method?: string }> = [];
    const database = new FakeVlmDatabase([], [
      {
        match: 'INSERT INTO file_uploads',
        rows: [
          {
            upload_id: '11111111-1111-4111-8111-111111111111',
            public_url: 'https://files.example/image.png',
            signed_url: 'https://files.example/image.png',
            storage_key: 'images/image.png',
            content_type: 'image/png',
            size_bytes: 8,
          },
        ],
      },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    const provider = createProvider(database, async (url, init) => {
      fetchCalls.push({ url: String(url), method: init?.method });
      if (String(url).includes('/oauth/token')) {
        return response({ access_token: 'm2m-token', expires_in: 3600 });
      }
      return response({
        key: 'images/image.png',
        url: 'https://files.example/image.png',
        contentType: 'image/png',
        size: 8,
        width: 100,
        height: 200,
      });
    });

    await expect(
      provider.uploadImage({
        currentUser: currentUser('manager', '10'),
        requestId: 'req_vlm_upload',
        dto: {
          file: {
            originalname: 'image.png',
            mimetype: 'image/png',
            size: 8,
            buffer: Buffer.from('png-data'),
          },
          purpose: 'vlm',
        },
      }),
    ).resolves.toEqual({
      success: true,
      uploadId: '11111111-1111-4111-8111-111111111111',
      url: 'https://files.example/image.png',
      key: 'images/image.png',
      width: 100,
      height: 200,
      size: 8,
      contentType: 'image/png',
    });

    expect(fetchCalls.map((call) => call.url)).toEqual([
      'https://auth.example.test/oauth/token',
      'https://vlm.example.test/v1/images/upload',
    ]);
    expect(database.queries[0].params[0]).toBe(10);
    expect(database.queries[1].params).toEqual([
      'vlm.upload',
      '11111111-1111-4111-8111-111111111111',
      10,
      'manager',
      'manager',
      'req_vlm_upload',
      expect.stringContaining('"contentType":"image/png"'),
    ]);
  });

  it('analyzes only trusted uploadId and writes usage audit', async () => {
    const analyzeBodies: Record<string, unknown>[] = [];
    const database = new FakeVlmDatabase(
      [
        {
          match: 'FROM file_uploads',
          rows: [
            {
              upload_id: '11111111-1111-4111-8111-111111111111',
              public_url: 'https://files.example/image.png',
              signed_url: 'https://files.example/image.png',
              storage_key: 'images/image.png',
              content_type: 'image/png',
              size_bytes: 8,
            },
          ],
        },
        { match: 'INSERT INTO audit_log', rows: [] },
      ],
      [],
    );
    const provider = createProvider(database, async (url, init) => {
      if (String(url).includes('/oauth/token')) {
        return response({ access_token: 'm2m-token', expires_in: 3600 });
      }
      analyzeBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({
        model: 'zai/model-a',
        choices: [{ message: { content: '{"items":[{"name":"detail"}]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });

    await expect(
      provider.analyzeImage({
        currentUser: currentUser('manager', '10'),
        requestId: 'req_vlm_analyze',
        dto: {
          uploadId: '11111111-1111-4111-8111-111111111111',
          provider: 'zai',
          model: 'model-a',
          promptKv: { namespace: 'orders', name: 'import', version: '1', lang: 'ru' },
        },
      }),
    ).resolves.toMatchObject({
      success: true,
      provider: 'zai',
      model: 'zai/model-a',
      uploadId: '11111111-1111-4111-8111-111111111111',
      result: { items: [{ name: 'detail' }] },
      usage: { inputTokens: 10, outputTokens: 5, cost: null },
    });

    expect(analyzeBodies[0]).toMatchObject({
      provider: 'zai',
      image_url: 'https://files.example/image.png',
      model: 'model-a',
      prompt_kv: { namespace: 'orders', name: 'import', version: 1, lang: 'ru' },
    });
    expect(database.queries[1].params).toEqual([
      '11111111-1111-4111-8111-111111111111',
      10,
      'manager',
      'manager',
      'req_vlm_analyze',
      expect.stringContaining('"inputTokens":10'),
    ]);
  });

  it('rejects arbitrary imageUrl values before provider call', async () => {
    const database = new FakeVlmDatabase([{ match: 'FROM file_uploads', rows: [] }], []);
    let fetchCalled = false;
    const provider = createProvider(database, async () => {
      fetchCalled = true;
      return response({});
    });

    await expect(
      provider.analyzeImage({
        currentUser: currentUser('manager', '10'),
        dto: { imageUrl: 'https://evil.example/image.png' },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'UNTRUSTED_IMAGE_URL' });
    expect(fetchCalled).toBe(false);
  });

  it('enforces daily analyze quota before provider call', async () => {
    const database = new FakeVlmDatabase(
      [
        { match: 'FROM file_uploads', rows: [uploadRow()] },
        { match: 'INSERT INTO audit_log', rows: [] },
      ],
      [],
    );
    let providerCalls = 0;
    const provider = createProvider(database, async (url) => {
      if (String(url).includes('/oauth/token')) {
        return response({ access_token: 'm2m-token', expires_in: 3600 });
      }
      providerCalls += 1;
      return response({ model: 'zai/model-a', choices: [{ message: { content: 'ok' } }] });
    }, 1);

    await provider.analyzeImage({
      currentUser: currentUser('manager', '10'),
      dto: { uploadId: '11111111-1111-4111-8111-111111111111' },
    });
    await expect(
      provider.analyzeImage({
        currentUser: currentUser('manager', '10'),
        dto: { uploadId: '11111111-1111-4111-8111-111111111111' },
      }),
    ).rejects.toMatchObject({ statusCode: 429, code: 'RATE_LIMIT_EXCEEDED' });
    expect(providerCalls).toBe(1);
  });
});

interface ExpectedQuery {
  match: string;
  rows: QueryResultRow[];
}

class FakeVlmDatabase {
  readonly queries: Array<{ text: string; params: readonly unknown[] }> = [];
  private queryQueue: ExpectedQuery[];
  private transactionQueue: ExpectedQuery[];

  constructor(queryResults: ExpectedQuery[] = [], transactionResults: ExpectedQuery[] = []) {
    this.queryQueue = [...queryResults];
    this.transactionQueue = [...transactionResults];
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, params });
    const expected = this.queryQueue.shift() ?? { match: '', rows: [] };
    expect(text).toContain(expected.match);
    return toQueryResult(expected.rows) as QueryResult<T>;
  }

  async transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> {
    const tx = {
      raw: undefined,
      query: async <T extends QueryResultRow = QueryResultRow>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<T>> => {
        this.queries.push({ text, params });
        const expected = this.transactionQueue.shift() ?? { match: '', rows: [] };
        expect(text).toContain(expected.match);
        return toQueryResult(expected.rows) as QueryResult<T>;
      },
    } as unknown as TransactionClient;

    return handler(tx);
  }
}

function createProvider(
  database: FakeVlmDatabase,
  fetchImpl: typeof fetch,
  analyzeDailyLimit = 100,
): PgVlmProvider {
  return new PgVlmProvider(database, {
    vlmApiUrl: 'https://vlm.example.test',
    auth0Domain: 'auth.example.test',
    auth0ClientId: 'client-id',
    auth0ClientSecret: 'client-secret',
    auth0Audience: 'https://vlm.example.test',
    healthTimeoutMs: 1000,
    uploadTimeoutMs: 1000,
    analyzeTimeoutMs: 1000,
    analyzeDailyLimit,
    rateLimits: new RateLimitService(new MemoryRateLimitStore()),
    fetchImpl,
  });
}

function response(body: Record<string, unknown>, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

function toQueryResult(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function currentUser(role: CurrentUser['role'], id: string): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: 10,
    permissions: getPermissionsForRole(role),
  };
}

function uploadRow(): QueryResultRow {
  return {
    upload_id: '11111111-1111-4111-8111-111111111111',
    public_url: 'https://files.example/image.png',
    signed_url: 'https://files.example/image.png',
    storage_key: 'images/image.png',
    content_type: 'image/png',
    size_bytes: 8,
  };
}
