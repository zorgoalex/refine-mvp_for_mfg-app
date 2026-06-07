import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import {
  NotificationRulesService,
  type ListNotificationRulesFilter,
} from '../application/notification-rules.service';
import { listConfigurableEventTypes } from '../domain/notification-event-registry';
import {
  parseCreateNotificationRuleRequest,
  parseUpdateNotificationRuleRequest,
} from '../dto/notification-rule.dto';
import { NotificationsRuntimeConfigService } from './notifications-runtime-config.service';

@ApiTags('Notification Rules')
@ApiBearerAuth()
@Controller('')
export class NotificationRulesController {
  constructor(
    @Inject(NotificationRulesService)
    private readonly service: NotificationRulesService,
    @Inject(NotificationsRuntimeConfigService)
    private readonly runtimeConfig: NotificationsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'eventType', required: false, type: String })
  @ApiQuery({ name: 'isEnabled', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Notification rules' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Notification engine is disabled' })
  @ApiOperation({ operationId: 'listNotificationRules', summary: 'List notification rules' })
  @Get('notification-rules')
  @RequirePermissions('notifications.view_rules')
  async list(@Req() request: RequestWithCurrentUser, @Query() query: Record<string, unknown>) {
    this.assertReadEnabled();

    return this.service.list(this.requireCurrentUser(request), parseListFilter(query));
  }

  @ApiParam({ name: 'ruleId', type: String })
  @ApiResponse({ status: 200, description: 'Notification rule' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Notification rule not found' })
  @ApiResponse({ status: 503, description: 'Notification engine is disabled' })
  @ApiOperation({ operationId: 'getNotificationRule', summary: 'Get a notification rule by id' })
  @Get('notification-rules/:ruleId')
  @RequirePermissions('notifications.view_rules')
  async getById(@Req() request: RequestWithCurrentUser, @Param('ruleId') ruleId: string) {
    this.assertReadEnabled();

    return this.service.getById(this.requireCurrentUser(request), ruleId);
  }

  @ApiResponse({ status: 201, description: 'Created notification rule' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid notification rule payload' })
  @ApiResponse({ status: 503, description: 'Notification engine is disabled or read-only' })
  @ApiOperation({ operationId: 'createNotificationRule', summary: 'Create a notification rule' })
  @Post('notification-rules')
  @RequirePermissions('notifications.manage_rules')
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    this.assertWriteEnabled();
    const currentUser = this.requireCurrentUser(request);

    return this.service.create(currentUser, requireRequestId(request), parseCreateNotificationRuleRequest(body));
  }

  @ApiParam({ name: 'ruleId', type: String })
  @ApiResponse({ status: 200, description: 'Updated notification rule' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Notification rule not found' })
  @ApiResponse({ status: 422, description: 'Invalid notification rule payload' })
  @ApiResponse({ status: 503, description: 'Notification engine is disabled or read-only' })
  @ApiOperation({ operationId: 'updateNotificationRule', summary: 'Update a notification rule' })
  @Patch('notification-rules/:ruleId')
  @RequirePermissions('notifications.manage_rules')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('ruleId') ruleId: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();
    const currentUser = this.requireCurrentUser(request);
    const parsed = parseUpdateNotificationRuleRequest(body);

    return this.service.update(currentUser, requireRequestId(request), ruleId, parsed);
  }

  @ApiParam({ name: 'ruleId', type: String })
  @ApiResponse({ status: 200, description: 'Deleted notification rule' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Notification rule not found' })
  @ApiResponse({ status: 503, description: 'Notification engine is disabled or read-only' })
  @ApiOperation({ operationId: 'deleteNotificationRule', summary: 'Delete a notification rule' })
  @Delete('notification-rules/:ruleId')
  @RequirePermissions('notifications.manage_rules')
  async delete(@Req() request: RequestWithCurrentUser, @Param('ruleId') ruleId: string) {
    this.assertWriteEnabled();
    const currentUser = this.requireCurrentUser(request);

    return this.service.delete(currentUser, requireRequestId(request), ruleId);
  }

  @ApiResponse({ status: 200, description: 'Configurable notification event types' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Notification engine is disabled' })
  @ApiOperation({ operationId: 'listNotificationEventTypes', summary: 'List configurable notification event types' })
  @Get('notification-event-types')
  @RequirePermissions('notifications.view_rules')
  async listEventTypes(@Req() request: RequestWithCurrentUser) {
    this.assertReadEnabled();
    this.requireCurrentUser(request);

    return listConfigurableEventTypes();
  }

  private assertReadEnabled(): void {
    if (!this.runtimeConfig.isEngineEnabled()) {
      throw new ApiError(503, 'NOTIFICATION_ENGINE_DISABLED', 'Notification engine is disabled', {
        feature: 'notifications',
      });
    }
  }

  private assertWriteEnabled(): void {
    if (!this.runtimeConfig.isEngineEnabled()) {
      throw new ApiError(503, 'NOTIFICATION_ENGINE_DISABLED', 'Notification engine is disabled', {
        feature: 'notifications',
      });
    }
    if (this.runtimeConfig.isRulesReadOnly()) {
      throw new ApiError(503, 'NOTIFICATION_RULES_READ_ONLY', 'Notification rules are read-only', {
        feature: 'notifications',
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

function parseListFilter(query: Record<string, unknown>): ListNotificationRulesFilter {
  const filter: ListNotificationRulesFilter = {};

  const eventType = query?.['eventType'];
  if (typeof eventType === 'string' && eventType.trim().length > 0) {
    filter.eventType = eventType;
  }

  const isEnabled = query?.['isEnabled'];
  if (isEnabled !== undefined) {
    filter.isEnabled = parseBooleanQueryParam(isEnabled);
  }

  return filter;
}

function parseBooleanQueryParam(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid notification rule list filter', {
    errors: [{ field: 'isEnabled', message: 'isEnabled must be a boolean query parameter' }],
  });
}

function requireRequestId(request: RequestWithCurrentUser): string {
  if (!request.requestId) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  }

  return request.requestId;
}
