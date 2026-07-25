import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DeadlineDefaultScheduleService } from '../application/deadline-default-schedule.service';
import { MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS } from '../domain/deadline-default-schedule';
import type { ReplaceDeadlineDefaultScheduleRequestDto } from '../dto/deadline-default-schedule.dto';
import { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;
const requestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reserveDays: z.number().int().min(0).max(3650),
  reason: z.string().trim().min(3).max(500),
  stages: z
    .array(
      z.object({
        productionStatusId: z.number().int().positive(),
        durationDays: z.number().int().min(0).max(3650),
        parallelWithPrevious: z.boolean(),
      }),
    ),
}).superRefine((value, context) => {
  if (value.stages.length === 0 && value.reserveDays !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reserveDays'],
      message: 'reserveDays must be 0 when stages is empty',
    });
  }
  if (value.stages[0]?.parallelWithPrevious) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stages', 0, 'parallelWithPrevious'],
      message: 'first stage cannot be parallel with a previous stage',
    });
  }
  let total = value.reserveDays;
  let groupMaximum = 0;
  for (const [index, stage] of value.stages.entries()) {
    if (index > 0 && !stage.parallelWithPrevious) {
      total += groupMaximum;
      groupMaximum = 0;
    }
    groupMaximum = Math.max(groupMaximum, stage.durationDays);
  }
  total += groupMaximum;
  if (total > MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stages'],
      message: `total schedule must not exceed ${MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS} days`,
    });
  }
  if (new Set(value.stages.map((stage) => stage.productionStatusId)).size !== value.stages.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stages'],
      message: 'productionStatusId values must be unique',
    });
  }
});

const responseSwaggerSchema = {
  type: 'object',
  required: ['schedule'],
  properties: {
    schedule: {
      type: 'object',
      required: [
        'configured',
        'hasStoredConfiguration',
        'version',
        'reserveDays',
        'totalProductionDays',
        'plannedOrderDays',
        'updatedAt',
        'stages',
      ],
      properties: {
        configured: { type: 'boolean' },
        hasStoredConfiguration: { type: 'boolean' },
        version: { type: 'integer', minimum: 1 },
        reserveDays: { type: 'integer', minimum: 0, maximum: 3650 },
        totalProductionDays: { type: 'integer', nullable: true },
        plannedOrderDays: { type: 'integer', nullable: true },
        updatedAt: { type: 'string', format: 'date-time', nullable: true },
        stages: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'productionStatusId',
              'productionStatusName',
              'productionStatusCode',
              'sortOrder',
              'durationDays',
              'parallelWithPrevious',
              'cumulativeDeadlineDays',
            ],
            properties: {
              productionStatusId: { type: 'integer' },
              productionStatusName: { type: 'string' },
              productionStatusCode: { type: 'string', nullable: true },
              sortOrder: { type: 'integer' },
              durationDays: { type: 'integer', nullable: true },
              parallelWithPrevious: { type: 'boolean' },
              cumulativeDeadlineDays: { type: 'integer', nullable: true },
            },
          },
        },
      },
    },
  },
} as const;

@ApiTags('Deadline Default Schedule')
@ApiBearerAuth()
@Controller('deadline-default-schedule')
export class DeadlineDefaultScheduleController {
  constructor(
    @Inject(DeadlineDefaultScheduleService)
    private readonly service: DeadlineDefaultScheduleService,
    @Inject(DeadlinesRuntimeConfigService)
    private readonly runtimeConfig: DeadlinesRuntimeConfigService,
  ) {}

  @ApiOperation({
    operationId: 'getDeadlineDefaultSchedule',
    summary: 'Get default production and order readiness schedule',
  })
  @ApiResponse({ status: 200, schema: swaggerSchema(responseSwaggerSchema) })
  @Get()
  async get(@Req() request: RequestWithCurrentUser) {
    this.assertReadEnabled();
    return { schedule: await this.service.get({ currentUser: requireUser(request) }) };
  }

  @ApiBody({
    schema: swaggerSchema({
      type: 'object',
      required: ['expectedVersion', 'reserveDays', 'reason', 'stages'],
      properties: {
        expectedVersion: { type: 'integer', minimum: 1 },
        reserveDays: { type: 'integer', minimum: 0, maximum: 3650 },
        reason: { type: 'string', minLength: 3, maxLength: 500 },
        stages: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'productionStatusId',
              'durationDays',
              'parallelWithPrevious',
            ],
            properties: {
              productionStatusId: { type: 'integer', minimum: 1 },
              durationDays: { type: 'integer', minimum: 0, maximum: 3650 },
              parallelWithPrevious: { type: 'boolean' },
            },
          },
        },
      },
    }),
  })
  @ApiResponse({ status: 200, schema: swaggerSchema(responseSwaggerSchema) })
  @ApiOperation({
    operationId: 'replaceDeadlineDefaultSchedule',
    summary: 'Replace default production and order readiness schedule',
  })
  @Put()
  async replace(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    this.assertWriteEnabled();
    return {
      schedule: await this.service.replace({
        currentUser: requireUser(request),
        requestId: request.requestId,
        dto: parseReplaceDeadlineDefaultScheduleRequest(body),
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
    this.assertReadEnabled();
    if (this.runtimeConfig.getFeatureFlags().deadlinesReadOnly) {
      throw new ApiError(503, 'DEADLINES_READ_ONLY', 'Deadline settings are read-only', {
        feature: 'deadlines',
        mode: 'read_only',
      });
    }
  }
}

export function parseReplaceDeadlineDefaultScheduleRequest(
  body: unknown,
): ReplaceDeadlineDefaultScheduleRequestDto {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Deadline default schedule validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function requireUser(request: RequestWithCurrentUser) {
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return request.user;
}
