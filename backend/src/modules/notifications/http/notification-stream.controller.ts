import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { NotificationStreamService } from '../application/notification-stream.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationStreamController {
  constructor(private readonly streams: NotificationStreamService) {}

  @ApiOperation({
    operationId: 'streamNotificationSignals',
    summary: 'SSE: `hello` on connect, `changed` when the current user\'s notifications change (no content)',
  })
  @ApiResponse({ status: 200, description: 'SSE stream' })
  @ApiResponse({ status: 204, description: 'Notification stream is disabled (BACKEND_NOTIFICATION_STREAM_ENABLED)' })
  @ApiResponse({ status: 429, description: 'Notification stream connection limit reached' })
  @Get('stream')
  stream(@Req() request: RequestWithCurrentUser, @Res() response: Response): void {
    if (!request.user) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
    const result = this.streams.open({ tokenUser: request.user, accessTokenExpiresAt: request.accessTokenExpiresAt, response });
    if (result === 'disabled') {
      response.setHeader('Cache-Control', 'no-store');
      response.status(204).end();
      return;
    }
    if (result === 'limited') {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Retry-After', '30');
      response.status(429).json({
        error: { code: 'NOTIFICATION_STREAM_CONNECTION_LIMIT', message: 'Notification stream connection limit reached' },
      });
    }
  }
}
