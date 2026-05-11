import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { OrderQueryService } from '../application/order-query.service';
import {
  ORDER_LIST_SORT_FIELDS,
  type OrderListQuery,
  type OrderListSortBy,
  type SortOrder,
} from '../application/order-query.types';
import { OrderTransactionService } from '../application/order-transaction.service';
import type { OrderDto, OrderListResponseDto, OrderResponseDto } from '../dto/order.dto';
import type { OrderFormDataResponseDto } from '../dto/order-form-data.dto';
import type { SaveOrderDto } from '../dto/save-order.dto';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

export interface SaveOrderResponseDto {
  order: OrderDto;
}

@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(OrderTransactionService)
    private readonly orders: OrderTransactionService,
    @Inject(OrderQueryService)
    private readonly orderQueries: OrderQueryService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<OrderListResponseDto> {
    this.assertOrdersReadEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.orderQueries.list({ currentUser, query: parseOrderListQuery(query) });
  }

  @Get('form-data')
  async getFormData(@Req() request: RequestWithCurrentUser): Promise<OrderFormDataResponseDto> {
    this.assertOrdersReadEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.orderQueries.getFormData({ currentUser });
  }

  @Get(':orderId')
  async getById(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
  ): Promise<OrderResponseDto> {
    this.assertOrdersReadEnabled();

    const currentUser = this.requireCurrentUser(request);
    const orderId = parseOrderId(orderIdParam);
    const order = await this.orderQueries.getById({ currentUser, orderId });

    return { order };
  }

  @Post()
  async create(
    @Req() request: RequestWithCurrentUser,
    @Body() dto: SaveOrderDto,
  ): Promise<SaveOrderResponseDto> {
    this.assertOrdersWriteEnabled();

    const currentUser = this.requireCurrentUser(request);
    const order = await this.orders.create({ currentUser, dto });

    return { order };
  }

  @Put(':orderId')
  @HttpCode(200)
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() dto: SaveOrderDto,
  ): Promise<SaveOrderResponseDto> {
    this.assertOrdersWriteEnabled();

    const currentUser = this.requireCurrentUser(request);
    const orderId = parseOrderId(orderIdParam);
    const order = await this.orders.update({ currentUser, orderId, dto });

    return { order };
  }

  private assertOrdersWriteEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();

    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
      });
    }

    if (flags.ordersReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders write API is disabled', {
        feature: 'orders',
        mode: 'read_only',
      });
    }
  }

  private assertOrdersReadEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();

    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
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

export function parseOrderListQuery(
  query: Record<string, string | string[] | undefined>,
): OrderListQuery {
  return {
    page: parsePositiveInteger(query.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInteger(query.pageSize, 'pageSize', 25, 1, 200),
    sortBy: parseSortBy(query.sortBy),
    sortOrder: parseSortOrder(query.sortOrder),
    search: parseSearch(query.search),
    clientId: parseOptionalPositiveInteger(query.clientId, 'clientId'),
    orderStatusId: parseOptionalPositiveInteger(query.orderStatusId, 'orderStatusId'),
    paymentStatusId: parseOptionalPositiveInteger(query.paymentStatusId, 'paymentStatusId'),
    productionStatusId: parseOptionalPositiveInteger(
      query.productionStatusId,
      'productionStatusId',
    ),
    dateFrom: parseOptionalDateOnly(query.dateFrom, 'dateFrom'),
    dateTo: parseOptionalDateOnly(query.dateTo, 'dateTo'),
    onlyMyOrders: parseBoolean(query.onlyMyOrders, false),
  };
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

function parseSortBy(value: string | string[] | undefined): OrderListSortBy {
  const sortBy = singleValue(value) ?? 'updatedAt';

  if (!ORDER_LIST_SORT_FIELDS.includes(sortBy as OrderListSortBy)) {
    throw validationError('sortBy', 'Unsupported sort field', {
      allowedValues: [...ORDER_LIST_SORT_FIELDS],
    });
  }

  return sortBy as OrderListSortBy;
}

function parseSortOrder(value: string | string[] | undefined): SortOrder {
  const sortOrder = singleValue(value) ?? 'desc';

  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw validationError('sortOrder', 'sortOrder must be asc or desc');
  }

  return sortOrder;
}

function parseSearch(value: string | string[] | undefined): string | undefined {
  const search = singleValue(value)?.trim();
  if (!search) return undefined;

  if (search.length > 200) {
    throw validationError('search', 'search must be 200 characters or fewer');
  }

  return search;
}

function parseOptionalPositiveInteger(
  value: string | string[] | undefined,
  field: string,
): number | undefined {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') return undefined;

  return parsePositiveInteger(raw, field, undefined, 1, Number.MAX_SAFE_INTEGER);
}

function parsePositiveInteger(
  value: string | string[] | undefined,
  field: string,
  fallback: number | undefined,
  min: number,
  max: number,
): number {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      throw validationError(field, `${field} is required`);
    }
    return fallback;
  }

  const numberValue = Number(raw);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw validationError(field, `${field} must be an integer between ${min} and ${max}`);
  }

  return numberValue;
}

function parseOptionalDateOnly(
  value: string | string[] | undefined,
  field: string,
): string | undefined {
  const raw = singleValue(value);
  if (!raw) return undefined;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw validationError(field, `${field} must use YYYY-MM-DD format`);
  }

  return raw;
}

function parseBoolean(value: string | string[] | undefined, fallback: boolean): boolean {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') return fallback;

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  throw validationError('onlyMyOrders', 'onlyMyOrders must be true or false');
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validationError(
  field: string,
  message: string,
  extraDetails: Record<string, unknown> = {},
): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Order query validation failed', {
    errors: [{ field, message }],
    ...extraDetails,
  });
}
