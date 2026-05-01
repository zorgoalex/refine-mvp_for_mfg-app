import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DeadlineCommandService } from '../application/deadline-command.service';
import { DeadlineQueryService } from '../application/deadline-query.service';
import type { UpdateDeadlineSettingsRequestDto } from '../dto/deadline-settings.dto';
import { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

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

@Controller('deadline-settings')
export class DeadlineSettingsController {
  constructor(
    private readonly commands: DeadlineCommandService,
    private readonly queries: DeadlineQueryService,
    private readonly runtimeConfig: DeadlinesRuntimeConfigService,
  ) {}

  @Get()
  async get(@Req() request: RequestWithCurrentUser) {
    this.assertReadEnabled();

    return this.queries.getSettings({
      currentUser: this.requireCurrentUser(request),
    });
  }

  @Patch()
  async update(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    this.assertWriteEnabled();

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
