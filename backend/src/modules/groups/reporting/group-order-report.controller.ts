import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { GroupsRuntimeConfigService } from '../groups-runtime-config.service';
import { parseGroupOrderReportQuery, type GroupOrderReportResponseDto } from './group-order-report.dto';
import { GroupOrderReportService } from './group-order-report.service';

const groupOrderReportResponseSwaggerSchema = {
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

@ApiTags('Groups')
@ApiBearerAuth()
@Controller('groups/reports/orders')
export class GroupOrderReportController {
  constructor(
    @Inject(GroupOrderReportService)
    private readonly reports: GroupOrderReportService,
    @Inject(GroupsRuntimeConfigService)
    private readonly runtimeConfig: GroupsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'groupMode', required: false, enum: ['any', 'all', 'primary', 'none'] })
  @ApiQuery({ name: 'groupIds', required: false, type: String })
  @ApiQuery({ name: 'temporalMode', required: false, enum: ['current', 'asOf', 'overlap'] })
  @ApiQuery({ name: 'asOf', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Group-filtered order report ids',
    schema: swaggerSchema(groupOrderReportResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid report query' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({ operationId: 'listGroupOrderReportIds', summary: 'List order ids filtered by group membership' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<GroupOrderReportResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().groupsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is disabled', {
        feature: 'groups',
      });
    }

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.reports.listOrderIds({
      currentUser: request.user,
      query: parseGroupOrderReportQuery(query),
      requestId: request.requestId,
    });
  }
}
