import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { OrderResourceDemandService } from '../application/order-resource-demand.service';
import type {
  OrderResourceDemandQuery,
  OrderResourceDemandResponseDto,
} from '../application/order-resource-demand.types';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders/resource-demands')
export class OrderResourceDemandController {
  constructor(
    @Inject(OrderResourceDemandService)
    private readonly demands: OrderResourceDemandService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Order date from, YYYY-MM-DD' })
  @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'Order date to, YYYY-MM-DD' })
  @ApiQuery({ name: 'sheetMaterialTypeId', required: false, type: Number })
  @ApiQuery({ name: 'filmId', required: false, type: Number })
  @ApiQuery({ name: 'supplierId', required: false, type: Number })
  @ApiQuery({ name: 'vendorId', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Live order resource demand projection' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid resource demand query' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'listOrderResourceDemands', summary: 'List live resource demands by order' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<OrderResourceDemandResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
      });
    }
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.demands.list({
      currentUser: request.user,
      query: parseOrderResourceDemandQuery(rawQuery),
    });
  }
}

export function parseOrderResourceDemandQuery(raw: Record<string, unknown>): OrderResourceDemandQuery {
  const page = parsePositiveInteger(raw.page, 'page', 1, 10_000);
  const pageSize = parsePositiveInteger(raw.pageSize, 'pageSize', 20, 100);
  const search = single(raw.search, 'search')?.trim();
  if (search && search.length > 200) {
    throw invalidQuery('search', 'search must be 200 characters or fewer');
  }

  const dateFrom = parseDateOnly(raw.dateFrom, 'dateFrom');
  const dateTo = parseDateOnly(raw.dateTo, 'dateTo');
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw invalidQuery('dateFrom', 'dateFrom must not be after dateTo');
  }

  return {
    page,
    pageSize,
    ...(search ? { search } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...optionalId(raw.sheetMaterialTypeId, 'sheetMaterialTypeId'),
    ...optionalId(raw.filmId, 'filmId'),
    ...optionalId(raw.supplierId, 'supplierId'),
    ...optionalId(raw.vendorId, 'vendorId'),
  };
}

function optionalId(
  value: unknown,
  field: 'sheetMaterialTypeId' | 'filmId' | 'supplierId' | 'vendorId',
): Partial<OrderResourceDemandQuery> {
  const raw = single(value, field);
  if (raw === undefined || raw.trim() === '') return {};
  if (!/^\d+$/.test(raw)) throw invalidQuery(field, `${field} must be a positive integer`);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw invalidQuery(field, `${field} must be a positive integer`);
  }
  return { [field]: id };
}

function parsePositiveInteger(value: unknown, field: string, fallback: number, max: number): number {
  const raw = single(value, field);
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw)) throw invalidQuery(field, `${field} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw invalidQuery(field, `${field} must be between 1 and ${max}`);
  }
  return parsed;
}

function parseDateOnly(value: unknown, field: string): string | undefined {
  const raw = single(value, field);
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!isDateOnly(raw)) throw invalidQuery(field, `${field} must be YYYY-MM-DD`);
  return raw;
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function single(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) throw invalidQuery(field, `${field} must be provided once`);
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw invalidQuery(field, `${field} must be a string or number`);
  }
  return String(value);
}

function invalidQuery(field: string, reason: string): ApiError {
  return new ApiError(422, 'ORDER_RESOURCE_DEMAND_QUERY_INVALID', 'Некорректные параметры потребностей заказов', {
    field,
    reason,
  });
}
