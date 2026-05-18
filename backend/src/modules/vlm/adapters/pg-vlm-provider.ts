import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import { RateLimitService } from '../../../rate-limit/rate-limit.service';
import type {
  AnalyzeVlmImageCommand,
  GetVlmHealthCommand,
  UploadVlmImageCommand,
  VlmProviderPort,
} from '../application/vlm.types';
import type {
  VlmAnalyzeResponseDto,
  VlmHealthResponseDto,
  VlmUploadResponseDto,
} from '../dto/vlm.dto';

const DEFAULT_PROVIDER_ORDER = ['zai', 'bigmodel', 'openrouter'];
const DEFAULT_REQUEST_ID = 'vlm-provider';

type FetchLike = typeof fetch;

export interface PgVlmProviderOptions {
  vlmApiUrl: string;
  auth0Domain: string;
  auth0ClientId: string;
  auth0ClientSecret: string;
  auth0Audience: string;
  healthTimeoutMs: number;
  uploadTimeoutMs: number;
  analyzeTimeoutMs: number;
  analyzeDailyLimit: number;
  rateLimits?: RateLimitService;
  fetchImpl?: FetchLike;
}

type VlmDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface UploadProviderResponse {
  key: string;
  url: string;
  expiresInSec?: number;
  etag?: string;
  contentType: string;
  size: number;
  width?: number | null;
  height?: number | null;
}

interface UploadRow extends QueryResultRow {
  upload_id: string;
  public_url: string | null;
  signed_url: string | null;
  storage_key: string;
  content_type: string;
  size_bytes: string | number;
}

interface AnalyzeProviderResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

export class PgVlmProvider implements VlmProviderPort {
  private readonly fetchImpl: FetchLike;
  private token: CachedToken | null = null;

  constructor(
    private readonly database: VlmDatabase,
    private readonly options: PgVlmProviderOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getHealth(command: GetVlmHealthCommand): Promise<VlmHealthResponseDto> {
    if (!command.detailsVisible) {
      return {
        status: 'ok',
        detailsVisible: false,
      };
    }

    const [healthz, readyz] = await Promise.all([
      this.safeHealthFetch('/healthz'),
      this.safeHealthFetch('/readyz'),
    ]);
    const available = healthz && readyz;

    return {
      status: available ? 'ok' : 'degraded',
      detailsVisible: true,
      providers: [
        {
          name: 'vlm-api',
          configured: true,
          available,
        },
      ],
    };
  }

  async uploadImage(command: UploadVlmImageCommand): Promise<VlmUploadResponseDto> {
    await this.assertRateLimit({
      feature: 'vlm_upload',
      route: 'vlm/upload',
      userId: command.currentUser.id,
      maxRequests: 60,
      windowMs: 60_000,
    });
    const file = command.dto.file;
    const contentType = getContentType(file);
    const bytes = await getFileBytes(file);
    const filename = getFilename(file);
    const token = await this.getM2MToken();
    const formData = new FormData();
    formData.append('file', new Blob([bytes], { type: contentType }), filename);

    const response = await this.fetchWithTimeout(
      `${this.options.vlmApiUrl}/v1/images/upload`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
      this.options.uploadTimeoutMs,
    );

    if (!response.ok) {
      throw new ApiError(502, 'VLM_PROVIDER_ERROR', 'VLM upload provider failed', {
        status: response.status,
      });
    }

    const uploaded = (await response.json()) as UploadProviderResponse;

    return this.database.transaction(async (tx) => {
      const inserted = await tx.query<UploadRow>(
        `
        INSERT INTO file_uploads (
          user_id, storage_key, public_url, signed_url, content_type, size_bytes,
          width, height, purpose, expires_at
        )
        VALUES (
          $1, $2, $3, $3, $4, $5, $6, $7, $8,
          CASE WHEN $9::int IS NULL THEN NULL ELSE now() + ($9::int * interval '1 second') END
        )
        RETURNING upload_id::text, public_url, signed_url, storage_key, content_type, size_bytes
        `,
        [
          toUserId(command.currentUser.id),
          uploaded.key,
          uploaded.url,
          uploaded.contentType || contentType,
          uploaded.size || bytes.byteLength,
          uploaded.width ?? null,
          uploaded.height ?? null,
          command.dto.purpose,
          uploaded.expiresInSec ?? null,
        ],
      );
      const row = inserted.rows[0];

      await writeAudit(tx, {
        event: 'vlm.upload',
        entityId: row.upload_id,
        command,
        metadata: {
          contentType: row.content_type,
          size: toNumber(row.size_bytes),
          purpose: command.dto.purpose,
        },
      });

      return {
        success: true,
        uploadId: row.upload_id,
        url: row.signed_url ?? row.public_url ?? uploaded.url,
        key: row.storage_key,
        width: uploaded.width ?? null,
        height: uploaded.height ?? null,
        size: toNumber(row.size_bytes),
        contentType: row.content_type,
      };
    });
  }

  async analyzeImage(command: AnalyzeVlmImageCommand): Promise<VlmAnalyzeResponseDto> {
    await this.assertRateLimit({
      feature: 'vlm_analyze',
      route: 'vlm/analyze',
      userId: command.currentUser.id,
      maxRequests: 20,
      windowMs: 60_000,
    });
    await this.assertRateLimit({
      feature: 'vlm_analyze_daily',
      route: 'vlm/analyze',
      userId: command.currentUser.id,
      maxRequests: this.options.analyzeDailyLimit,
      windowMs: msUntilNextUtcDay(),
    });

    const upload = await this.resolveTrustedUpload(command);
    const imageUrl = upload.signed_url ?? upload.public_url;
    if (!imageUrl) {
      throw new ApiError(422, 'UNTRUSTED_IMAGE_URL', 'Uploaded file does not have a trusted URL');
    }

    const providerOrder = buildProviderOrder(command.dto.provider, command.dto.providerOrder);
    const token = await this.getM2MToken();
    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of providerOrder) {
      try {
        const providerResponse = await this.callAnalyzeProvider({
          token,
          imageUrl,
          provider,
          command,
        });
        const content = providerResponse.choices?.[0]?.message?.content ?? '';
        const parsed = parseVlmContent(content);
        const usage = providerResponse.usage;
        const response: VlmAnalyzeResponseDto = {
          success: true,
          provider,
          model: providerResponse.model ?? command.dto.model ?? null,
          uploadId: upload.upload_id,
          result: {
            content,
            items: parsed.items,
            parseError: parsed.parseError,
          },
          usage: {
            inputTokens: usage?.prompt_tokens ?? null,
            outputTokens: usage?.completion_tokens ?? null,
            cost: null,
          },
        };

        await this.database.query(
          `
          INSERT INTO audit_log (event, entity_type, entity_id, user_id, username, role_code, role, request_id, metadata_json)
          VALUES ('vlm.analyze', 'file_upload', $1, $2, $3, $4, $4, $5, $6::jsonb)
          `,
          [
            upload.upload_id,
            toUserId(command.currentUser.id),
            command.currentUser.username,
            command.currentUser.role,
            command.requestId ?? DEFAULT_REQUEST_ID,
            JSON.stringify({
              provider,
              model: response.model,
              usage: response.usage,
            }),
          ],
        );

        return response;
      } catch (error) {
        errors.push({
          provider,
          error: error instanceof Error ? error.message : 'provider failed',
        });
      }
    }

    throw new ApiError(502, 'VLM_PROVIDER_ERROR', 'All VLM providers failed', {
      providerErrors: errors,
    });
  }

  private async resolveTrustedUpload(command: AnalyzeVlmImageCommand): Promise<UploadRow> {
    const userId = toUserId(command.currentUser.id);
    const result = command.dto.uploadId
      ? await this.database.query<UploadRow>(
          `
          SELECT upload_id::text, public_url, signed_url, storage_key, content_type, size_bytes
          FROM file_uploads
          WHERE upload_id = $1::uuid AND user_id = $2
          `,
          [command.dto.uploadId, userId],
        )
      : await this.database.query<UploadRow>(
          `
          SELECT upload_id::text, public_url, signed_url, storage_key, content_type, size_bytes
          FROM file_uploads
          WHERE user_id = $1 AND (public_url = $2 OR signed_url = $2)
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [userId, command.dto.imageUrl],
        );

    const upload = result.rows[0];
    if (!upload) {
      if (command.dto.uploadId) {
        throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Uploaded file was not found', {
          uploadId: command.dto.uploadId,
        });
      }

      throw new ApiError(422, 'UNTRUSTED_IMAGE_URL', 'imageUrl does not belong to a stored upload');
    }

    return upload;
  }

  private async assertRateLimit(input: {
    feature: string;
    route: string;
    userId: string;
    maxRequests: number;
    windowMs: number;
  }): Promise<void> {
    if (this.options.rateLimits) {
      await this.options.rateLimits.assertAllowed({
        rule: {
          feature: input.feature,
          maxRequests: input.maxRequests,
          windowMs: input.windowMs,
        },
        subject: {
          route: input.route,
          userId: input.userId,
        },
      });
      return;
    }

    throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Rate limit storage is unavailable', {
      feature: input.feature,
    });
  }

  private async callAnalyzeProvider(input: {
    token: string;
    imageUrl: string;
    provider: string;
    command: AnalyzeVlmImageCommand;
  }): Promise<AnalyzeProviderResponse> {
    const payload: Record<string, unknown> = {
      provider: input.provider,
      image_url: input.imageUrl,
      stream: false,
    };
    if (input.command.dto.model) payload.model = input.command.dto.model;
    if (input.command.dto.promptId) payload.prompt_id = input.command.dto.promptId;
    if (input.command.dto.promptKv) payload.prompt_kv = normalizePromptKv(input.command.dto.promptKv);

    const response = await this.fetchWithTimeout(
      `${this.options.vlmApiUrl}/v1/vision/analyze`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      this.options.analyzeTimeoutMs,
    );

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(String((body as { error?: unknown }).error ?? `status ${response.status}`));
    }

    return (await response.json()) as AnalyzeProviderResponse;
  }

  private async safeHealthFetch(path: string): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.options.vlmApiUrl}${path}`,
        { method: 'GET' },
        this.options.healthTimeoutMs,
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  private async getM2MToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.token.expiresAt - 60_000) {
      return this.token.token;
    }

    const response = await this.fetchWithTimeout(
      `https://${this.options.auth0Domain}/oauth/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.options.auth0ClientId,
          client_secret: this.options.auth0ClientSecret,
          audience: this.options.auth0Audience,
          grant_type: 'client_credentials',
        }),
      },
      this.options.healthTimeoutMs,
    );

    if (!response.ok) {
      throw new ApiError(502, 'VLM_AUTH_ERROR', 'VLM M2M token request failed', {
        status: response.status,
      });
    }

    const token = (await response.json()) as TokenResponse;
    this.token = {
      token: token.access_token,
      expiresAt: now + token.expires_in * 1000,
    };
    return this.token.token;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiError(504, 'VLM_PROVIDER_TIMEOUT', 'VLM provider timed out');
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function msUntilNextUtcDay(): number {
  const now = new Date();
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, nextDay - now.getTime());
}

function buildProviderOrder(provider: string | null | undefined, providerOrder: string[] | null | undefined) {
  const requested = providerOrder?.filter(Boolean) ?? [];
  if (requested.length > 0) {
    return [...new Set(requested)];
  }

  if (provider) {
    return [provider, ...DEFAULT_PROVIDER_ORDER.filter((item) => item !== provider)];
  }

  return DEFAULT_PROVIDER_ORDER;
}

function normalizePromptKv(promptKv: NonNullable<AnalyzeVlmImageCommand['dto']['promptKv']>) {
  return {
    namespace: promptKv.namespace,
    name: promptKv.name,
    version: promptKv.version ? Number(promptKv.version) || promptKv.version : undefined,
    lang: promptKv.lang ?? undefined,
  };
}

async function getFileBytes(file: UploadVlmImageCommand['dto']['file']): Promise<Uint8Array> {
  if (file.buffer) {
    return file.buffer instanceof Uint8Array ? file.buffer : new Uint8Array(file.buffer);
  }

  if (file.arrayBuffer) {
    return new Uint8Array(await file.arrayBuffer());
  }

  throw new ApiError(422, 'VALIDATION_ERROR', 'VLM upload file bytes are missing', {
    errors: [{ field: 'file', message: 'file bytes are required' }],
  });
}

function getContentType(file: UploadVlmImageCommand['dto']['file']): string {
  return String(file.mimetype ?? file.contentType ?? file.type ?? '').toLowerCase();
}

function getFilename(file: UploadVlmImageCommand['dto']['file']): string {
  return String(file.originalname ?? file.filename ?? 'image');
}

function parseVlmContent(content: string): { items?: unknown[]; parseError?: string } {
  try {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!match) {
      return {};
    }

    const parsed = JSON.parse(match[1]);
    return {
      items: Array.isArray(parsed) ? parsed : parsed.items,
    };
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : 'Failed to parse JSON',
    };
  }
}

async function writeAudit(
  tx: TransactionClient,
  input: {
    event: string;
    entityId: string;
    command: UploadVlmImageCommand;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO audit_log (event, entity_type, entity_id, user_id, username, role_code, role, request_id, metadata_json)
    VALUES ($1, 'file_upload', $2, $3, $4, $5, $5, $6, $7::jsonb)
    `,
    [
      input.event,
      input.entityId,
      toUserId(input.command.currentUser.id),
      input.command.currentUser.username,
      input.command.currentUser.role,
      input.command.requestId ?? DEFAULT_REQUEST_ID,
      JSON.stringify(input.metadata),
    ],
  );
}

function toUserId(value: string): number {
  const userId = Number(value);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Current user id must be numeric for VLM DB adapter', {
      field: 'currentUser.id',
    });
  }

  return userId;
}

function toNumber(value: string | number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ApiError(500, 'INVALID_DATABASE_VALUE', 'VLM numeric database value is invalid');
  }

  return numeric;
}
