import { Body, Controller, Inject, Param, Put, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ProductionActionService } from '../application/production-action.service';
import type { ProductionActionResponseDto } from '../dto/production-action.dto';
import {
  parseDetailStageEventRequest,
  parseOrderDetailId,
  parseProductionStatusId,
} from './production-actions.controller';
import { ProductionActionsRuntimeConfigService } from './production-actions-runtime-config.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const detailProductionStageEventRequestSwaggerSchema = {
  type: 'object',
  required: ['idempotencyKey'],
  properties: {
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
    note: { type: 'string', maxLength: 1000, nullable: true },
  },
} as const;

const productionActionResponseSwaggerSchema = {
  type: 'object',
  required: ['order', 'requestId'],
  properties: {
    order: {
      type: 'object',
      required: ['orderId', 'version'],
      properties: {
        orderId: { type: 'integer' },
        plannedCompletionDate: { type: 'string', format: 'date', nullable: true },
        orderStatusId: { type: 'integer' },
        paymentStatusId: { type: 'integer' },
        version: { type: 'integer' },
      },
    },
    event: {
      type: 'object',
      required: ['productionStatusId', 'active'],
      properties: {
        productionEventId: { type: 'integer' },
        productionStatusId: { type: 'integer' },
        active: { type: 'boolean' },
      },
    },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

@ApiTags('Production Actions')
@ApiBearerAuth()
@Controller('order-details/:detailId')
export class OrderDetailProductionActionsController {
  constructor(
    @Inject(ProductionActionService)
    private readonly productionActions: ProductionActionService,
    @Inject(ProductionActionsRuntimeConfigService)
    private readonly runtimeConfig: ProductionActionsRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'detailId', type: Number, description: 'Order detail ID' })
  @ApiParam({ name: 'productionStatusId', type: Number, description: 'Production status ID' })
  @ApiBody({ schema: swaggerSchema(detailProductionStageEventRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Activated detail production stage', schema: swaggerSchema(productionActionResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid detail or production status ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order detail not found' })
  @ApiResponse({ status: 409, description: 'Idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid or missing production status or production action payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'activateDetailProductionStage', summary: 'Activate a production stage for an order detail' })
  @Put('production-stage-events/:productionStatusId')
  async activateDetailProductionStage(
    @Req() request: RequestWithCurrentUser,
    @Param('detailId') detailIdParam: string,
    @Param('productionStatusId') productionStatusIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.activateDetailProductionStage({
      currentUser: this.requireCurrentUser(request),
      detailId: parseOrderDetailId(detailIdParam),
      productionStatusId: parseProductionStatusId(productionStatusIdParam),
      dto: parseDetailStageEventRequest(body),
      requestId: request.requestId,
    });
  }

  private assertProductionActionsEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().productionActionsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Production actions API is disabled', {
        feature: 'productionActions',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }
}
