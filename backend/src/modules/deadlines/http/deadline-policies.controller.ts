import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DeadlineCommandService } from '../application/deadline-command.service';
import { DeadlineQueryService } from '../application/deadline-query.service';
import { deadlineEntityTypeSchema, isUuid, metadataSchema } from '../domain/deadline-validation';
import type {
  CreateDeadlinePolicyRequestDto,
  UpdateDeadlinePolicyRequestDto,
} from '../dto/deadline-policy.dto';
import { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const durationUnitSchema = z
  .enum(['minute', 'hour', 'day', 'working_hour', 'working_day'])
  .nullable()
  .optional();

const createPolicyRequestSchema = z.object({
  policyCode: z.string().trim().min(3).max(100),
  policyName: z.string().trim().min(1).max(255),
  scopeType: deadlineEntityTypeSchema,
  targetType: z.string().trim().max(100).nullable().optional(),
  targetCode: z.string().trim().max(100).nullable().optional(),
  durationValue: z.number().int().positive().nullable().optional(),
  durationUnit: durationUnitSchema,
  startPoint: z.string().trim().max(100).nullable().optional(),
  isEnabled: z.boolean().optional(),
  config: metadataSchema,
});

const updatePolicyRequestSchema = createPolicyRequestSchema
  .omit({ policyCode: true, scopeType: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

const deadlinePolicyEntityTypeSwaggerSchema = {
  type: 'string',
  enum: ['order', 'order_stage', 'client_action', 'project', 'task'],
} as const;

const deadlinePolicyDurationUnitSwaggerSchema = {
  type: 'string',
  enum: ['minute', 'hour', 'day', 'working_hour', 'working_day'],
  nullable: true,
} as const;

const createDeadlinePolicyRequestSwaggerSchema = {
  type: 'object',
  required: ['policyCode', 'policyName', 'scopeType'],
  properties: {
    policyCode: { type: 'string', minLength: 3, maxLength: 100 },
    policyName: { type: 'string', minLength: 1, maxLength: 255 },
    scopeType: deadlinePolicyEntityTypeSwaggerSchema,
    targetType: { type: 'string', maxLength: 100, nullable: true },
    targetCode: { type: 'string', maxLength: 100, nullable: true },
    durationValue: { type: 'integer', nullable: true },
    durationUnit: deadlinePolicyDurationUnitSwaggerSchema,
    startPoint: { type: 'string', maxLength: 100, nullable: true },
    isEnabled: { type: 'boolean' },
    config: { type: 'object', additionalProperties: true },
  },
} as const;

const updateDeadlinePolicyRequestSwaggerSchema = {
  type: 'object',
  minProperties: 1,
  properties: {
    policyName: { type: 'string', minLength: 1, maxLength: 255 },
    targetType: { type: 'string', maxLength: 100, nullable: true },
    targetCode: { type: 'string', maxLength: 100, nullable: true },
    durationValue: { type: 'integer', nullable: true },
    durationUnit: deadlinePolicyDurationUnitSwaggerSchema,
    startPoint: { type: 'string', maxLength: 100, nullable: true },
    isEnabled: { type: 'boolean' },
    config: { type: 'object', additionalProperties: true },
  },
} as const;

const deadlinePolicySwaggerSchema = {
  type: 'object',
  required: ['policyId', 'policyCode', 'policyName', 'scopeType', 'isEnabled', 'createdAt', 'updatedAt'],
  properties: {
    policyId: { type: 'string', format: 'uuid' },
    policyCode: { type: 'string' },
    policyName: { type: 'string' },
    scopeType: deadlinePolicyEntityTypeSwaggerSchema,
    targetType: { type: 'string', nullable: true },
    targetCode: { type: 'string', nullable: true },
    durationValue: { type: 'integer', nullable: true },
    durationUnit: deadlinePolicyDurationUnitSwaggerSchema,
    startPoint: { type: 'string', nullable: true },
    isEnabled: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const deadlinePolicyResponseSwaggerSchema = {
  type: 'object',
  required: ['policy'],
  properties: {
    policy: deadlinePolicySwaggerSchema,
  },
} as const;

const deadlinePolicyListResponseSwaggerSchema = {
  type: 'object',
  required: ['data'],
  properties: {
    data: { type: 'array', items: deadlinePolicySwaggerSchema },
  },
} as const;

@ApiTags('Deadline Policies')
@ApiBearerAuth()
@Controller('deadline-policies')
export class DeadlinePoliciesController {
  constructor(
    @Inject(DeadlineCommandService)
    private readonly commands: DeadlineCommandService,
    @Inject(DeadlineQueryService)
    private readonly queries: DeadlineQueryService,
    @Inject(DeadlinesRuntimeConfigService)
    private readonly runtimeConfig: DeadlinesRuntimeConfigService,
  ) {}

  @ApiResponse({ status: 200, description: 'Deadline policy list', schema: swaggerSchema(deadlinePolicyListResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid deadline policy query' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled' })
  @ApiOperation({ operationId: 'listDeadlinePolicies', summary: 'List deadline policies' })
  @Get()
  async list(@Req() request: RequestWithCurrentUser) {
    this.assertReadEnabled();

    return this.queries.listPolicies({
      currentUser: this.requireCurrentUser(request),
    });
  }

  @ApiBody({ schema: swaggerSchema(createDeadlinePolicyRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Created deadline policy', schema: swaggerSchema(deadlinePolicyResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid deadline policy payload' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled or read-only' })
  @ApiOperation({ operationId: 'createDeadlinePolicy', summary: 'Create a deadline policy' })
  @Post()
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    this.assertWriteEnabled();

    return {
      policy: await this.commands.createPolicy({
        currentUser: this.requireCurrentUser(request),
        requestId: request.requestId,
        dto: parseCreateDeadlinePolicyRequest(body),
      }),
    };
  }

  @ApiParam({ name: 'policyId', type: String, description: 'Deadline policy ID' })
  @ApiBody({ schema: swaggerSchema(updateDeadlinePolicyRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Updated deadline policy', schema: swaggerSchema(deadlinePolicyResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid deadline policy ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Deadline policy not found' })
  @ApiResponse({ status: 422, description: 'Invalid deadline policy payload' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled or read-only' })
  @ApiOperation({ operationId: 'updateDeadlinePolicy', summary: 'Update a deadline policy' })
  @Patch(':policyId')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('policyId') policyIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();

    return {
      policy: await this.commands.updatePolicy({
        currentUser: this.requireCurrentUser(request),
        requestId: request.requestId,
        policyId: parsePolicyId(policyIdParam),
        dto: parseUpdateDeadlinePolicyRequest(body),
      }),
    };
  }

  private assertReadEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().deadlinesEnabled) {
      throw new ApiError(503, 'DEADLINES_DISABLED', 'Deadlines API is disabled', {
        feature: 'deadlines',
      });
    }
  }

  private assertWriteEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.deadlinesEnabled) {
      throw new ApiError(503, 'DEADLINES_DISABLED', 'Deadlines API is disabled', {
        feature: 'deadlines',
      });
    }
    if (flags.deadlinesReadOnly) {
      throw new ApiError(503, 'DEADLINES_READ_ONLY', 'Deadline policies are read-only', {
        feature: 'deadlines',
        mode: 'read_only',
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

export function parsePolicyId(value: string): string {
  if (!isUuid(value)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid policy id', { field: 'policyId' });
  }

  return value;
}

export function parseCreateDeadlinePolicyRequest(body: unknown): CreateDeadlinePolicyRequestDto {
  return parseRequestBody(createPolicyRequestSchema, body);
}

export function parseUpdateDeadlinePolicyRequest(body: unknown): UpdateDeadlinePolicyRequestDto {
  return parseRequestBody(updatePolicyRequestSchema, body);
}

function parseRequestBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Deadline policy validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}
