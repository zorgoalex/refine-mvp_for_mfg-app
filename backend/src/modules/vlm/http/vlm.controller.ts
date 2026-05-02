import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
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
    return this.vlm.getHealth({ currentUser });
  }

  @Post('upload')
  async upload(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<VlmUploadResponseDto> {
    this.assertVlmActionsEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.vlm.uploadImage({
      currentUser,
      dto: parseVlmUploadRequest(body, this.runtimeConfig.getUploadLimits()),
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
