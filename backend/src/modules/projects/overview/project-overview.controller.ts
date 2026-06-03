import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { parseProjectId } from '../projects.controller';
import { ProjectsRuntimeConfigService } from '../projects-runtime-config.service';
import {
  parseProjectOverviewQuery,
  PROJECT_OVERVIEW_OMITTED,
  type ProjectOverviewResponseDto,
} from './project-overview.dto';
import { ProjectOverviewService } from './project-overview.service';

const projectStatuses = ['draft', 'active', 'paused', 'completed', 'archived'] as const;
const relationTypes = ['main', 'secondary', 'reporting', 'billing', 'derived'] as const;

const projectOverviewFilterSwaggerSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['projectId', 'temporalMode'],
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', format: 'uuid' },
        temporalMode: { type: 'string', enum: ['current'] },
        createdFrom: { type: 'string', format: 'date-time' },
        createdTo: { type: 'string', format: 'date-time' },
      },
    },
    {
      type: 'object',
      required: ['projectId', 'temporalMode', 'asOf'],
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', format: 'uuid' },
        temporalMode: { type: 'string', enum: ['asOf'] },
        asOf: { type: 'string', format: 'date-time' },
        createdFrom: { type: 'string', format: 'date-time' },
        createdTo: { type: 'string', format: 'date-time' },
      },
    },
    {
      type: 'object',
      required: ['projectId', 'temporalMode', 'from', 'to'],
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', format: 'uuid' },
        temporalMode: { type: 'string', enum: ['overlap'] },
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
        createdFrom: { type: 'string', format: 'date-time' },
        createdTo: { type: 'string', format: 'date-time' },
      },
    },
  ],
} as const;

const projectOverviewResponseSwaggerSchema = {
  type: 'object',
  required: ['project', 'orders', 'filter', 'omitted'],
  additionalProperties: false,
  properties: {
    project: {
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
        status: { type: 'string', enum: projectStatuses },
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
    filter: projectOverviewFilterSwaggerSchema,
    omitted: {
      type: 'array',
      items: { type: 'string', enum: PROJECT_OVERVIEW_OMITTED },
    },
  },
} as const;

const dateTimeQuerySwaggerSchema = { type: 'string', format: 'date-time' } as const;
const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

@ApiTags('Projects')
@ApiBearerAuth('bearerAuth')
@Controller('projects/:projectId/overview')
export class ProjectOverviewController {
  constructor(
    @Inject(ProjectOverviewService)
    private readonly overviews: ProjectOverviewService,
    @Inject(ProjectsRuntimeConfigService)
    private readonly runtimeConfig: ProjectsRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'projectId', type: String, description: 'Project UUID' })
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current', 'asOf', 'overlap'], schema: { default: 'current' } })
  @ApiQuery({ name: 'asOf', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'from', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'to', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'createdFrom', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'createdTo', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiResponse({
    status: 200,
    description: 'Project overview',
    schema: swaggerSchema(projectOverviewResponseSwaggerSchema),
  })
  @ApiResponse({ status: 400, description: 'Invalid project id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 422, description: 'Invalid overview query' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({
    operationId: 'getProjectOverview',
    summary: 'Get project overview',
    description: 'Returns only project summary fields and aggregate order counts for one project.',
  })
  @Get()
  async getOverview(
    @Req() request: RequestWithCurrentUser,
    @Param('projectId') projectIdParam: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ProjectOverviewResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().projectsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is disabled', {
        feature: 'projects',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.overviews.getOverview({
      currentUser: request.user,
      projectId: parseProjectId(projectIdParam),
      query: parseProjectOverviewQuery(query),
      requestId: request.requestId,
    });
  }
}
