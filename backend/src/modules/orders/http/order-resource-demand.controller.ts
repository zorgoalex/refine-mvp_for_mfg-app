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
import {
  RESOURCE_HEADER_FILTER_VALUES_LIMIT,
  RESOURCE_SUPPLIER_NONE_KEY,
  type OrderResourceFilterOptionsResponseDto,
  type OrderResourceOnecDocumentOptionsResponseDto,
  type OrderResourceByMaterialResponseDto,
  type OrderResourceDemandQuery,
  type OrderResourceDemandResponseDto,
  type OrderResourceReadOptions,
  type ResourceDemandValueFilter,
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
  @ApiQuery({ name: 'unpurchasedOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'onecDocumentId', required: false, type: Number })
  @ApiQuery({ name: 'orderIds', required: false, type: String, description: 'Comma-separated order ids' })
  @ApiQuery({ name: 'orderDates', required: false, type: String, description: 'Comma-separated YYYY-MM-DD; "none" — orders without a date' })
  @ApiQuery({ name: 'sheetMaterialTypeIds', required: false, type: String, description: 'Comma-separated ids; "none" — orders without sheet materials' })
  @ApiQuery({ name: 'filmIds', required: false, type: String, description: 'Comma-separated ids; "none" — orders without film' })
  @ApiQuery({ name: 'supplierKeys', required: false, type: String, description: 'Comma-separated main supplier keys (s:<id>, c:<1C key>, n:<hash>, none); only their materials are returned; a leading "!" means "all except"' })
  @ApiQuery({ name: 'readyCutsOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'payment', required: false, enum: ['any_paid', 'fully_paid'] })
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
    const user = this.requireReadable(request);
    return this.demands.list({
      currentUser: user,
      query: parseOrderResourceDemandQuery(rawQuery),
    }, this.readOptions(user));
  }

  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Order date from, YYYY-MM-DD' })
  @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'Order date to, YYYY-MM-DD' })
  @ApiQuery({ name: 'unpurchasedOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'onecDocumentId', required: false, type: Number })
  @ApiQuery({ name: 'orderIds', required: false, type: String, description: 'Comma-separated order ids' })
  @ApiQuery({ name: 'orderDates', required: false, type: String, description: 'Comma-separated YYYY-MM-DD; "none" — orders without a date' })
  @ApiQuery({ name: 'sheetMaterialTypeIds', required: false, type: String, description: 'Comma-separated ids; "none" — orders without sheet materials' })
  @ApiQuery({ name: 'filmIds', required: false, type: String, description: 'Comma-separated ids; "none" — orders without film' })
  @ApiQuery({ name: 'supplierKeys', required: false, type: String, description: 'Comma-separated main supplier keys (s:<id>, c:<1C key>, n:<hash>, none); only their materials are returned; a leading "!" means "all except"' })
  @ApiQuery({ name: 'readyCutsOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'payment', required: false, enum: ['any_paid', 'fully_paid'] })
  @ApiResponse({ status: 200, description: 'Resource demand aggregated by material across filtered orders' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid query or too many orders' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'listOrderResourceDemandsByMaterial', summary: 'Aggregate live resource demand by material' })
  @Get('by-material')
  async byMaterial(
    @Req() request: RequestWithCurrentUser,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<OrderResourceByMaterialResponseDto> {
    const user = this.requireReadable(request);
    return this.demands.listByMaterial({
      currentUser: user,
      query: parseOrderResourceDemandQuery(rawQuery),
    }, this.readOptions(user));
  }

  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Order date from, YYYY-MM-DD' })
  @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'Order date to, YYYY-MM-DD' })
  @ApiQuery({ name: 'unpurchasedOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'orderIds', required: false, type: String, description: 'Comma-separated order ids' })
  @ApiQuery({ name: 'orderDates', required: false, type: String, description: 'Comma-separated YYYY-MM-DD; "none" — orders without a date' })
  @ApiQuery({ name: 'sheetMaterialTypeIds', required: false, type: String, description: 'Comma-separated ids; "none" — orders without sheet materials' })
  @ApiQuery({ name: 'filmIds', required: false, type: String, description: 'Comma-separated ids; "none" — orders without film' })
  @ApiQuery({ name: 'supplierKeys', required: false, type: String, description: 'Comma-separated main supplier keys (s:<id>, c:<1C key>, n:<hash>, none); only their materials are returned; a leading "!" means "all except"' })
  @ApiQuery({ name: 'readyCutsOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'payment', required: false, enum: ['any_paid', 'fully_paid'] })
  @ApiResponse({ status: 200, description: '1C documents allocated to the orders of the current selection' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid query' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'listOrderResourceOnecDocumentOptions', summary: 'Filter options: 1C documents of the listed orders' })
  @Get('onec-documents')
  async onecDocumentOptions(
    @Req() request: RequestWithCurrentUser,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<OrderResourceOnecDocumentOptionsResponseDto> {
    const user = this.requireReadable(request);
    return this.demands.listOnecDocumentOptions({
      currentUser: user,
      query: parseOrderResourceDemandQuery(rawQuery),
    }, this.readOptions(user));
  }

  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Order date from, YYYY-MM-DD' })
  @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'Order date to, YYYY-MM-DD' })
  @ApiQuery({ name: 'unpurchasedOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'onecDocumentId', required: false, type: Number })
  @ApiQuery({ name: 'readyCutsOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'payment', required: false, enum: ['any_paid', 'fully_paid'] })
  @ApiResponse({ status: 200, description: 'Header filter values over the whole current selection (header filters themselves ignored)' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid query' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'listOrderResourceDemandFilterOptions', summary: 'Header filter values of the resource demand list' })
  @Get('filter-options')
  async filterOptions(
    @Req() request: RequestWithCurrentUser,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<OrderResourceFilterOptionsResponseDto> {
    const user = this.requireReadable(request);
    return this.demands.listFilterOptions({
      currentUser: user,
      query: parseOrderResourceDemandQuery(rawQuery),
    }, this.readOptions(user));
  }

  private requireReadable(request: RequestWithCurrentUser) {
    if (!this.runtimeConfig.getFeatureFlags().ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
      });
    }
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    return request.user;
  }

  private readOptions(user: { permissions: readonly string[] }): OrderResourceReadOptions {
    const flags = this.runtimeConfig.getFeatureFlags();
    return {
      procurementEnabled: flags.resourceProcurementEnabled === true,
      canSeeAmounts: user.permissions.includes('finance.view'),
      supplyWorkspaceEnabled: flags.procurementWorkspaceEnabled === true,
    };
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
    ...optionalBoolean(raw.unpurchasedOnly, 'unpurchasedOnly'),
    ...optionalId(raw.onecDocumentId, 'onecDocumentId'),
    ...optionalIdList(raw.orderIds, 'orderIds'),
    ...optionalValueFilter(raw.orderDates, 'orderDates', (item) => (isDateOnly(item) ? item : null)),
    ...optionalValueFilter(raw.sheetMaterialTypeIds, 'sheetMaterialTypeIds', parseIdToken),
    ...optionalValueFilter(raw.filmIds, 'filmIds', parseIdToken),
    ...optionalSupplierKeys(raw.supplierKeys),
    ...optionalBoolean(raw.readyCutsOnly, 'readyCutsOnly'),
    ...optionalPayment(raw.payment),
  };
}

/** Ключ основного поставщика: `s:<id>`, `c:<ключ контрагента 1С>`, `n:<md5 имени>` или `none`. */
const SUPPLIER_KEY_PATTERN = /^(?:none|s:[1-9][0-9]{0,17}|[cn]:[A-Za-z0-9-]{1,64})$/;

/** Список значений через запятую; ведущий `!` — «все, кроме» (дополнение длинного выбора). */
function listTokens(value: unknown, field: string, allowExclude = false): { tokens: string[]; exclude: boolean } | undefined {
  const raw = single(value, field);
  if (raw === undefined || raw.trim() === '') return undefined;
  const exclude = allowExclude && raw.trim().startsWith('!');
  const body = exclude ? raw.trim().slice(1) : raw;
  if (exclude && body.trim() === '') return { tokens: [], exclude };
  const tokens = [...new Set(body.split(',').map((token) => token.trim()))];
  if (tokens.some((token) => token === '')) throw invalidQuery(field, `${field} must not contain empty values`);
  if (tokens.length > RESOURCE_HEADER_FILTER_VALUES_LIMIT) {
    throw invalidQuery(field, `${field} must contain at most ${RESOURCE_HEADER_FILTER_VALUES_LIMIT} values`);
  }
  return { tokens, exclude };
}

function parseIdToken(token: string): number | null {
  if (!/^\d+$/.test(token)) return null;
  const id = Number(token);
  return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

function optionalIdList(value: unknown, field: 'orderIds'): Partial<OrderResourceDemandQuery> {
  const list = listTokens(value, field);
  if (!list) return {};
  const ids = list.tokens.map(parseIdToken);
  if (ids.some((id) => id === null)) throw invalidQuery(field, `${field} must be positive integers`);
  return { [field]: ids as number[] };
}

/** Список значений фильтра заголовка; `none` — заказы без значения. */
function optionalValueFilter<T>(
  value: unknown,
  field: 'orderDates' | 'sheetMaterialTypeIds' | 'filmIds',
  parse: (token: string) => T | null,
): Partial<OrderResourceDemandQuery> {
  const list = listTokens(value, field, true);
  if (!list) return {};
  const values: T[] = [];
  let listsEmpty = false;
  for (const token of list.tokens) {
    if (token === RESOURCE_SUPPLIER_NONE_KEY) {
      listsEmpty = true;
      continue;
    }
    const parsed = parse(token);
    if (parsed === null) throw invalidQuery(field, `${field} contains an invalid value`);
    values.push(parsed);
  }
  // «Все, кроме»: `none` в списке исключает заказы без значения.
  const filter: ResourceDemandValueFilter<T> = list.exclude
    ? { values, includeEmpty: !listsEmpty, exclude: true }
    : { values, includeEmpty: listsEmpty };
  return { [field]: filter };
}

function optionalSupplierKeys(value: unknown): Partial<OrderResourceDemandQuery> {
  const list = listTokens(value, 'supplierKeys', true);
  if (!list) return {};
  if (list.tokens.some((token) => !SUPPLIER_KEY_PATTERN.test(token))) {
    throw invalidQuery('supplierKeys', 'supplierKeys contains an invalid key');
  }
  return { supplierKeys: list.tokens, ...(list.exclude ? { supplierKeysExclude: true } : {}) };
}

function optionalPayment(value: unknown): Partial<OrderResourceDemandQuery> {
  const raw = single(value, 'payment');
  if (raw === undefined || raw.trim() === '') return {};
  if (raw !== 'any_paid' && raw !== 'fully_paid') throw invalidQuery('payment', 'payment must be any_paid or fully_paid');
  return { payment: raw };
}

function optionalBoolean(value: unknown, field: 'unpurchasedOnly' | 'readyCutsOnly'): Partial<OrderResourceDemandQuery> {
  const raw = single(value, field);
  if (raw === undefined || raw.trim() === '' || raw === 'false') return {};
  if (raw !== 'true') throw invalidQuery(field, `${field} must be true or false`);
  return { [field]: true };
}

function optionalId(
  value: unknown,
  field: 'sheetMaterialTypeId' | 'filmId' | 'supplierId' | 'vendorId' | 'onecDocumentId',
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
