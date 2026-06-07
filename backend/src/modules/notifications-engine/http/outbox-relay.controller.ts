import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { OutboxRelayService } from '../application/outbox-relay.service';
import { NotificationsRuntimeConfigService } from './notifications-runtime-config.service';

@ApiTags('Outbox Relay')
@ApiBearerAuth()
@Controller('outbox-relay')
export class OutboxRelayController {
  constructor(
    @Inject(OutboxRelayService) private readonly relay: OutboxRelayService,
    @Inject(NotificationsRuntimeConfigService)
    private readonly runtimeConfig: NotificationsRuntimeConfigService,
  ) {}

  @ApiOperation({
    operationId: 'processOutboxRelayNow',
    summary: 'Process one manual outbox relay batch',
    description:
      'Runs a single backend-owned outbox relay batch. This endpoint does not start an interval, poller, scheduler, or queue consumer.',
  })
  @ApiResponse({ status: 200, description: 'Manual outbox relay batch processed' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  @ApiResponse({ status: 503, description: 'Notification engine is disabled' })
  @Post('process-now')
  @RequirePermissions('notifications.manage_rules')
  @HttpCode(200)
  async processNow(@Req() request: RequestWithCurrentUser) {
    this.requireCurrentUser(request);
    this.assertEngineEnabled();

    return this.relay.processBatchOnce();
  }

  @ApiOperation({
    operationId: 'processOutboxRelayScheduled',
    summary: 'Process one scheduled outbox relay batch',
    description:
      'Runs a single platform-cron-owned outbox relay batch. This endpoint requires an external scheduler owner.',
  })
  @ApiResponse({ status: 200, description: 'Scheduled outbox relay batch processed' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  @ApiResponse({ status: 503, description: 'Notification engine or scheduler owner disabled' })
  @Post('process-scheduled')
  @RequirePermissions('notifications.manage_rules')
  @HttpCode(200)
  async processScheduled(@Req() request: RequestWithCurrentUser) {
    this.requireCurrentUser(request);
    this.assertEngineEnabled();

    const flags = this.runtimeConfig.getFeatureFlags();

    if (flags.relayOwner !== 'external') {
      throw new ApiError(
        503,
        'OUTBOX_RELAY_SCHEDULER_OWNER_MISMATCH',
        'Outbox relay scheduled endpoint requires external scheduler owner',
      );
    }

    return this.relay.processBatchOnce();
  }

  private assertEngineEnabled(): void {
    if (!this.runtimeConfig.isEngineEnabled()) {
      throw new ApiError(503, 'NOTIFICATION_ENGINE_DISABLED', 'Notification engine is disabled', {
        feature: 'notifications',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser): CurrentUser {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }
}
