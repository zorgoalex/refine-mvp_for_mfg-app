import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { VlmService } from '../application/vlm.service';
import type {
  VlmAnalyzeRequestDto,
  VlmHealthResponseDto,
  VlmUploadRequestDto,
  VlmUploadResponseDto,
} from '../dto/vlm.dto';
import { VlmRuntimeConfigService, type VlmUploadLimits } from './vlm-runtime-config.service';

const promptKvSchema = z.object({
  namespace: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  version: z.string().trim().max(100).nullable().optional(),
  lang: z.string().trim().max(20).nullable().optional(),
});

const analyzeRequestSchema = z
  .object({
    uploadId: z.string().trim().min(1).max(100).nullable().optional(),
    imageUrl: z.string().trim().url().max(2000).nullable().optional(),
    provider: z.string().trim().min(1).max(100).nullable().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    promptId: z.string().trim().min(1).max(200).nullable().optional(),
    promptKv: promptKvSchema.nullable().optional(),
    providerOrder: z.array(z.string().trim().min(1).max(100)).max(10).nullable().optional(),
  })
  .refine((value) => Boolean(value.uploadId) !== Boolean(value.imageUrl), {
    message: 'Exactly one of uploadId or imageUrl must be provided',
  });

const vlmHealthResponseSwaggerSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded', 'unavailable'] },
    providers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'configured'],
        properties: {
          name: { type: 'string' },
          configured: { type: 'boolean' },
          available: { type: 'boolean', nullable: true },
        },
      },
    },
    detailsVisible: { type: 'boolean' },
  },
} as const;

const vlmUploadRequestSwaggerSchema = {
  type: 'object',
  required: ['file'],
  properties: {
    file: { type: 'string', format: 'binary' },
    purpose: { type: 'string', enum: ['vlm', 'order_file'], default: 'vlm' },
  },
} as const;

const vlmUploadResponseSwaggerSchema = {
  type: 'object',
  required: ['success', 'uploadId', 'url', 'key', 'size', 'contentType'],
  properties: {
    success: { type: 'boolean', enum: [true] },
    uploadId: { type: 'string' },
    url: { type: 'string' },
    key: { type: 'string' },
    width: { type: 'integer', nullable: true },
    height: { type: 'integer', nullable: true },
    size: { type: 'integer' },
    contentType: { type: 'string' },
  },
} as const;

const vlmPromptKvSwaggerSchema = {
  type: 'object',
  required: ['namespace', 'name'],
  properties: {
    namespace: { type: 'string', minLength: 1, maxLength: 100 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    version: { type: 'string', maxLength: 100, nullable: true },
    lang: { type: 'string', maxLength: 20, nullable: true },
  },
} as const;

const vlmAnalyzeRequestSwaggerSchema = {
  type: 'object',
  properties: {
    uploadId: { type: 'string', minLength: 1, maxLength: 100, nullable: true },
    imageUrl: { type: 'string', format: 'uri', maxLength: 2000, nullable: true },
    provider: { type: 'string', minLength: 1, maxLength: 100, nullable: true },
    model: { type: 'string', minLength: 1, maxLength: 200, nullable: true },
    promptId: { type: 'string', minLength: 1, maxLength: 200, nullable: true },
    promptKv: { ...vlmPromptKvSwaggerSchema, nullable: true },
    providerOrder: {
      type: 'array',
      maxItems: 10,
      nullable: true,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
  oneOf: [
    {
      required: ['uploadId'],
      properties: {
        uploadId: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
    {
      required: ['imageUrl'],
      properties: {
        imageUrl: { type: 'string', format: 'uri', maxLength: 2000 },
      },
    },
  ],
} as const;

const vlmAnalyzeResponseSwaggerSchema = {
  type: 'object',
  required: ['success', 'result'],
  properties: {
    success: { type: 'boolean', enum: [true] },
    provider: { type: 'string', nullable: true },
    model: { type: 'string', nullable: true },
    uploadId: { type: 'string', nullable: true },
    result: { type: 'object', additionalProperties: true },
    usage: {
      type: 'object',
      nullable: true,
      properties: {
        inputTokens: { type: 'integer', nullable: true },
        outputTokens: { type: 'integer', nullable: true },
        cost: { type: 'number', nullable: true },
      },
    },
  },
} as const;

@Controller('vlm')
export class VlmController {
  constructor(
    @Inject(VlmService)
    private readonly vlm: VlmService,
    @Inject(VlmRuntimeConfigService)
    private readonly runtimeConfig: VlmRuntimeConfigService,
  ) {}

  @Get('health')
  async health(@Req() request: RequestWithCurrentUser): Promise<VlmHealthResponseDto> {
    this.assertVlmEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.vlm.getHealth({ currentUser, requestId: request.requestId });
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Req() request: RequestWithCurrentUser,
    @UploadedFile() uploadedFile: unknown,
    @Body() body: unknown,
  ): Promise<VlmUploadResponseDto> {
    this.assertVlmActionsEnabled();

    const currentUser = this.requireCurrentUser(request);
    const uploadBody = normalizeUploadBody(uploadedFile, body);
    return this.vlm.uploadImage({
      currentUser,
      dto: parseVlmUploadRequest(uploadBody, this.runtimeConfig.getUploadLimits()),
      requestId: request.requestId,
    });
  }

  @Post('analyze')
  @HttpCode(200)
  async analyze(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    this.assertVlmActionsEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.vlm.analyzeImage({
      currentUser,
      dto: parseVlmAnalyzeRequest(body),
      requestId: request.requestId,
    });
  }

  private assertVlmEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().vlmEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'VLM API is disabled', {
        feature: 'vlm',
      });
    }
  }

  private assertVlmActionsEnabled(): void {
    this.assertVlmEnabled();

    if (this.runtimeConfig.getFeatureFlags().vlmDisabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'VLM actions are disabled', {
        feature: 'vlm',
        mode: 'disabled',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }
}

function normalizeUploadBody(uploadedFile: unknown, body: unknown): unknown {
  if (body === undefined) {
    return uploadedFile;
  }

  if (body && typeof body === 'object') {
    return {
      ...(body as Record<string, unknown>),
      file: uploadedFile ?? (body as Record<string, unknown>).file,
    };
  }

  return {
    file: uploadedFile,
  };
}

export function parseVlmAnalyzeRequest(body: unknown): VlmAnalyzeRequestDto {
  const parsed = analyzeRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw validationError('body', 'Invalid VLM analyze request', parsed.error.issues);
  }

  return parsed.data;
}

export function parseVlmUploadRequest(
  body: unknown,
  limits: VlmUploadLimits,
): VlmUploadRequestDto {
  const source = getUploadBodySource(body);
  const file = source.file;
  const purpose = source.purpose ?? 'vlm';

  if (!file || typeof file !== 'object') {
    throw validationError('file', 'file is required');
  }

  if (purpose !== 'vlm' && purpose !== 'order_file') {
    throw validationError('purpose', 'purpose must be vlm or order_file');
  }

  const uploadFile = file as VlmUploadRequestDto['file'];
  const contentType = getUploadContentType(uploadFile);
  const size = getUploadSize(uploadFile);

  if (!contentType || !limits.allowedMimeTypes.includes(contentType)) {
    throw new ApiError(422, 'UNSUPPORTED_FILE_TYPE', 'Unsupported VLM upload file type', {
      allowedMimeTypes: [...limits.allowedMimeTypes],
      contentType: contentType ?? null,
    });
  }

  if (!Number.isFinite(size) || size < 0) {
    throw validationError('file.size', 'file size must be a non-negative number');
  }

  if (size > limits.maxUploadBytes) {
    throw new ApiError(413, 'FILE_TOO_LARGE', 'VLM upload file is too large', {
      maxUploadBytes: limits.maxUploadBytes,
      size,
    });
  }

  return {
    file: uploadFile,
    purpose,
  };
}

function getUploadBodySource(body: unknown): {
  file?: unknown;
  purpose?: unknown;
} {
  if (!body || typeof body !== 'object') {
    return {};
  }

  const objectBody = body as Record<string, unknown>;
  return {
    file: objectBody.file ?? objectBody,
    purpose: objectBody.purpose,
  };
}

function getUploadContentType(file: VlmUploadRequestDto['file']): string | null {
  const contentType = file.mimetype ?? file.contentType ?? file.type;
  return typeof contentType === 'string' ? contentType.trim().toLowerCase() : null;
}

function getUploadSize(file: VlmUploadRequestDto['file']): number {
  return Number(file.size);
}

function validationError(
  field: string,
  message: string,
  issues: Array<{ path: PropertyKey[]; message: string }> = [],
): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'VLM request validation failed', {
    errors: issues.length
      ? issues.map((issue) => ({
          field: issue.path.join('.') || field,
          message: issue.message,
        }))
      : [{ field, message }],
  });
}
