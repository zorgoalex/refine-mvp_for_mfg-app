import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ProjectsRuntimeConfigService } from '../projects-runtime-config.service';
import {
  parseProjectOrderRelationCountsReportQuery,
  type ProjectOrderRelationCountsReportResponseDto,
} from './project-order-relation-counts-report.dto';
import { ProjectOrderRelationCountsReportService } from './project-order-relation-counts-report.service';

const projectOrderRelationCountsReportResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'filter'],
  additionalProperties: false,
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        required: ['relationType', 'isPrimary', 'orderCount'],
        additionalProperties: false,
        properties: {
          relationType: { type: 'string', enum: ['main', 'secondary', 'reporting', 'billing', 'derived'] },
          isPrimary: { type: 'boolean' },
          orderCount: { type: 'integer', minimum: 0 },
        },
      },
    },
    filter: {
      oneOf: [
        {
          type: 'object',
          required: ['projectMode', 'temporalMode'],
          properties: {
            projectMode: { type: 'string', enum: ['none'] },
            temporalMode: { type: 'string', enum: ['current'] },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['projectMode', 'projectIds', 'temporalMode'],
          properties: {
            projectMode: { type: 'string', enum: ['any', 'all', 'primary'] },
            projectIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } },
            temporalMode: { type: 'string', enum: ['current'] },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['projectMode', 'temporalMode', 'asOf'],
          properties: {
            projectMode: { type: 'string', enum: ['none'] },
            temporalMode: { type: 'string', enum: ['asOf'] },
            asOf: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['projectMode', 'projectIds', 'temporalMode', 'asOf'],
          properties: {
            projectMode: { type: 'string', enum: ['any', 'all', 'primary'] },
            projectIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } },
            temporalMode: { type: 'string', enum: ['asOf'] },
            asOf: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['projectMode', 'temporalMode', 'from', 'to'],
          properties: {
            projectMode: { type: 'string', enum: ['none'] },
            temporalMode: { type: 'string', enum: ['overlap'] },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['projectMode', 'projectIds', 'temporalMode', 'from', 'to'],
          properties: {
            projectMode: { type: 'string', enum: ['any', 'all', 'primary'] },
            projectIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } },
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

@ApiTags('Projects')
@ApiBearerAuth('bearerAuth')
@Controller('projects/reports/order-relation-counts')
export class ProjectOrderRelationCountsReportController {
  constructor(
    @Inject(ProjectOrderRelationCountsReportService)
    private readonly reports: ProjectOrderRelationCountsReportService,
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
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current', 'asOf', 'overlap'], schema: { default: 'current' } })
  @ApiQuery({ name: 'asOf', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'from', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'to', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiResponse({
    status: 200,
    description: 'Project-filtered order relation counts',
    schema: swaggerSchema(projectOrderRelationCountsReportResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid report query' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({
    operationId: 'listProjectOrderRelationCounts',
    summary: 'List project order relation counts filtered by project membership',
    description: 'Returns only project-order relation aggregate counts and applied project report filter metadata.',
  })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ProjectOrderRelationCountsReportResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().projectsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is disabled', {
        feature: 'projects',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.reports.listOrderRelationCounts({
      currentUser: request.user,
      query: parseProjectOrderRelationCountsReportQuery(query),
      requestId: request.requestId,
    });
  }
}
