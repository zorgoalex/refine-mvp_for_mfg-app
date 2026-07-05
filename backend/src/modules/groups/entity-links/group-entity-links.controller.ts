import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { parseGroupId } from '../groups.controller';
import { GroupsRuntimeConfigService } from '../groups-runtime-config.service';
import {
  parseAppendGroupEntityLinksRequest,
  parseReplaceGroupEntityLinksRequest,
  GROUP_ENTITY_TYPE_CODES,
  type GroupEntityLinksResponseDto,
  type GroupEntityTypeCode,
} from './group-entity-links.dto';
import { GroupEntityLinksService } from './group-entity-links.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;
const entityTypeSchema = z.enum(GROUP_ENTITY_TYPE_CODES);

const groupEntityLinksResponseSwaggerSchema = {
  type: 'object',
  required: ['groupId', 'links', 'requestId'],
  additionalProperties: false,
  properties: {
    groupId: { type: 'string', format: 'uuid' },
    links: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'entityType', 'entityId', 'displayLabel', 'relationType', 'validFrom', 'validTo', 'metadata'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          entityType: { type: 'string', enum: GROUP_ENTITY_TYPE_CODES },
          entityId: { type: 'string' },
          displayLabel: { type: 'string', nullable: true },
          relationType: { type: 'string' },
          validFrom: { type: 'string', format: 'date-time' },
          validTo: { type: 'string', format: 'date-time', nullable: true },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
    },
    requestId: { type: 'string' },
    changed: { type: 'boolean' },
    auditId: { type: 'string' },
  },
} as const;

const groupEntityLinksRequestSwaggerSchema = {
  type: 'object',
  required: ['idempotencyKey', 'links'],
  additionalProperties: false,
  properties: {
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    links: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        required: ['entityType', 'entityId'],
        additionalProperties: false,
        properties: {
          entityType: { type: 'string', enum: GROUP_ENTITY_TYPE_CODES },
          entityId: { type: 'string', minLength: 1, maxLength: 200 },
          relationType: { type: 'string', default: 'related' },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
    },
    reason: { type: 'string', maxLength: 500, nullable: true },
  },
} as const;

@ApiTags('Groups')
@ApiBearerAuth('bearerAuth')
@Controller('groups/:groupId/entity-links')
export class GroupEntityLinksController {
  constructor(
    @Inject(GroupEntityLinksService)
    private readonly links: GroupEntityLinksService,
    @Inject(GroupsRuntimeConfigService)
    private readonly runtimeConfig: GroupsRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiQuery({ name: 'entityType', required: false, enum: GROUP_ENTITY_TYPE_CODES })
  @ApiQuery({ name: 'includeClosed', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Group entity links', schema: swaggerSchema(groupEntityLinksResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({ operationId: 'listGroupEntityLinks', summary: 'List group entity links' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<GroupEntityLinksResponseDto> {
    this.assertGroupsEnabled();
    const currentUser = this.requireCurrentUser(request);
    const entityType = parseEntityType(query.entityType);
    return this.links.list({
      currentUser,
      groupId: parseGroupId(groupIdParam),
      entityType,
      includeClosed: parseBoolean(query.includeClosed),
      visibleEntityTypes: entityType ? undefined : this.links.visibleEntityTypes(currentUser),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiBody({ schema: swaggerSchema(groupEntityLinksRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Replaced group entity links', schema: swaggerSchema(groupEntityLinksResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid payload' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled or read-only' })
  @ApiOperation({ operationId: 'replaceGroupEntityLinks', summary: 'Replace current group entity links' })
  @Put()
  @HttpCode(200)
  async replace(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
    @Body() body: unknown,
  ): Promise<GroupEntityLinksResponseDto> {
    this.assertGroupWritesEnabled();
    return this.links.replace({
      currentUser: this.requireCurrentUser(request),
      groupId: parseGroupId(groupIdParam),
      dto: parseReplaceGroupEntityLinksRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiBody({ schema: swaggerSchema(groupEntityLinksRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Appended group entity links', schema: swaggerSchema(groupEntityLinksResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid payload' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled or read-only' })
  @ApiOperation({ operationId: 'appendGroupEntityLinks', summary: 'Append group entity links' })
  @Post()
  async append(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
    @Body() body: unknown,
  ): Promise<GroupEntityLinksResponseDto> {
    this.assertGroupWritesEnabled();
    return this.links.append({
      currentUser: this.requireCurrentUser(request),
      groupId: parseGroupId(groupIdParam),
      dto: parseAppendGroupEntityLinksRequest(body),
      requestId: request.requestId,
    });
  }

  private assertGroupsEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().groupsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is disabled', { feature: 'groups' });
    }
  }

  private assertGroupWritesEnabled(): void {
    this.assertGroupsEnabled();
    if (this.runtimeConfig.getFeatureFlags().groupsReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is read-only', {
        feature: 'groups',
        readOnly: true,
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}

function parseEntityType(value: string | string[] | undefined): GroupEntityTypeCode | undefined {
  const raw = single(value);
  if (!raw) return undefined;
  const parsed = entityTypeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid entityType', { field: 'entityType' });
  }
  return parsed.data;
}

function parseBoolean(value: string | string[] | undefined): boolean | undefined {
  const raw = single(value);
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ApiError(422, 'VALIDATION_ERROR', 'includeClosed must be true or false', { field: 'includeClosed' });
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
