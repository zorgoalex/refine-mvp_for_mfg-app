import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ProjectsRuntimeConfigService } from '../projects-runtime-config.service';
import {
  parseProjectOrderStatusReportQuery,
  type ProjectOrderStatusReportResponseDto,
} from './project-order-status-report.dto';
import { ProjectOrderStatusReportService } from './project-order-status-report.service';

const projectOrderStatusReportResponseSwaggerSchema = {
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
@ApiBearerAuth()
@Controller('projects/reports/order-status-counts')
export class ProjectOrderStatusReportController {
  constructor(
    @Inject(ProjectOrderStatusReportService)
    private readonly reports: ProjectOrderStatusReportService,
    @Inject(ProjectsRuntimeConfigService)
    private readonly runtimeConfig: ProjectsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'projectMode', required: false, enum: ['any', 'all', 'primary', 'none'] })
  @ApiQuery({ name: 'projectIds', required: false, type: String })
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current', 'asOf', 'overlap'] })
  @ApiQuery({ name: 'asOf', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'from', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiQuery({ name: 'to', required: false, schema: swaggerSchema(dateTimeQuerySwaggerSchema) })
  @ApiResponse({
    status: 200,
    description: 'Project-filtered order status counts',
    schema: swaggerSchema(projectOrderStatusReportResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid report query' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({
    operationId: 'listProjectOrderStatusCounts',
    summary: 'List order status counts filtered by project membership',
  })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ProjectOrderStatusReportResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().projectsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is disabled', {
        feature: 'projects',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.reports.listOrderStatusCounts({
      currentUser: request.user,
      query: parseProjectOrderStatusReportQuery(query),
      requestId: request.requestId,
    });
  }
}
