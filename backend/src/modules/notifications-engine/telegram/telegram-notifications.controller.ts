import {
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Post,
  Req,
  Body,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { TelegramNotificationDeliveryService } from './telegram-notification-delivery.service';
import { TelegramNotificationsService } from './telegram-notifications.service';

@ApiTags('Notification Channels')
@Controller('')
export class TelegramNotificationsController {
  constructor(
    @Inject(TelegramNotificationsService)
    private readonly telegram: TelegramNotificationsService,
    @Inject(TelegramNotificationDeliveryService)
    private readonly delivery: TelegramNotificationDeliveryService,
  ) {}

  @ApiBearerAuth()
  @ApiOperation({
    operationId: 'getCurrentUserTelegramNotificationChannel',
    summary: 'Get current user Telegram notification channel status',
  })
  @ApiResponse({ status: 200, description: 'Telegram channel status without Telegram identifiers' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @Get('me/notification-channels/telegram')
  async getStatus(@Req() request: RequestWithCurrentUser) {
    return this.telegram.getStatus(requireCurrentUser(request));
  }

  @ApiBearerAuth()
  @ApiOperation({
    operationId: 'startCurrentUserTelegramNotificationChannelLink',
    summary: 'Create a one-time Telegram linking URL',
  })
  @ApiResponse({ status: 201, description: 'One-time Telegram link' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 503, description: 'Telegram notifications are not configured' })
  @Post('me/notification-channels/telegram/link')
  async startLink(@Req() request: RequestWithCurrentUser) {
    return this.telegram.startLink(requireCurrentUser(request), requireRequestId(request));
  }

  @ApiBearerAuth()
  @ApiOperation({
    operationId: 'disconnectCurrentUserTelegramNotificationChannel',
    summary: 'Disconnect current user Telegram notification channel',
  })
  @ApiResponse({ status: 200, description: 'Telegram channel disconnected' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @Delete('me/notification-channels/telegram')
  async unlink(@Req() request: RequestWithCurrentUser) {
    return this.telegram.unlink(requireCurrentUser(request), requireRequestId(request));
  }

  @ApiHeader({
    name: 'X-Telegram-Bot-Api-Secret-Token',
    required: true,
    description: 'Telegram webhook secret token',
  })
  @ApiOperation({
    operationId: 'receiveTelegramNotificationWebhook',
    summary: 'Receive Telegram bot webhook updates',
  })
  @ApiResponse({ status: 201, description: 'Update accepted' })
  @ApiResponse({ status: 401, description: 'Invalid webhook secret' })
  @Post('notification-channels/telegram/webhook')
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ) {
    return this.telegram.handleWebhook(secret, body);
  }

  @ApiBearerAuth()
  @ApiOperation({
    operationId: 'processTelegramNotificationDeliveriesNow',
    summary: 'Process one Telegram notification delivery batch',
  })
  @ApiResponse({ status: 201, description: 'Delivery batch summary' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @Post('notification-channels/telegram/process-now')
  @RequirePermissions('notifications.manage_rules')
  async processNow(@Req() request: RequestWithCurrentUser) {
    requireCurrentUser(request);
    return this.delivery.processBatchOnce();
  }
}

function requireCurrentUser(request: RequestWithCurrentUser) {
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return request.user;
}

function requireRequestId(request: RequestWithCurrentUser): string {
  if (!request.requestId) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  }
  return request.requestId;
}
