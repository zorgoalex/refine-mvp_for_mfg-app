import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { GroupsRuntimeConfigService } from '../groups-runtime-config.service';
import {
  parseGroupOrderStatusReportQuery,
  type GroupOrderStatusReportResponseDto,
} from './group-order-status-report.dto';
import { GroupOrderStatusReportService } from './group-order-status-report.service';

const groupOrderStatusReportResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'filter'],
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        required: ['statusId', 'statusName', 'orderCount'],
        properties: {
          statusId: { type: 'integer' },
          statusName: { type: 'string' },
          orderCount: { type: 'integer', minimum: 0 },
        },
      },
    },
    filter: {
      oneOf: [
        {
          type: 'object',
          required: ['groupMode', 'temporalMode'],
          properties: {
            groupMode: { type: 'string', enum: ['none'] },
            temporalMode: { type: 'string', enum: ['current'] },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['groupMode', 'groupIds', 'temporalMode'],
          properties: {
            groupMode: { type: 'string', enum: ['any', 'all', 'primary'] },
            groupIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } },
            temporalMode: { type: 'string', enum: ['current'] },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['groupMode', 'temporalMode', 'asOf'],
          properties: {
            groupMode: { type: 'string', enum: ['none'] },
            temporalMode: { type: 'string', enum: ['asOf'] },
            asOf: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['groupMode', 'groupIds', 'temporalMode', 'asOf'],
          properties: {
            groupMode: { type: 'string', enum: ['any', 'all', 'primary'] },
            groupIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } },
            temporalMode: { type: 'string', enum: ['asOf'] },
            asOf: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['groupMode', 'temporalMode', 'from', 'to'],
          properties: {
            groupMode: { type: 'string', enum: ['none'] },
            temporalMode: { type: 'string', enum: ['overlap'] },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['groupMode', 'groupIds', 'temporalMode', 'from', 'to'],
          properties: {
            groupMode: { type: 'string', enum: ['any', 'all', 'primary'] },
            groupIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } },
            temporalMode: { type: 'string', enum: ['overlap'] },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
      ],
    },
  },
} as const;

const dateTimeQuerySwaggerSchema = { type: 'string', format: 'date-time' } as const;

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

@ApiTags('Groups')
@ApiBearerAuth()
@Controller('groups/reports/order-status-counts')
export class GroupOrderStatusReportController {
  constructor(
    @Inject(GroupOrderStatusReportService)
    private readonly reports: GroupOrderStatusReportService,
    @Inject(GroupsRuntimeConfigService)
    private readonly runtimeConfig: GroupsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'groupMode', required: false, enum: ['any', 'all', 'primary', 'none'] })
  @ApiQuery({ name: 'groupIds', required: false, type: String })
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current', 'asOf', 'overlap'] })
  @ApiQuery({ name: 'asOf', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'from', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'to', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiResponse({
    status: 200,
    description: 'Group-filtered order status counts',
    schema: swaggerSchema(groupOrderStatusReportResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid report query' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({
    operationId: 'listGroupOrderStatusCounts',
    summary: 'List order status counts filtered by group membership',
  })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<GroupOrderStatusReportResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().groupsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is disabled', {
        feature: 'groups',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.reports.listOrderStatusCounts({
      currentUser: request.user,
      query: parseGroupOrderStatusReportQuery(query),
      requestId: request.requestId,
    });
  }
}
