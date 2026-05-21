import { Body, Controller, Get, Inject, Patch, Req } from '@nestjs/common';
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
import { DeadlineCommandService } from '../application/deadline-command.service';
import { DeadlineQueryService } from '../application/deadline-query.service';
import type { UpdateDeadlineSettingsRequestDto } from '../dto/deadline-settings.dto';
import { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const updateDeadlineSettingsSchema = z
  .object({
    reminderEventsEnabled: z.boolean().optional(),
    notifyAssigneeEnabled: z.boolean().optional(),
    notifyManagerEnabled: z.boolean().optional(),
    notifyDepartmentHeadEnabled: z.boolean().optional(),
    setOverdueFlagEnabled: z.boolean().optional(),
    changeOrderStatusEnabled: z.boolean().optional(),
    changeProductionStatusEnabled: z.boolean().optional(),
    escalationEnabled: z.boolean().optional(),
    repeatNotificationsEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

const deadlineSettingsSwaggerProperties = {
  reminderEventsEnabled: { type: 'boolean' },
  notifyAssigneeEnabled: { type: 'boolean' },
  notifyManagerEnabled: { type: 'boolean' },
  notifyDepartmentHeadEnabled: { type: 'boolean' },
  setOverdueFlagEnabled: { type: 'boolean' },
  changeOrderStatusEnabled: { type: 'boolean' },
  changeProductionStatusEnabled: { type: 'boolean' },
  escalationEnabled: { type: 'boolean' },
  repeatNotificationsEnabled: { type: 'boolean' },
} as const;

const updateDeadlineSettingsRequestSwaggerSchema = {
  type: 'object',
  minProperties: 1,
  properties: deadlineSettingsSwaggerProperties,
} as const;

const deadlineSettingsResponseSwaggerSchema = {
  type: 'object',
  required: ['settings'],
  properties: {
    settings: {
      type: 'object',
      required: [
        'reminderEventsEnabled',
        'notifyAssigneeEnabled',
        'notifyManagerEnabled',
        'notifyDepartmentHeadEnabled',
        'setOverdueFlagEnabled',
        'changeOrderStatusEnabled',
        'changeProductionStatusEnabled',
        'escalationEnabled',
        'repeatNotificationsEnabled',
      ],
      properties: deadlineSettingsSwaggerProperties,
    },
  },
} as const;

@ApiTags('Deadline Settings')
@ApiBearerAuth()
@Controller('deadline-settings')
export class DeadlineSettingsController {
  constructor(
    @Inject(DeadlineCommandService)
    private readonly commands: DeadlineCommandService,
    @Inject(DeadlineQueryService)
    private readonly queries: DeadlineQueryService,
    @Inject(DeadlinesRuntimeConfigService)
    private readonly runtimeConfig: DeadlinesRuntimeConfigService,
  ) {}

  @ApiResponse({ status: 200, description: 'Deadline settings', schema: swaggerSchema(deadlineSettingsResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled' })
  @ApiOperation({ operationId: 'getDeadlineSettings', summary: 'Get deadline settings' })
  @Get()
  async get(@Req() request: RequestWithCurrentUser) {
    this.assertReadEnabled();

    return this.queries.getSettings({
      currentUser: this.requireCurrentUser(request),
    });
  }

  @ApiBody({ schema: swaggerSchema(updateDeadlineSettingsRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Updated deadline settings', schema: swaggerSchema(deadlineSettingsResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid deadline settings payload' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled or read-only' })
  @ApiOperation({ operationId: 'updateDeadlineSettings', summary: 'Update deadline settings' })
  @Patch()
  async update(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    this.assertWriteOperationEnabled('updateSettings');

    return {
      settings: await this.commands.updateSettings({
        currentUser: this.requireCurrentUser(request),
        dto: parseUpdateDeadlineSettingsRequest(body),
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
      throw new ApiError(503, 'DEADLINES_READ_ONLY', 'Deadline settings are read-only', {
        feature: 'deadlines',
        mode: 'read_only',
      });
    }
  }

  private assertWriteOperationEnabled(operation: 'updateSettings'): void {
    this.assertWriteEnabled();

    throw new ApiError(503, 'DEADLINE_WRITE_OPERATION_DISABLED', 'Deadline write operation is disabled', {
      feature: 'deadlines',
      operation,
    });
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }
}

export function parseUpdateDeadlineSettingsRequest(
  body: unknown,
): UpdateDeadlineSettingsRequestDto {
  const parsed = updateDeadlineSettingsSchema.safeParse(body);

  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Deadline settings validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}
