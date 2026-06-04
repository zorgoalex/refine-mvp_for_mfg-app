import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ProjectsRuntimeConfigService } from '../projects-runtime-config.service';
import {
  parseProjectProductionStatusCountsReportQuery,
  type ProjectProductionStatusCountsReportResponseDto,
} from './project-production-status-counts-report.dto';
import { ProjectProductionStatusCountsReportService } from './project-production-status-counts-report.service';

const projectProductionStatusCountsReportResponseSwaggerSchema = {
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
            projectMode: { type: 'string', enum: ['any', 'all', 'primary'] },
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
@Controller('projects/reports/production-status-counts')
export class ProjectProductionStatusCountsReportController {
  constructor(
    @Inject(ProjectProductionStatusCountsReportService)
    private readonly reports: ProjectProductionStatusCountsReportService,
    @Inject(ProjectsRuntimeConfigService)
    private readonly runtimeConfig: ProjectsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'projectMode', required: false, enum: ['any', 'all', 'primary', 'none'], schema: { default: 'any' } })
  @ApiQuery({
    name: 'projectIds',
    required: false,
    type: String,
    description: 'Comma-separated project UUIDs. Required unless projectMode is none.',
  })
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current'], schema: { default: 'current' } })
  @ApiResponse({
    status: 200,
    description: 'Project-filtered current production status counts',
    schema: swaggerSchema(projectProductionStatusCountsReportResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid report query' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({
    operationId: 'listProjectProductionStatusCounts',
    summary: 'List current production status counts filtered by project membership',
    description:
      'Returns only current orders.production_status_id aggregate counts and applied current project report filter metadata.',
  })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ProjectProductionStatusCountsReportResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().projectsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is disabled', {
        feature: 'projects',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.reports.listProductionStatusCounts({
      currentUser: request.user,
      query: parseProjectProductionStatusCountsReportQuery(query),
      requestId: request.requestId,
    });
  }
}
