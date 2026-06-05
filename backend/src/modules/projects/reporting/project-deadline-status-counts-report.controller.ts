import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DEADLINE_STATUSES } from '../../deadlines/domain/deadline-status';
import { ProjectsRuntimeConfigService } from '../projects-runtime-config.service';
import {
  parseProjectDeadlineStatusCountsReportQuery,
  type ProjectDeadlineStatusCountsReportResponseDto,
} from './project-deadline-status-counts-report.dto';
import { ProjectDeadlineStatusCountsReportService } from './project-deadline-status-counts-report.service';

const projectDeadlineStatusCountsReportResponseSwaggerSchema = {
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
          required: ['projectMode', 'temporalMode'],
          additionalProperties: false,
          properties: {
            projectMode: { type: 'string', enum: ['none'] },
            temporalMode: { type: 'string', enum: ['current'] },
          },
        },
        {
          type: 'object',
          required: ['projectMode', 'projectIds', 'temporalMode'],
          additionalProperties: false,
          properties: {
            projectMode: { type: 'string', enum: ['any', 'all'] },
            projectIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } },
            temporalMode: { type: 'string', enum: ['current'] },
          },
        },
      ],
    },
  },
} as const;

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

@ApiTags('Projects')
@ApiBearerAuth('bearerAuth')
@Controller('projects/reports/deadline-status-counts')
export class ProjectDeadlineStatusCountsReportController {
  constructor(
    @Inject(ProjectDeadlineStatusCountsReportService)
    private readonly reports: ProjectDeadlineStatusCountsReportService,
    @Inject(ProjectsRuntimeConfigService)
    private readonly runtimeConfig: ProjectsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'projectMode', required: false, enum: ['any', 'all', 'none'], schema: { default: 'any' } })
  @ApiQuery({
    name: 'projectIds',
    required: false,
    type: String,
    description: 'Comma-separated project UUIDs. Required unless projectMode is none.',
  })
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current'], schema: { default: 'current' } })
  @ApiResponse({
    status: 200,
    description: 'Project-filtered current deadline status counts',
    schema: swaggerSchema(projectDeadlineStatusCountsReportResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid report query' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({
    operationId: 'listProjectDeadlineStatusCounts',
    summary: 'List current deadline status counts filtered by effective project attribution',
    description:
      'Returns only current deadline_instances.status aggregate counts and the applied current project report filter.',
  })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ProjectDeadlineStatusCountsReportResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().projectsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is disabled', {
        feature: 'projects',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.reports.listDeadlineStatusCounts({
      currentUser: request.user,
      query: parseProjectDeadlineStatusCountsReportQuery(query),
      requestId: request.requestId,
    });
  }
}
