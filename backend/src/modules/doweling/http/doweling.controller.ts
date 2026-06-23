import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DowelingService } from '../application/doweling.service';
import type { CreateDowelingOrderRequestDto, CreateDowelingOrderResponseDto } from '../dto/doweling.dto';
import { DowelingRuntimeConfigService } from './doweling-runtime-config.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const createDowelingRequestSchema = z.object({
  dowelingOrderName: z.string().trim().min(1).max(200),
  designEngineerId: z.number().int().positive(),
  paymentStatusId: z.number().int().positive(),
  dowelingOrderDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .nullish(),
  productionStatusId: z.number().int().positive().nullish(),
  operatorId: z.number().int().positive().nullish(),
  partsCount: z.number().int().nonnegative().nullish(),
  linkCadFile: z.string().trim().max(2000).nullish(),
  linkPdfFile: z.string().trim().max(2000).nullish(),
  idempotencyKey: z.string().trim().min(8).max(200),
});

const createDowelingRequestSwaggerSchema = {
  type: 'object',
  required: ['dowelingOrderName', 'designEngineerId', 'paymentStatusId', 'idempotencyKey'],
  properties: {
    dowelingOrderName: { type: 'string', minLength: 1, maxLength: 200 },
    designEngineerId: { type: 'integer' },
    paymentStatusId: { type: 'integer' },
    dowelingOrderDate: { type: 'string', format: 'date', nullable: true },
    productionStatusId: { type: 'integer', nullable: true },
    operatorId: { type: 'integer', nullable: true },
    partsCount: { type: 'integer', minimum: 0, nullable: true },
    linkCadFile: { type: 'string', maxLength: 2000, nullable: true },
    linkPdfFile: { type: 'string', maxLength: 2000, nullable: true },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

const dowelingResponseSwaggerSchema = {
  type: 'object',
  required: ['dowelingOrder', 'requestId'],
  properties: {
    dowelingOrder: {
      type: 'object',
      required: ['dowelingOrderId', 'dowelingOrderName', 'version'],
      properties: {
        dowelingOrderId: { type: 'integer' },
        dowelingOrderName: { type: 'string' },
        version: { type: 'integer' },
      },
    },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

@ApiTags('Doweling')
@ApiBearerAuth()
@Controller('doweling-orders')
export class DowelingController {
  constructor(
    @Inject(DowelingService)
    private readonly doweling: DowelingService,
    @Inject(DowelingRuntimeConfigService)
    private readonly runtimeConfig: DowelingRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'createDowelingOrder', summary: 'Create a doweling order (quick-create)' })
  @ApiBody({ schema: swaggerSchema(createDowelingRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Created doweling order', schema: swaggerSchema(dowelingResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Referenced engineer/payment status not found' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid doweling order payload' })
  @ApiResponse({ status: 503, description: 'Doweling commands API is disabled or database unavailable' })
  @Post()
  @HttpCode(201)
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<CreateDowelingOrderResponseDto> {
    this.assertDowelingEnabled();

    return this.doweling.createDowelingOrder({
      currentUser: this.requireCurrentUser(request),
      dto: parseCreateDowelingRequest(body),
      requestId: request.requestId,
    });
  }

  private assertDowelingEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().dowelingCommandsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Doweling commands API is disabled', {
        feature: 'dowelingCommands',
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

export function parseCreateDowelingRequest(body: unknown): CreateDowelingOrderRequestDto {
  const parsed = createDowelingRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw dowelingValidationError(parsed.error);
  }

  return parsed.data;
}

function dowelingValidationError(error: z.ZodError): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Doweling order payload validation failed', {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  });
}
