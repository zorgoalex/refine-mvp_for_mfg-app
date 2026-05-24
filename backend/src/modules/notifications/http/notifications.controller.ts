import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { NotificationService } from '../application/notification.service';
import type { NotificationListQuery } from '../application/notification.types';
import type {
  DeleteNotificationResponseDto,
  MarkAllNotificationsReadResponseDto,
  NotificationListResponseDto,
  NotificationResponseDto,
} from '../dto/notification.dto';

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    @Inject(NotificationService)
    private readonly notifications: Pick<NotificationService, 'list' | 'markRead' | 'markAllRead' | 'delete'>,
  ) {}

  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Notification list' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 422, description: 'Invalid notification list query' })
  @ApiOperation({ operationId: 'listNotifications', summary: 'List current-user notifications' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<NotificationListResponseDto> {
    return this.notifications.list({
      currentUser: request.user,
      query: parseNotificationListQuery(query),
    });
  }

  @ApiParam({ name: 'notificationId', type: String, description: 'Notification UUID' })
  @ApiResponse({ status: 200, description: 'Marked notification as read' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  @ApiOperation({ operationId: 'markNotificationRead', summary: 'Mark a notification as read' })
  @Patch(':notificationId/read')
  async markRead(
    @Req() request: RequestWithCurrentUser,
    @Param('notificationId') notificationId: string,
  ): Promise<NotificationResponseDto> {
    return this.notifications.markRead({
      currentUser: request.user,
      notificationId,
    });
  }

  @ApiResponse({ status: 200, description: 'Marked current-user notifications as read' })
  @ApiOperation({ operationId: 'markAllNotificationsRead', summary: 'Mark all current-user notifications as read' })
  @Patch('read-all')
  async markAllRead(
    @Req() request: RequestWithCurrentUser,
  ): Promise<MarkAllNotificationsReadResponseDto> {
    return this.notifications.markAllRead({ currentUser: request.user });
  }

  @ApiParam({ name: 'notificationId', type: String, description: 'Notification UUID' })
  @ApiResponse({ status: 200, description: 'Deleted notification' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  @ApiOperation({ operationId: 'deleteNotification', summary: 'Delete a current-user notification' })
  @Delete(':notificationId')
  @HttpCode(200)
  async delete(
    @Req() request: RequestWithCurrentUser,
    @Param('notificationId') notificationId: string,
  ): Promise<DeleteNotificationResponseDto> {
    return this.notifications.delete({
      currentUser: request.user,
      notificationId,
    });
  }
}

export function parseNotificationListQuery(
  query: Record<string, string | string[] | undefined>,
): NotificationListQuery {
  const result = listQuerySchema.safeParse({
    page: firstQueryValue(query.page),
    pageSize: firstQueryValue(query.pageSize),
    unreadOnly: firstQueryValue(query.unreadOnly),
  });

  if (!result.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid notification list query', {
      issues: result.error.issues,
    });
  }

  return result.data;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
