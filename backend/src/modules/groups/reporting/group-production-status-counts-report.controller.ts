import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { GroupsRuntimeConfigService } from '../groups-runtime-config.service';
import {
  parseGroupProductionStatusCountsReportQuery,
  type GroupProductionStatusCountsReportResponseDto,
} from './group-production-status-counts-report.dto';
import { GroupProductionStatusCountsReportService } from './group-production-status-counts-report.service';

const groupProductionStatusCountsReportResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'filter'],
  additionalProperties: false,
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        required: ['productionStatusId', 'productionStatusCode', 'productionStatusName', 'orderCount'],
        additionalProperties: false,
        properties: {
          productionStatusId: { type: 'integer', nullable: true },
          productionStatusCode: { type: 'string', nullable: true },
          productionStatusName: { type: 'string' },
          orderCount: { type: 'integer', minimum: 0 },
        },
      },
    },
    filter: {
      oneOf: [
        {
          type: 'object',
          required: ['groupMode', 'temporalMode'],
          additionalProperties: false,
          properties: {
            groupMode: { type: 'string', enum: ['none'] },
            temporalMode: { type: 'string', enum: ['current'] },
          },
        },
        {
          type: 'object',
          required: ['groupMode', 'groupIds', 'temporalMode'],
          additionalProperties: false,
          properties: {
            groupMode: { type: 'string', enum: ['any', 'all', 'primary'] },
            groupIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } },
            temporalMode: { type: 'string', enum: ['current'] },
          },
        },
      ],
    },
  },
} as const;

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

@ApiTags('Groups')
@ApiBearerAuth('bearerAuth')
@Controller('groups/reports/production-status-counts')
export class GroupProductionStatusCountsReportController {
  constructor(
    @Inject(GroupProductionStatusCountsReportService)
    private readonly reports: GroupProductionStatusCountsReportService,
    @Inject(GroupsRuntimeConfigService)
    private readonly runtimeConfig: GroupsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'groupMode', required: false, enum: ['any', 'all', 'primary', 'none'], schema: { default: 'any' } })
  @ApiQuery({
    name: 'groupIds',
    required: false,
    type: String,
    description: 'Comma-separated group UUIDs. Required unless groupMode is none.',
  })
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current'], schema: { default: 'current' } })
  @ApiResponse({
    status: 200,
    description: 'Group-filtered current production status counts',
    schema: swaggerSchema(groupProductionStatusCountsReportResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid report query' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({
    operationId: 'listGroupProductionStatusCounts',
    summary: 'List current production status counts filtered by group membership',
    description:
      'Returns only current orders.production_status_id aggregate counts and applied current group report filter metadata.',
  })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<GroupProductionStatusCountsReportResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().groupsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is disabled', {
        feature: 'groups',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.reports.listProductionStatusCounts({
      currentUser: request.user,
      query: parseGroupProductionStatusCountsReportQuery(query),
      requestId: request.requestId,
    });
  }
}
