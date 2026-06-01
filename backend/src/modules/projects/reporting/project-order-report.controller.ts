import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ProjectsRuntimeConfigService } from '../projects-runtime-config.service';
import { parseProjectOrderReportQuery, type ProjectOrderReportResponseDto } from './project-order-report.dto';
import { ProjectOrderReportService } from './project-order-report.service';

const projectOrderReportResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'pagination', 'filter'],
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        required: ['orderId'],
        properties: {
          orderId: { type: 'integer' },
        },
      },
    },
    pagination: {
      type: 'object',
      required: ['page', 'pageSize', 'total', 'totalPages'],
      properties: {
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        total: { type: 'integer' },
        totalPages: { type: 'integer' },
      },
    },
    filter: { type: 'object', additionalProperties: true },
  },
} as const;

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

@ApiTags('Projects')
@ApiBearerAuth()
@Controller('projects/reports/orders')
export class ProjectOrderReportController {
  constructor(
    @Inject(ProjectOrderReportService)
    private readonly reports: ProjectOrderReportService,
    @Inject(ProjectsRuntimeConfigService)
    private readonly runtimeConfig: ProjectsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'projectMode', required: false, enum: ['any', 'all', 'primary', 'none'] })
  @ApiQuery({ name: 'projectIds', required: false, type: String })
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current', 'asOf', 'overlap'] })
  @ApiQuery({ name: 'asOf', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Project-filtered order report ids',
    schema: swaggerSchema(projectOrderReportResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid report query' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({ operationId: 'listProjectOrderReportIds', summary: 'List order ids filtered by project membership' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ProjectOrderReportResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().projectsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is disabled', {
        feature: 'projects',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.reports.listOrderIds({
      currentUser: request.user,
      query: parseProjectOrderReportQuery(query),
      requestId: request.requestId,
    });
  }
}
