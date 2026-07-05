import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DEADLINE_STATUSES } from '../../deadlines/domain/deadline-status';
import { GroupsRuntimeConfigService } from '../groups-runtime-config.service';
import {
  parseGroupDeadlineStatusCountsReportQuery,
  type GroupDeadlineStatusCountsReportResponseDto,
} from './group-deadline-status-counts-report.dto';
import { GroupDeadlineStatusCountsReportService } from './group-deadline-status-counts-report.service';

const groupDeadlineStatusCountsReportResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'filter'],
  additionalProperties: false,
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        required: ['deadlineStatus', 'deadlineCount'],
        additionalProperties: false,
        properties: {
          deadlineStatus: { type: 'string', enum: DEADLINE_STATUSES },
          deadlineCount: { type: 'integer', minimum: 0 },
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
            groupMode: { type: 'string', enum: ['any', 'all'] },
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
@Controller('groups/reports/deadline-status-counts')
export class GroupDeadlineStatusCountsReportController {
  constructor(
    @Inject(GroupDeadlineStatusCountsReportService)
    private readonly reports: GroupDeadlineStatusCountsReportService,
    @Inject(GroupsRuntimeConfigService)
    private readonly runtimeConfig: GroupsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'groupMode', required: false, enum: ['any', 'all', 'none'], schema: { default: 'any' } })
  @ApiQuery({
    name: 'groupIds',
    required: false,
    type: String,
    description: 'Comma-separated group UUIDs. Required unless groupMode is none.',
  })
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current'], schema: { default: 'current' } })
  @ApiResponse({
    status: 200,
    description: 'Group-filtered current deadline status counts',
    schema: swaggerSchema(groupDeadlineStatusCountsReportResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid report query' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({
    operationId: 'listGroupDeadlineStatusCounts',
    summary: 'List current deadline status counts filtered by effective group attribution',
    description:
      'Returns only current deadline_instances.status aggregate counts and the applied current group report filter.',
  })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<GroupDeadlineStatusCountsReportResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().groupsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is disabled', {
        feature: 'groups',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.reports.listDeadlineStatusCounts({
      currentUser: request.user,
      query: parseGroupDeadlineStatusCountsReportQuery(query),
      requestId: request.requestId,
    });
  }
}
