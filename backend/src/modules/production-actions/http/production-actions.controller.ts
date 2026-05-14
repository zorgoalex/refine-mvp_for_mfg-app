import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ProductionActionService } from '../application/production-action.service';
import type {
  ChangeOrderStatusRequestDto,
  MoveCalendarDateRequestDto,
  ProductionActionResponseDto,
  ProductionStageEventRequestDto,
} from '../dto/production-action.dto';
import { ProductionActionsRuntimeConfigService } from './production-actions-runtime-config.service';

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'plannedCompletionDate must be YYYY-MM-DD');
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const versionSchema = z.number().int().nonnegative();

const calendarDateRequestSchema = z.object({
  plannedCompletionDate: dateOnlySchema.nullable(),
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

const orderStatusRequestSchema = z.object({
  orderStatusId: z.number().int().positive(),
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

const stageEventRequestSchema = z.object({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

@Controller('orders/:orderId')
export class ProductionActionsController {
  constructor(
    @Inject(ProductionActionService)
    private readonly productionActions: ProductionActionService,
    @Inject(ProductionActionsRuntimeConfigService)
    private readonly runtimeConfig: ProductionActionsRuntimeConfigService,
  ) {}

  @Patch('calendar-date')
  async moveCalendarDate(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.moveCalendarDate({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parseCalendarDateRequest(body),
      requestId: request.requestId,
    });
  }

  @Patch('status')
  async changeOrderStatus(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    return this.executeChangeOrderStatus(request, orderIdParam, body);
  }

  @Patch('order-status')
  async changeOrderStatusLegacy(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    return this.executeChangeOrderStatus(request, orderIdParam, body);
  }

  @Put('production-stage-events/:productionStatusId')
  async activateProductionStage(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Param('productionStatusId') productionStatusIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.activateProductionStage({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      productionStatusId: parseProductionStatusId(productionStatusIdParam),
      dto: parseStageEventRequest(body),
      requestId: request.requestId,
    });
  }

  @Delete('production-stage-events/:productionStatusId')
  @HttpCode(200)
  async deactivateProductionStage(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Param('productionStatusId') productionStatusIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.deactivateProductionStage({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      productionStatusId: parseProductionStatusId(productionStatusIdParam),
      dto: parseStageEventRequest(body),
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

  private executeChangeOrderStatus(
    request: RequestWithCurrentUser,
    orderIdParam: string,
    body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.changeOrderStatus({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parseOrderStatusRequest(body),
      requestId: request.requestId,
    });
  }
}

export function parseOrderId(value: string): number {
  const orderId = Number(value);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid order id', {
      field: 'orderId',
    });
  }

  return orderId;
}

export function parseProductionStatusId(value: string): number {
  const productionStatusId = Number(value);

  if (!Number.isInteger(productionStatusId) || productionStatusId <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid production status id', {
      field: 'productionStatusId',
    });
  }

  return productionStatusId;
}

export function parseCalendarDateRequest(body: unknown): MoveCalendarDateRequestDto {
  const parsed = calendarDateRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseOrderStatusRequest(body: unknown): ChangeOrderStatusRequestDto {
  const parsed = orderStatusRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseStageEventRequest(body: unknown): ProductionStageEventRequestDto {
  const parsed = stageEventRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

function productionActionValidationError(error: z.ZodError): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Production action payload validation failed', {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  });
}
