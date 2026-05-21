import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { isoDateTimeSchema } from '../domain/deadline-validation';
import { DeadlineWorkerService } from '../application/deadline-worker.service';
import { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

interface ProcessDueNowRequestDto {
  now?: string;
  limit?: number;
}

const processDueNowRequestSchema = z
  .object({
    now: isoDateTimeSchema.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

@ApiTags('Deadline Worker')
@ApiBearerAuth()
@Controller('deadline-worker')
export class DeadlineWorkerController {
  constructor(
    @Inject(DeadlineWorkerService) private readonly worker: DeadlineWorkerService,
    @Inject(DeadlinesRuntimeConfigService)
    private readonly runtimeConfig: DeadlinesRuntimeConfigService,
  ) {}

  @ApiOperation({
    operationId: 'processDueDeadlinesNow',
    summary: 'Process one manual Deadline Engine worker batch',
    description:
      'Runs a single backend-owned worker batch. This endpoint does not start an interval, poller, scheduler, or queue consumer.',
  })
  @ApiResponse({ status: 200, description: 'Manual worker batch processed' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  @ApiResponse({ status: 503, description: 'Deadlines or worker processing disabled' })
  @Post('process-due-now')
  @RequirePermissions('deadlines.worker.manage')
  @HttpCode(200)
  async processDueNow(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    const currentUser = this.requireCurrentUser(request);
    this.assertManualWorkerEnabled(currentUser);
    const parsedBody = parseProcessDueNowRequest(body);
    const flags = this.runtimeConfig.getFeatureFlags();
    const requestedLimit =
      Number.isFinite(parsedBody.limit) && parsedBody.limit
        ? Math.trunc(parsedBody.limit)
        : flags.deadlineWorkerBatchSize;
    const cappedLimit = Math.max(1, Math.min(requestedLimit, flags.deadlineWorkerBatchSize));

    return this.worker.processDueDeadlines({
      now: parsedBody.now ?? new Date().toISOString(),
      limit: cappedLimit,
      workerId: flags.deadlineWorkerId,
      actorUserId: currentUser.id,
      requestId: request.requestId,
      config: {
        actionsEnabled: flags.deadlineActionsEnabled,
        notificationsEnabled: flags.deadlineNotificationsEnabled,
      },
    });
  }

  private assertManualWorkerEnabled(currentUser: CurrentUser): void {
    const flags = this.runtimeConfig.getFeatureFlags();

    if (!flags.deadlinesEnabled) {
      throw new ApiError(503, 'DEADLINES_DISABLED', 'Deadline Engine is disabled');
    }

    if (flags.deadlinesReadOnly) {
      throw new ApiError(503, 'DEADLINES_READ_ONLY', 'Deadline Engine is read-only');
    }

    if (!flags.deadlineWorkerEnabled) {
      throw new ApiError(503, 'DEADLINE_WORKER_DISABLED', 'Deadline worker manual processing is disabled');
    }

    const hasPermission = currentUser.permissions.includes('deadlines.worker.manage');

    if (!hasPermission) {
      throw new ApiError(
        403,
        'PERMISSION_DENIED',
        'Deadline worker manual processing requires deadlines.worker.manage',
      );
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser): CurrentUser {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }
}

export function parseProcessDueNowRequest(body: unknown): ProcessDueNowRequestDto {
  const parsed = processDueNowRequestSchema.safeParse(body ?? {});

  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Deadline worker request validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}
