import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../permissions/current-user';
import {
  parseCreateDirectionRequest,
  parseDeleteConfirmation,
  parseDirectionIdParam,
  parseReplaceIdSetRequest,
  parseUpdateDirectionRequest,
  parseWorkshopIdParam,
} from './org.dto';
import { OrgRuntimeConfigService } from './org-runtime-config.service';
import { OrgService } from './org.service';

@ApiTags('Org')
@ApiBearerAuth('bearerAuth')
@Controller('org')
export class OrgController {
  constructor(
    @Inject(OrgService) private readonly org: OrgService,
    @Inject(OrgRuntimeConfigService) private readonly runtimeConfig: OrgRuntimeConfigService,
  ) {}

  @Get('directions')
  @ApiOperation({ summary: 'List directions with membership/head counts' })
  @ApiResponse({ status: 200, description: 'Directions list' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled' })
  async listDirections(@Req() req: RequestWithCurrentUser) {
    this.assertOrgEnabled();
    const currentUser = this.requireCurrentUser(req);
    return {
      directions: await this.org.listDirections({ currentUser, requestId: req.requestId }),
      requestId: req.requestId,
    };
  }

  @Post('directions')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a direction' })
  @ApiResponse({ status: 201, description: 'Direction created' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Direction name already exists' })
  @ApiResponse({ status: 422, description: 'Invalid request body' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled or read-only' })
  async createDirection(@Req() req: RequestWithCurrentUser, @Body() body: unknown) {
    this.assertOrgWritesEnabled();
    const currentUser = this.requireCurrentUser(req);
    const dto = parseCreateDirectionRequest(body);
    return this.org.createDirection({ currentUser, ...dto, requestId: req.requestId });
  }

  @Get('directions/:directionId')
  @ApiOperation({ summary: 'Get direction detail (workshops, work-centers, heads)' })
  @ApiResponse({ status: 200, description: 'Direction detail' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Direction not found' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled' })
  async getDirection(@Req() req: RequestWithCurrentUser, @Param('directionId') p: string) {
    this.assertOrgEnabled();
    return this.org.getDirection({
      currentUser: this.requireCurrentUser(req),
      directionId: parseDirectionIdParam(p),
      requestId: req.requestId,
    });
  }

  @Patch('directions/:directionId')
  @ApiOperation({ summary: 'Update a direction (partial)' })
  @ApiResponse({ status: 200, description: 'Direction updated' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Direction not found' })
  @ApiResponse({ status: 409, description: 'Direction name already exists' })
  @ApiResponse({ status: 422, description: 'Invalid request body' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled or read-only' })
  async updateDirection(@Req() req: RequestWithCurrentUser, @Param('directionId') p: string, @Body() body: unknown) {
    this.assertOrgWritesEnabled();
    const patch = parseUpdateDirectionRequest(body);
    return this.org.updateDirection({
      currentUser: this.requireCurrentUser(req),
      directionId: parseDirectionIdParam(p),
      patch,
      requestId: req.requestId,
    });
  }

  @Delete('directions/:directionId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hard-delete a direction (requires confirm=true)' })
  @ApiResponse({ status: 200, description: 'Direction deleted' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Direction not found' })
  @ApiResponse({ status: 422, description: 'Hard delete requires confirm=true' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled or read-only' })
  async deleteDirection(
    @Req() req: RequestWithCurrentUser,
    @Param('directionId') p: string,
    @Query('confirm') confirm: string,
  ) {
    this.assertOrgWritesEnabled();
    // Server-enforced confirm guard (422 if absent) — hard delete is destructive.
    parseDeleteConfirmation(confirm);
    return this.org.deleteDirection({
      currentUser: this.requireCurrentUser(req),
      directionId: parseDirectionIdParam(p),
      requestId: req.requestId,
    });
  }

  @Put('directions/:directionId/workshops')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the workshop membership of a direction (idempotent)' })
  @ApiResponse({ status: 200, description: 'Membership replaced' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Direction not found' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid request body' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled or read-only' })
  async replaceDirectionWorkshops(
    @Req() req: RequestWithCurrentUser,
    @Param('directionId') p: string,
    @Body() body: unknown,
  ) {
    this.assertOrgWritesEnabled();
    const dto = parseReplaceIdSetRequest(body);
    return this.org.replaceDirectionWorkshops({
      currentUser: this.requireCurrentUser(req),
      directionId: parseDirectionIdParam(p),
      idempotencyKey: dto.idempotencyKey,
      ids: dto.ids,
      reason: dto.reason ?? null,
      requestId: req.requestId,
    });
  }

  @Put('directions/:directionId/work-centers')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the work-center membership of a direction (idempotent)' })
  @ApiResponse({ status: 200, description: 'Membership replaced' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Direction not found' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid request body' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled or read-only' })
  async replaceDirectionWorkCenters(
    @Req() req: RequestWithCurrentUser,
    @Param('directionId') p: string,
    @Body() body: unknown,
  ) {
    this.assertOrgWritesEnabled();
    const dto = parseReplaceIdSetRequest(body);
    return this.org.replaceDirectionWorkCenters({
      currentUser: this.requireCurrentUser(req),
      directionId: parseDirectionIdParam(p),
      idempotencyKey: dto.idempotencyKey,
      ids: dto.ids,
      reason: dto.reason ?? null,
      requestId: req.requestId,
    });
  }

  @Put('directions/:directionId/heads')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the heads of a direction (idempotent, per-user audit)' })
  @ApiResponse({ status: 200, description: 'Heads replaced' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Direction not found' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid request body or head is not an active user' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled or read-only' })
  async replaceDirectionHeads(
    @Req() req: RequestWithCurrentUser,
    @Param('directionId') p: string,
    @Body() body: unknown,
  ) {
    this.assertOrgWritesEnabled();
    const dto = parseReplaceIdSetRequest(body);
    return this.org.replaceDirectionHeads({
      currentUser: this.requireCurrentUser(req),
      directionId: parseDirectionIdParam(p),
      idempotencyKey: dto.idempotencyKey,
      ids: dto.ids,
      reason: dto.reason ?? null,
      requestId: req.requestId,
    });
  }

  @Get('workshops/:workshopId/heads')
  @ApiOperation({ summary: 'List the heads of a workshop' })
  @ApiResponse({ status: 200, description: 'Workshop heads' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Workshop not found' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled' })
  async listWorkshopHeads(@Req() req: RequestWithCurrentUser, @Param('workshopId') p: string) {
    this.assertOrgEnabled();
    return this.org.listWorkshopHeads({
      currentUser: this.requireCurrentUser(req),
      workshopId: parseWorkshopIdParam(p),
      requestId: req.requestId,
    });
  }

  @Put('workshops/:workshopId/heads')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the heads of a workshop (idempotent, per-user audit)' })
  @ApiResponse({ status: 200, description: 'Heads replaced' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Workshop not found' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid request body or head is not an active user' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled or read-only' })
  async replaceWorkshopHeads(@Req() req: RequestWithCurrentUser, @Param('workshopId') p: string, @Body() body: unknown) {
    this.assertOrgWritesEnabled();
    const dto = parseReplaceIdSetRequest(body);
    return this.org.replaceWorkshopHeads({
      currentUser: this.requireCurrentUser(req),
      workshopId: parseWorkshopIdParam(p),
      idempotencyKey: dto.idempotencyKey,
      ids: dto.ids,
      reason: dto.reason ?? null,
      requestId: req.requestId,
    });
  }

  @Get('lookups/assignable-users')
  @ApiOperation({ summary: 'List active users assignable as heads' })
  @ApiResponse({ status: 200, description: 'Assignable users' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled' })
  async assignableUsers(@Req() req: RequestWithCurrentUser) {
    this.assertOrgEnabled();
    return {
      users: await this.org.assignableUsers({ currentUser: this.requireCurrentUser(req), requestId: req.requestId }),
      requestId: req.requestId,
    };
  }

  @Get('lookups/workshops')
  @ApiOperation({ summary: 'List workshops for membership selection' })
  @ApiResponse({ status: 200, description: 'Workshops' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled' })
  async lookupWorkshops(@Req() req: RequestWithCurrentUser) {
    this.assertOrgEnabled();
    return {
      workshops: await this.org.lookupWorkshops({ currentUser: this.requireCurrentUser(req), requestId: req.requestId }),
      requestId: req.requestId,
    };
  }

  @Get('lookups/work-centers')
  @ApiOperation({ summary: 'List work-centers for membership selection' })
  @ApiResponse({ status: 200, description: 'Work centers' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Org management API is disabled' })
  async lookupWorkCenters(@Req() req: RequestWithCurrentUser) {
    this.assertOrgEnabled();
    return {
      workCenters: await this.org.lookupWorkCenters({
        currentUser: this.requireCurrentUser(req),
        requestId: req.requestId,
      }),
      requestId: req.requestId,
    };
  }

  private assertOrgEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().orgEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Org management API is disabled', { feature: 'org' });
    }
  }

  private assertOrgWritesEnabled(): void {
    this.assertOrgEnabled();
    if (this.runtimeConfig.getFeatureFlags().orgReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Org management API is read-only', { feature: 'org', readOnly: true });
    }
  }

  private requireCurrentUser(req: RequestWithCurrentUser): CurrentUser {
    if (!req.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return req.user;
  }
}
