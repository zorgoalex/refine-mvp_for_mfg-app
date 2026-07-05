import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { parseGroupId } from '../groups.controller';
import { GroupsRuntimeConfigService } from '../groups-runtime-config.service';
import {
  parseGroupOverviewQuery,
  GROUP_OVERVIEW_OMITTED,
  type GroupOverviewResponseDto,
} from './group-overview.dto';
import { GroupOverviewService } from './group-overview.service';

const groupStatuses = ['draft', 'active', 'paused', 'completed', 'archived'] as const;
const relationTypes = ['main', 'secondary', 'reporting', 'billing', 'derived'] as const;

const groupOverviewFilterSwaggerSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['groupId', 'temporalMode'],
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', format: 'uuid' },
        temporalMode: { type: 'string', enum: ['current'] },
        createdFrom: { type: 'string', format: 'date-time' },
        createdTo: { type: 'string', format: 'date-time' },
      },
    },
    {
      type: 'object',
      required: ['groupId', 'temporalMode', 'asOf'],
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', format: 'uuid' },
        temporalMode: { type: 'string', enum: ['asOf'] },
        asOf: { type: 'string', format: 'date-time' },
        createdFrom: { type: 'string', format: 'date-time' },
        createdTo: { type: 'string', format: 'date-time' },
      },
    },
    {
      type: 'object',
      required: ['groupId', 'temporalMode', 'from', 'to'],
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', format: 'uuid' },
        temporalMode: { type: 'string', enum: ['overlap'] },
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
        createdFrom: { type: 'string', format: 'date-time' },
        createdTo: { type: 'string', format: 'date-time' },
      },
    },
  ],
} as const;

const groupOverviewResponseSwaggerSchema = {
  type: 'object',
  required: ['group', 'orders', 'linkedEntityCounts', 'participants', 'filter', 'omitted'],
  additionalProperties: false,
  properties: {
    group: {
      type: 'object',
      required: [
        'id',
        'code',
        'name',
        'description',
        'status',
        'startsAt',
        'endsAt',
        'ownerUserId',
        'createdAt',
        'updatedAt',
        'archivedAt',
      ],
      additionalProperties: false,
      properties: {
        id: { type: 'string', format: 'uuid' },
        code: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        status: { type: 'string', enum: groupStatuses },
        startsAt: { type: 'string', format: 'date', nullable: true },
        endsAt: { type: 'string', format: 'date', nullable: true },
        ownerUserId: { type: 'integer', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        archivedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
    orders: {
      type: 'object',
      required: ['totalCount', 'statusCounts', 'relationCounts', 'createdMonthCounts'],
      additionalProperties: false,
      properties: {
        totalCount: { type: 'integer', minimum: 0 },
        statusCounts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['statusId', 'statusName', 'orderCount'],
            additionalProperties: false,
            properties: {
              statusId: { type: 'integer' },
              statusName: { type: 'string' },
              orderCount: { type: 'integer', minimum: 0 },
            },
          },
        },
        relationCounts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['relationType', 'isPrimary', 'orderCount'],
            additionalProperties: false,
            properties: {
              relationType: { type: 'string', enum: relationTypes },
              isPrimary: { type: 'boolean' },
              orderCount: { type: 'integer', minimum: 0 },
            },
          },
        },
        createdMonthCounts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['month', 'orderCount'],
            additionalProperties: false,
            properties: {
              month: { type: 'string', format: 'date' },
              orderCount: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
    linkedEntityCounts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['entityType', 'currentCount'],
        additionalProperties: false,
        properties: {
          entityType: { type: 'string' },
          currentCount: { type: 'integer', minimum: 0 },
        },
      },
    },
    participants: {
      type: 'object',
      required: ['currentSummary'],
      additionalProperties: false,
      properties: {
        currentSummary: {
          type: 'array',
          items: {
            type: 'object',
            required: ['roleCode', 'roleLabel', 'participantCount'],
            additionalProperties: false,
            properties: {
              roleCode: { type: 'string' },
              roleLabel: { type: 'string' },
              participantCount: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
    filter: groupOverviewFilterSwaggerSchema,
    omitted: {
      type: 'array',
      items: { type: 'string', enum: GROUP_OVERVIEW_OMITTED },
    },
  },
} as const;

const dateTimeQuerySwaggerSchema = { type: 'string', format: 'date-time' } as const;
const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

@ApiTags('Groups')
@ApiBearerAuth('bearerAuth')
@Controller('groups/:groupId/overview')
export class GroupOverviewController {
  constructor(
    @Inject(GroupOverviewService)
    private readonly overviews: GroupOverviewService,
    @Inject(GroupsRuntimeConfigService)
    private readonly runtimeConfig: GroupsRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current', 'asOf', 'overlap'], schema: { default: 'current' } })
  @ApiQuery({ name: 'asOf', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'from', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'to', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'createdFrom', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'createdTo', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiResponse({
    status: 200,
    description: 'Group overview',
    schema: swaggerSchema(groupOverviewResponseSwaggerSchema),
  })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Group not found' })
  @ApiResponse({ status: 422, description: 'Invalid overview query' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({
    operationId: 'getGroupOverview',
    summary: 'Get group overview',
    description: 'Returns only group summary fields and aggregate order counts for one group.',
  })
  @Get()
  async getOverview(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<GroupOverviewResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().groupsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is disabled', {
        feature: 'groups',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.overviews.getOverview({
      currentUser: request.user,
      groupId: parseGroupId(groupIdParam),
      query: parseGroupOverviewQuery(query),
      requestId: request.requestId,
    });
  }
}
