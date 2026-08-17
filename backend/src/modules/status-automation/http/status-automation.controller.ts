import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { StatusAutomationRulesService } from '../application/status-automation-rules.service';
import {
  parseCreateStatusAutomationRuleRequest,
  parseUpdateStatusAutomationRuleRequest,
} from '../dto/status-automation.dto';

@ApiTags('Status Automation')
@ApiBearerAuth()
@Controller('')
export class StatusAutomationController {
  constructor(
    @Inject(StatusAutomationRulesService)
    private readonly service: StatusAutomationRulesService,
  ) {}

  // Rule CRUD intentionally remains available when the runtime engine is disabled:
  // operators must be able to configure rules before enabling execution.
  @ApiResponse({ status: 200, description: 'Status automation rules' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiOperation({ operationId: 'listStatusAutomationRules', summary: 'List status automation rules' })
  @Get('status-automation/rules')
  @RequirePermissions('status_automation.view')
  async list(@Req() request: RequestWithCurrentUser) {
    return this.service.list(this.requireCurrentUser(request), requireRequestId(request));
  }

  @ApiResponse({ status: 201, description: 'Created status automation rule' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Status automation rule conflict' })
  @ApiResponse({ status: 422, description: 'Invalid status automation rule payload' })
  @ApiOperation({ operationId: 'createStatusAutomationRule', summary: 'Create a status automation rule' })
  @Post('status-automation/rules')
  @HttpCode(201)
  @RequirePermissions('status_automation.manage')
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    const currentUser = this.requireCurrentUser(request);
    return this.service.create(
      currentUser,
      requireRequestId(request),
      parseCreateStatusAutomationRuleRequest(body),
    );
  }

  @ApiParam({ name: 'ruleId', type: Number, description: 'Status automation rule ID' })
  @ApiResponse({ status: 200, description: 'Updated status automation rule' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Status automation rule not found' })
  @ApiResponse({ status: 409, description: 'Status automation rule version conflict' })
  @ApiResponse({ status: 422, description: 'Invalid rule ID or payload' })
  @ApiOperation({ operationId: 'updateStatusAutomationRule', summary: 'Update a status automation rule' })
  @Patch('status-automation/rules/:ruleId')
  @RequirePermissions('status_automation.manage')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('ruleId') ruleId: string,
    @Body() body: unknown,
  ) {
    const currentUser = this.requireCurrentUser(request);
    return this.service.update(
      currentUser,
      requireRequestId(request),
      parseRuleId(ruleId),
      parseUpdateStatusAutomationRuleRequest(body),
    );
  }

  @ApiParam({ name: 'ruleId', type: Number, description: 'Status automation rule ID' })
  @ApiResponse({ status: 200, description: 'Deleted status automation rule' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Status automation rule not found' })
  @ApiResponse({ status: 422, description: 'Invalid rule ID' })
  @ApiOperation({ operationId: 'deleteStatusAutomationRule', summary: 'Delete a status automation rule' })
  @Delete('status-automation/rules/:ruleId')
  @RequirePermissions('status_automation.manage')
  async delete(@Req() request: RequestWithCurrentUser, @Param('ruleId') ruleId: string) {
    const currentUser = this.requireCurrentUser(request);
    return this.service.delete(currentUser, requireRequestId(request), parseRuleId(ruleId));
  }

  @ApiResponse({ status: 200, description: 'Status automation event types' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiOperation({ operationId: 'listStatusAutomationEventTypes', summary: 'List status automation event types' })
  @Get('status-automation/event-types')
  @RequirePermissions('status_automation.view')
  async listEventTypes(@Req() request: RequestWithCurrentUser) {
    return this.service.listEventTypes(this.requireCurrentUser(request), requireRequestId(request));
  }

  @ApiResponse({ status: 200, description: 'Recent orders were checked by enabled status automation rules' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiOperation({
    operationId: 'refreshRecentOrdersStatusAutomation',
    summary: 'Force-check recent orders by all enabled status automation rules',
  })
  @Post('status-automation/refresh-recent-orders')
  @HttpCode(200)
  @RequirePermissions('status_automation.manage')
  async refreshRecentOrders(@Req() request: RequestWithCurrentUser) {
    return this.service.refreshRecentOrders(
      this.requireCurrentUser(request),
      requireRequestId(request),
    );
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }
}

function parseRuleId(value: string): number {
  const ruleId = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(ruleId) || ruleId <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'ruleId must be a positive integer', {
      field: 'ruleId',
    });
  }

  return ruleId;
}

function requireRequestId(request: RequestWithCurrentUser): string {
  if (!request.requestId) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  }

  return request.requestId;
}
