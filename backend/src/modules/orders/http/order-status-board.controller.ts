import { Controller, Get, Inject, Logger, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { OrderStatusBoardService } from '../application/order-status-board.service';
import type {
  OrderStatusBoardQuery,
  OrderStatusBoardSortBy,
  OrderStatusBoardSortOrder,
} from '../application/order-status-board.types';
import type { OrderStatusBoardResponseDto } from '../dto/order-status-board.dto';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders/status-board')
export class OrderStatusBoardController {
  private readonly logger = new Logger(OrderStatusBoardController.name);

  constructor(
    @Inject(OrderStatusBoardService)
    private readonly boards: OrderStatusBoardService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'board', required: true, enum: ['order', 'production'] })
  @ApiQuery({ name: 'column', required: false, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'onlyMyOrders', required: false, type: Boolean })
  @ApiQuery({ name: 'overdueOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'includeDone', required: false, type: Boolean })
  @ApiQuery({ name: 'plannedFrom', required: false, type: String })
  @ApiQuery({ name: 'plannedTo', required: false, type: String })
  @ApiQuery({ name: 'orderIds', required: false, type: String })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['priority', 'orderNumber', 'plannedDate', 'updatedAt'],
  })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiResponse({ status: 200, description: 'Order status board projection' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid board query or cursor' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'getOrderStatusBoard', summary: 'Get an order status board' })
  @Get()
  async getBoard(
    @Req() request: RequestWithCurrentUser,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<OrderStatusBoardResponseDto> {
    const startedAt = Date.now();
    let query: OrderStatusBoardQuery | null = null;
    try {
      if (!this.runtimeConfig.getFeatureFlags().ordersEnabled) {
        throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
          feature: 'orders',
        });
      }
      if (!request.user) {
        throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
      }

      query = parseOrderStatusBoardQuery(rawQuery);
      const response = await this.boards.get({ currentUser: request.user, query });
      this.logger.log({
        event: 'orders.status_board.read',
        board: query.board,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        requestKind: query.column ? 'column' : 'initial',
        durationMs: Date.now() - startedAt,
        returnedCardCount: response.columns.reduce(
          (count, column) => count + column.cards.length,
          0,
        ),
        columnCount: response.columns.length,
        requestId: request.requestId ?? null,
      });
      return response;
    } catch (error) {
      this.logger.error({
        event: 'orders.status_board.read',
        board: query?.board ?? rawBoardName(rawQuery.board),
        sortBy: query?.sortBy ?? null,
        sortOrder: query?.sortOrder ?? null,
        requestKind: query?.column || rawQuery.column ? 'column' : 'initial',
        durationMs: Date.now() - startedAt,
        errorCode: classifyOrderStatusBoardError(error),
        requestId: request.requestId ?? null,
      });
      throw error;
    }
  }
}

function rawBoardName(value: unknown): string {
  return typeof value === 'string' ? value : 'invalid';
}

export function classifyOrderStatusBoardError(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '57014'
  ) {
    return 'DATABASE_TIMEOUT';
  }
  return 'INTERNAL_ERROR';
}

export function parseOrderStatusBoardQuery(
  query: Record<string, unknown>,
): OrderStatusBoardQuery {
  const board = single(query.board, 'board');
  if (board !== 'order' && board !== 'production') {
    throw validationError('board', 'board must be order or production');
  }

  const columnRaw = single(query.column, 'column')?.trim();
  let column: string | undefined;
  if (columnRaw) {
    const numericColumn = Number(columnRaw);
    if (columnRaw === 'unassigned') {
      if (board !== 'production') {
        throw validationError('column', 'unassigned is only valid for production board');
      }
      column = columnRaw;
    } else if (
      /^\d+$/.test(columnRaw) &&
      Number.isSafeInteger(numericColumn) &&
      numericColumn > 0
    ) {
      column = String(numericColumn);
    } else {
      throw validationError('column', 'column must be unassigned or a positive status id');
    }
  }

  const cursor = single(query.cursor, 'cursor')?.trim();
  if (cursor && !column) {
    throw validationError('cursor', 'cursor requires column');
  }
  if (cursor && cursor.length > 2000) {
    throw validationError('cursor', 'cursor is too long');
  }

  const search = single(query.search, 'search')?.trim();
  if (search && search.length > 200) {
    throw validationError('search', 'search must be 200 characters or fewer');
  }
  const plannedFrom = parseDateOnly(query.plannedFrom, 'plannedFrom');
  const plannedTo = parseDateOnly(query.plannedTo, 'plannedTo');
  if (plannedFrom && plannedTo && plannedFrom > plannedTo) {
    throw validationError('plannedFrom', 'plannedFrom must not be after plannedTo');
  }

  const includeDone = parseBoolean(query.includeDone, 'includeDone', false);
  if (includeDone && board !== 'production') {
    throw validationError('includeDone', 'includeDone is only valid for production board');
  }
  const orderIds = parseOrderIds(query.orderIds);
  const sortBy = parseSortBy(query.sortBy);
  const sortOrder = parseSortOrder(query.sortOrder);

  return {
    board,
    ...(column ? { column } : {}),
    ...(cursor ? { cursor } : {}),
    limit: parseInteger(query.limit, 'limit', 24, 1, 60),
    ...(search ? { search } : {}),
    onlyMyOrders: parseBoolean(query.onlyMyOrders, 'onlyMyOrders', false),
    overdueOnly: parseBoolean(query.overdueOnly, 'overdueOnly', false),
    includeDone,
    ...(plannedFrom ? { plannedFrom } : {}),
    ...(plannedTo ? { plannedTo } : {}),
    ...(orderIds.length > 0 ? { orderIds } : {}),
    sortBy,
    sortOrder,
  };
}

function parseSortBy(value: unknown): OrderStatusBoardSortBy {
  const raw = single(value, 'sortBy');
  if (raw === undefined || raw === '') return 'priority';
  if (
    raw === 'priority'
    || raw === 'orderNumber'
    || raw === 'plannedDate'
    || raw === 'updatedAt'
  ) {
    return raw;
  }
  throw validationError('sortBy', 'sortBy is not supported');
}

function parseSortOrder(value: unknown): OrderStatusBoardSortOrder {
  const raw = single(value, 'sortOrder');
  if (raw === undefined || raw === '') return 'asc';
  if (raw === 'asc' || raw === 'desc') return raw;
  throw validationError('sortOrder', 'sortOrder must be asc or desc');
}

function parseInteger(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = single(value, field);
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw validationError(field, `${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  const raw = single(value, field);
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw validationError(field, `${field} must be true or false`);
}

function parseDateOnly(
  value: unknown,
  field: string,
): string | undefined {
  const raw = single(value, field)?.trim();
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw validationError(field, `${field} must use YYYY-MM-DD format`);
  }
  const timestamp = Date.parse(`${raw}T00:00:00.000Z`);
  if (
    raw.startsWith('0000-') ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== raw
  ) {
    throw validationError(field, `${field} must be a valid calendar date`);
  }
  return raw;
}

function parseOrderIds(value: unknown): number[] {
  if (value === undefined || value === '') return [];
  const rawValues = Array.isArray(value) ? value : [value];
  const ids = new Set<number>();
  for (const raw of rawValues) {
    if (typeof raw !== 'string') {
      throw validationError('orderIds', 'orderIds must contain positive integers');
    }
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const parsed = Number(trimmed);
      if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
        throw validationError('orderIds', 'orderIds must contain positive integers');
      }
      ids.add(parsed);
      if (ids.size > 200) {
        throw validationError('orderIds', 'orderIds must contain 200 values or fewer');
      }
    }
  }
  return Array.from(ids);
}

function single(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw validationError(field, `${field} must be a singular string`);
  }
  return value;
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { field });
}
