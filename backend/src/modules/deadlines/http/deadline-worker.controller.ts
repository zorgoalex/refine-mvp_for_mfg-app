import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
  @ApiResponse({ status: 422, description: 'Validation error' })
  @ApiResponse({ status: 503, description: 'Deadlines or worker processing disabled' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        now: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1 },
      },
    },
  })
  @Post('process-due-now')
  @RequirePermissions('deadlines.worker.manage')
  @HttpCode(200)
  async processDueNow(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    const currentUser = this.requireCurrentUser(request);
    this.assertManualWorkerEnabled(currentUser);
    const parsedBody = parseProcessDueNowRequest(body);
    const flags = this.runtimeConfig.getFeatureFlags();
    const cappedLimit = resolveWorkerBatchLimit(parsedBody.limit, flags.deadlineWorkerBatchSize);

    return this.worker.processDueDeadlines({
      now: parsedBody.now ?? new Date().toISOString(),
      limit: cappedLimit,
      workerId: flags.deadlineWorkerId,
      trigger: 'manual',
      actorUserId: currentUser.id,
      requestId: request.requestId,
      config: {
        actionsEnabled: flags.deadlineActionsEnabled,
        notificationsEnabled: flags.deadlineNotificationsEnabled,
        engineOwnsDeadline: flags.notificationEngineOwnsDeadline,
      },
    });
  }

  @ApiOperation({
    operationId: 'processDueDeadlinesScheduled',
    summary: 'Process one scheduled Deadline Engine worker batch',
    description:
      'Runs a single platform-cron-owned worker batch. This endpoint requires an external scheduler owner.',
  })
  @ApiResponse({ status: 200, description: 'Scheduled worker batch processed' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  @ApiResponse({ status: 503, description: 'Deadlines, worker processing, or scheduler owner disabled' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        now: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1 },
      },
    },
  })
  @Post('process-due-scheduled')
  @RequirePermissions('deadlines.worker.schedule')
  @HttpCode(200)
  async processDueScheduled(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    const currentUser = this.requireCurrentUser(request);
    this.assertScheduledWorkerEnabled(currentUser);
    const flags = this.runtimeConfig.getFeatureFlags();

    if (flags.deadlineWorkerSchedulerOwner !== 'external') {
      throw new ApiError(
        503,
        'DEADLINE_WORKER_SCHEDULER_OWNER_MISMATCH',
        'Deadline worker scheduler endpoint requires external scheduler owner',
      );
    }

    const parsedBody = parseProcessDueNowRequest(body);
    const cappedLimit = resolveWorkerBatchLimit(parsedBody.limit, flags.deadlineWorkerBatchSize);

    return this.worker.processDueDeadlines({
      now: parsedBody.now ?? new Date().toISOString(),
      limit: cappedLimit,
      workerId: flags.deadlineWorkerId,
      trigger: 'scheduler',
      schedulerRunId: `deadline-worker-scheduled-${request.requestId}`,
      actorUserId: currentUser.id,
      requestId: request.requestId,
      config: {
        actionsEnabled: flags.deadlineActionsEnabled,
        notificationsEnabled: flags.deadlineNotificationsEnabled,
        engineOwnsDeadline: flags.notificationEngineOwnsDeadline,
      },
    });
  }

  private assertManualWorkerEnabled(currentUser: CurrentUser): void {
    this.assertWorkerProcessingEnabled();

    const hasPermission = currentUser.permissions.includes('deadlines.worker.manage');

    if (!hasPermission) {
      throw new ApiError(
        403,
        'PERMISSION_DENIED',
        'Deadline worker manual processing requires deadlines.worker.manage',
      );
    }
  }

  private assertScheduledWorkerEnabled(currentUser: CurrentUser): void {
    this.assertWorkerProcessingEnabled();

    const hasPermission = currentUser.permissions.includes('deadlines.worker.schedule');

    if (!hasPermission) {
      throw new ApiError(
        403,
        'PERMISSION_DENIED',
        'Deadline worker scheduled processing requires deadlines.worker.schedule',
      );
    }
  }

  private assertWorkerProcessingEnabled(): void {
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

function resolveWorkerBatchLimit(limit: number | undefined, batchSize: number): number {
  const requestedLimit = Number.isFinite(limit) && limit ? Math.trunc(limit) : batchSize;

  return Math.max(1, Math.min(requestedLimit, batchSize));
}
