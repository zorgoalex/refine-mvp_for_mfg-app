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
    // auditService.record() uses the standard 23-param AUDIT_INSERT
    expect(database.queries[1].params[0]).toBe('vlm.upload');           // event
    expect(database.queries[1].params[1]).toBe('file_upload');          // entity_type
    expect(database.queries[1].params[2]).toBe('11111111-1111-4111-8111-111111111111'); // entity_id
    expect(database.queries[1].params[3]).toBe(10);                     // user_id
    expect(database.queries[1].params[4]).toBe('manager');              // username
    expect(database.queries[1].params[5]).toBe('manager');              // role_code
    expect(database.queries[1].params[6]).toBe('req_vlm_upload');       // request_id
    expect(database.queries[1].params[7]).toBe('vlm-upload');           // source
    expect(database.queries[1].params[22] as string).toContain('"contentType":"image/png"'); // metadata_json
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
    // auditService.record() uses the standard 23-param AUDIT_INSERT
    expect(database.queries[1].params[0]).toBe('vlm.analyze');          // event
    expect(database.queries[1].params[1]).toBe('file_upload');          // entity_type
    expect(database.queries[1].params[2]).toBe('11111111-1111-4111-8111-111111111111'); // entity_id
    expect(database.queries[1].params[3]).toBe(10);                     // user_id
    expect(database.queries[1].params[4]).toBe('manager');              // username
    expect(database.queries[1].params[5]).toBe('manager');              // role_code
    expect(database.queries[1].params[6]).toBe('req_vlm_analyze');      // request_id
    expect(database.queries[1].params[7]).toBe('vlm-analyze');          // source
    // metadata_json: provider/model stored; inputTokens/outputTokens preserved via audit allowlist
    expect(database.queries[1].params[22] as string).toContain('"provider":"zai"');
    expect(database.queries[1].params[22] as string).toContain('"model":"zai/model-a"');
    expect(database.queries[1].params[22] as string).toContain('"inputTokens":10');
    expect(database.queries[1].params[22] as string).not.toContain('"inputTokens":"[REDACTED]"');
  });

  it('does not return raw provider payloads from analyze responses', async () => {
    const database = new FakeVlmDatabase(
      [
        { match: 'FROM file_uploads', rows: [uploadRow()] },
        { match: 'INSERT INTO audit_log', rows: [] },
      ],
      [],
    );
    const provider = createProvider(database, async (url) => {
      if (String(url).includes('/oauth/token')) {
        return response({ access_token: 'm2m-token', expires_in: 3600 });
      }
      return response({
        model: 'zai/model-a',
        choices: [{ message: { content: '{"items":[{"name":"detail"}]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        providerDebug: { secretTrace: 'internal-upstream-payload' },
      });
    });

    const result = await provider.analyzeImage({
      currentUser: currentUser('manager', '10'),
      dto: { uploadId: '11111111-1111-4111-8111-111111111111' },
    });

    expect(result).not.toHaveProperty('rawResult');
    expect(JSON.stringify(result)).not.toContain('internal-upstream-payload');
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

  it('audit upload: redacts secret-shaped keys in metadata, preserves non-sensitive dims', async () => {
    const database = new FakeVlmDatabase([], [
      {
        match: 'INSERT INTO file_uploads',
        rows: [{
          upload_id: '22222222-2222-4222-8222-222222222222',
          public_url: 'https://files.example/secret.png',
          signed_url: 'https://files.example/secret.png',
          storage_key: 'images/secret.png',
          content_type: 'image/png',
          size_bytes: 4,
        }],
      },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    const provider = createProvider(database, async (url) => {
      if (String(url).includes('/oauth/token')) return response({ access_token: 'm2m-token', expires_in: 3600 });
      return response({ key: 'images/secret.png', url: 'https://files.example/secret.png', contentType: 'image/png', size: 4 });
    });

    await provider.uploadImage({
      currentUser: currentUser('manager', '10'),
      requestId: 'req_redact_upload',
      dto: {
        file: { originalname: 'secret.png', mimetype: 'image/png', size: 4, buffer: Buffer.from('data') },
        purpose: 'vlm',
      },
    });

    // database.queries captures all tx queries (upload insert + audit insert)
    const auditParams = database.queries.find((q) => q.text.includes('INSERT INTO audit_log'))?.params;
    expect(auditParams).toBeDefined();
    // Dimensions preserved
    expect(auditParams![0]).toBe('vlm.upload');       // event
    expect(auditParams![1]).toBe('file_upload');      // entity_type
    expect(auditParams![2]).toBe('22222222-2222-4222-8222-222222222222'); // entity_id
    expect(auditParams![3]).toBe(10);                 // user_id
    expect(auditParams![4]).toBe('manager');          // username
    expect(auditParams![6]).toBe('req_redact_upload'); // request_id
    expect(auditParams![7]).toBe('vlm-upload');       // source
    // metadata_json: non-sensitive keys preserved, no secret leak
    const metaStr = auditParams![22] as string;
    expect(metaStr).toContain('"contentType":"image/png"');
    expect(metaStr).toContain('"purpose":"vlm"');
    expect(metaStr).not.toContain('SUPER_SECRET');
  });

  it('audit analyze metadata: token-shaped usage fields are redacted by AuditService', async () => {
    const database = new FakeVlmDatabase(
      [
        { match: 'FROM file_uploads', rows: [uploadRow()] },
        { match: 'INSERT INTO audit_log', rows: [] },
      ],
      [],
    );
    const provider = createProvider(database, async (url) => {
      if (String(url).includes('/oauth/token')) {
        return response({ access_token: 'm2m-token', expires_in: 3600 });
      }
      return response({
        model: 'zai/model-b',
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        api_key: 'SUPER_SECRET',
      });
    });

    await provider.analyzeImage({
      currentUser: currentUser('manager', '10'),
      requestId: 'req_redact_analyze',
      dto: { uploadId: '11111111-1111-4111-8111-111111111111' },
    });

    const auditQuery = database.queries.find((q) => q.text.includes('INSERT INTO audit_log'));
    // Dimensions: event + entity dims still present
    expect(auditQuery?.params[0]).toBe('vlm.analyze');
    expect(auditQuery?.params[1]).toBe('file_upload');
    expect(auditQuery?.params[2]).toBe('11111111-1111-4111-8111-111111111111');
    expect(auditQuery?.params[7]).toBe('vlm-analyze');
    // metadata_json: inputTokens/outputTokens preserved as integers via audit allowlist
    const metaStr = auditQuery?.params[22] as string;
    expect(metaStr).toContain('"provider":"zai"');
    expect(metaStr).toContain('"inputTokens":5');
    expect(metaStr).toContain('"outputTokens":3');
    expect(metaStr).not.toContain('"inputTokens":"[REDACTED]"');
    expect(metaStr).not.toContain('SUPER_SECRET'); // api_key from provider response not in metadata
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
