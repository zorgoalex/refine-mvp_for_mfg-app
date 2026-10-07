import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { InventoryOnecProjectionService } from '../application/inventory-onec-projection.service';
import { InventoryService } from '../application/inventory.service';
import type { CommandContext, StockDocKind } from '../application/inventory.types';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const quantity = z.number().finite().min(0).max(1_000_000);
/** Момент подсчёта инвентаризации: ISO-дата-время с поясом (отсечка расхода 1С). */
const countedAt = z.string().datetime({ offset: true }).nullable().optional();
const version = z.number().int().min(1).max(2147483646);

const manualSchema = z.object({
  docType: z.enum(['receipt', 'writeoff', 'inventory']),
  warehouseId: id,
  docDate: isoDate,
  orderId: id.nullable().optional(),
  comment: z.string().max(2000).nullable().optional(),
  lines: z.array(z.object({ filmId: id, quantity }).strict()).min(1).max(200),
  post: z.boolean().optional(),
  allowNegative: z.boolean().optional(),
  countedAt,
}).strict()
  .refine((body) => !body.orderId || body.docType === 'writeoff', { message: 'orderId only for writeoff', path: ['orderId'] })
  .refine((body) => !body.countedAt || body.docType === 'inventory', { message: 'countedAt only for inventory', path: ['countedAt'] });

const importSchema = z.object({
  docType: z.enum(['receipt', 'inventory']),
  warehouseId: id,
  docDate: isoDate,
  fileName: z.string().min(1).max(255),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sheetName: z.string().min(1).max(255),
  rows: z.array(z.object({
    rowNo: z.number().int().min(1).max(1_000_000),
    name: z.string().min(1).max(500),
    supplier: z.string().max(200).nullable(),
    quantity: z.union([z.string().max(50), quantity]).nullable(),
  }).strict()).min(1).max(2000),
  countedAt,
}).strict().refine((body) => !body.countedAt || body.docType === 'inventory', { message: 'countedAt only for inventory', path: ['countedAt'] });

const lineSchema = z.object({
  version,
  filmId: id.optional(),
  quantity: quantity.optional(),
  confirmMatch: z.boolean().optional(),
  confirmQuantity: z.boolean().optional(),
  skip: z.boolean().optional(),
}).strict();

const smallintId = z.number().int().positive().max(32767);
const warehouseName = z.string().trim().min(1).max(128);
const onecKey = z.string().trim().uuid();
const warehouseCreateSchema = z.object({
  name: warehouseName,
  refKey1c: onecKey,
  workshopId: smallintId.nullable().optional(),
  responsibleEmployeeId: id.nullable().optional(),
}).strict();
const warehouseUpdateSchema = z.object({
  version: z.string().min(1).max(64),
  name: warehouseName.optional(),
  refKey1c: onecKey.optional(),
  workshopId: smallintId.nullable().optional(),
  responsibleEmployeeId: id.nullable().optional(),
  isActive: z.boolean().optional(),
  onecConsumptionSince: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

const postSchema = z.object({ version, allowNegative: z.boolean().optional() }).strict();
const cancelSchema = z.object({ version }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректный запрос', {
      errors: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}

function parseId(value: string, field: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректный идентификатор', { field });
  }
  return Number(value);
}

function optionalId(value: string | undefined, field: string): number | null {
  return value === undefined || value === '' ? null : parseId(value, field);
}

const STOCK_GROUP = /^(all|film|film_unlinked|no_type|unlinked|material:[1-9][0-9]{0,4})$/;
const CATEGORY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Группа вкладки и категория 1С «Остатков на складах»; `none` — строки 1С без категории, '' — без фильтра. */
function stockGroup(group: string | undefined, categoryKey: string | undefined): { group: string; categoryKey: string | null } {
  const value = group === undefined || group === '' ? 'all' : group;
  if (!STOCK_GROUP.test(value)) throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректная группа', { field: 'group' });
  if (categoryKey === undefined || categoryKey === '') return { group: value, categoryKey: null };
  if (categoryKey !== 'none' && !CATEGORY_KEY.test(categoryKey)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректная категория 1С', { field: 'categoryKey' });
  }
  return { group: value, categoryKey: categoryKey.toLowerCase() };
}

function paging(offset: string | undefined, limit: string | undefined, max: number): { offset: number; limit: number } {
  const o = offset === undefined ? 0 : Number(offset);
  const l = limit === undefined ? Math.min(100, max) : Number(limit);
  if (!Number.isInteger(o) || o < 0 || !Number.isInteger(l) || l < 1 || l > max) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректная пагинация');
  }
  return { offset: o, limit: l };
}

@ApiTags('Inventory')
@ApiBearerAuth()
@Controller()
export class InventoryController {
  constructor(
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(InventoryOnecProjectionService) private readonly projection: InventoryOnecProjectionService,
  ) {}

  @ApiOperation({ operationId: 'listInventoryWarehouses', summary: 'Active warehouses' })
  @ApiResponse({ status: 200, description: 'Warehouses' })
  @Get('inventory/warehouses')
  async warehouses(@Req() request: RequestWithCurrentUser, @Query('includeInactive') includeInactive?: string) {
    return { items: await this.inventory.listWarehouses(this.user(request), includeInactive === 'true') };
  }

  @ApiOperation({ operationId: 'createInventoryWarehouse', summary: 'Create a warehouse' })
  @ApiResponse({ status: 201, description: 'Warehouse' })
  @Post('inventory/warehouses')
  createWarehouse(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parse(warehouseCreateSchema, body);
    return this.inventory.createWarehouse(this.ctx(request, key), {
      name: input.name, refKey1c: input.refKey1c, workshopId: input.workshopId ?? null, responsibleEmployeeId: input.responsibleEmployeeId ?? null,
    });
  }

  @ApiOperation({ operationId: 'listInventoryOnecWarehouses', summary: '1C warehouses from the mirror with their ERP links' })
  @ApiResponse({ status: 200, description: '{available, items}' })
  @Get('inventory/warehouses/onec')
  onecWarehouses(@Req() request: RequestWithCurrentUser) {
    return this.inventory.listOnecWarehouses(this.user(request));
  }

  @ApiOperation({ operationId: 'syncInventoryWarehousesFromOnec', summary: 'Create or link ERP warehouses for all 1C warehouses' })
  @ApiResponse({ status: 200, description: '{created, linked, skipped}' })
  @ApiResponse({ status: 409, description: '1C mirror unavailable' })
  @Post('inventory/warehouses/sync-onec')
  @HttpCode(200)
  syncWarehouses(@Req() request: RequestWithCurrentUser, @Headers('idempotency-key') key: string | undefined) {
    return this.inventory.syncWarehousesFromOnec(this.ctx(request, key));
  }

  @ApiOperation({ operationId: 'updateInventoryWarehouse', summary: 'Update or (de)activate a warehouse' })
  @ApiResponse({ status: 200, description: 'Warehouse' })
  @ApiResponse({ status: 409, description: 'Stale version, duplicate name, or stock/drafts block deactivation' })
  @Patch('inventory/warehouses/:warehouseId')
  updateWarehouse(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') key: string | undefined,
    @Param('warehouseId') warehouseId: string,
    @Body() body: unknown,
  ) {
    const parsedId = parseId(warehouseId, 'warehouseId');
    if (parsedId > 32767) throw new ApiError(404, 'WAREHOUSE_NOT_FOUND', 'Склад не найден');
    const input = parse(warehouseUpdateSchema, body);
    return this.inventory.updateWarehouse(this.ctx(request, key), { warehouseId: parsedId, ...input });
  }

  @ApiOperation({ operationId: 'listInventoryBalances', summary: 'Film stock balances' })
  @ApiResponse({ status: 200, description: 'Balances page' })
  @Get('inventory/balances')
  balances(@Req() request: RequestWithCurrentUser, @Query() query: Record<string, string | undefined>) {
    const page = paging(query.offset, query.limit, 500);
    return this.inventory.listBalances(this.user(request), {
      warehouseId: optionalId(query.warehouseId, 'warehouseId'),
      vendorId: optionalId(query.vendorId, 'vendorId'),
      search: query.search?.trim().slice(0, 200) || null,
      nonZero: query.nonZero === 'true',
      negative: query.negative === 'true',
      ...page,
    });
  }

  @ApiOperation({ operationId: 'getInventoryWarehouseStock', summary: 'Warehouse stock by material tabs: films from ERP, other materials from 1C (read-only)' })
  @ApiResponse({ status: 200, description: 'Tabs, 1C source state and a page of stock rows' })
  @Get('inventory/stock')
  warehouseStock(@Req() request: RequestWithCurrentUser, @Query() query: Record<string, string | undefined>) {
    const page = paging(query.offset, query.limit, 500);
    if (query.warehouseId === undefined || query.warehouseId === '') {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Не указан склад', { field: 'warehouseId' });
    }
    const warehouseId = parseId(query.warehouseId, 'warehouseId');
    if (warehouseId > 32767) throw new ApiError(404, 'WAREHOUSE_NOT_FOUND', 'Склад не найден');
    return this.inventory.warehouseStock(this.user(request), {
      warehouseId,
      ...stockGroup(query.group, query.categoryKey),
      search: query.search?.trim().slice(0, 200) || null,
      nonZero: query.nonZero === 'true',
      negative: query.negative === 'true',
      ...page,
    });
  }

  @ApiOperation({ operationId: 'listInventoryDocuments', summary: 'Stock documents journal' })
  @ApiResponse({ status: 200, description: 'Documents page' })
  @Get('inventory/documents')
  documents(@Req() request: RequestWithCurrentUser, @Query() query: Record<string, string | undefined>) {
    const page = paging(query.offset, query.limit, 200);
    const type = query.type && ['receipt', 'writeoff', 'inventory', 'onec'].includes(query.type) ? query.type as StockDocKind : null;
    const status = query.status && ['draft', 'posted', 'cancelled'].includes(query.status) ? query.status as 'draft' : null;
    const from = query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : null;
    const to = query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? query.to : null;
    return this.inventory.listDocuments(this.user(request), {
      type, status, from, to,
      filmId: optionalId(query.filmId, 'filmId'),
      orderId: optionalId(query.orderId, 'orderId'),
      ...page,
    });
  }

  @ApiOperation({ operationId: 'getInventoryDocument', summary: 'Stock document with lines and movements' })
  @ApiResponse({ status: 200, description: 'Document' })
  @ApiResponse({ status: 404, description: 'Not found or linked order not visible' })
  @Get('inventory/documents/:documentId')
  document(@Req() request: RequestWithCurrentUser, @Param('documentId') documentId: string) {
    return this.inventory.getDocument(this.user(request), parseId(documentId, 'documentId'));
  }

  @ApiOperation({ operationId: 'createInventoryDocument', summary: 'Manual receipt / write-off / inventory (optionally posted)' })
  @ApiResponse({ status: 201, description: 'Document' })
  @Post('inventory/documents')
  createManual(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parse(manualSchema, body);
    return this.inventory.createManual(this.ctx(request, key), {
      docType: input.docType, warehouseId: input.warehouseId, docDate: input.docDate,
      orderId: input.orderId ?? null, comment: input.comment?.trim() || null,
      lines: input.lines, post: input.post === true, allowNegative: input.allowNegative === true,
      ...(input.countedAt ? { countedAt: input.countedAt } : {}),
    });
  }

  @ApiOperation({ operationId: 'createInventoryImport', summary: 'Stock file import draft (rows parsed in the browser)' })
  @ApiResponse({ status: 201, description: 'Draft document' })
  @Post('inventory/imports')
  createImport(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.inventory.createImport(this.ctx(request, key), parse(importSchema, body));
  }

  @ApiOperation({ operationId: 'updateInventoryDocumentLine', summary: 'Resolve a draft line' })
  @ApiResponse({ status: 200, description: 'Document' })
  @Patch('inventory/documents/:documentId/lines/:lineId')
  updateLine(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') key: string | undefined,
    @Param('documentId') documentId: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ) {
    const input = parse(lineSchema, body);
    return this.inventory.updateLine(this.ctx(request, key), {
      ...input, documentId: parseId(documentId, 'documentId'), lineId: parseId(lineId, 'lineId'),
    });
  }

  @ApiOperation({ operationId: 'postInventoryDocument', summary: 'Post a draft document' })
  @ApiResponse({ status: 200, description: 'Document' })
  @ApiResponse({ status: 409, description: 'Stale, not draft, or would go negative' })
  @ApiResponse({ status: 422, description: 'Unresolved lines or non-canonical film' })
  @Post('inventory/documents/:documentId/post')
  post(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') key: string | undefined,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    const input = parse(postSchema, body);
    return this.inventory.post(this.ctx(request, key), parseId(documentId, 'documentId'), input.version, input.allowNegative === true);
  }

  @ApiOperation({ operationId: 'cancelInventoryDocument', summary: 'Cancel a draft document' })
  @ApiResponse({ status: 200, description: 'Document' })
  @Post('inventory/documents/:documentId/cancel')
  cancel(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') key: string | undefined,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    const input = parse(cancelSchema, body);
    return this.inventory.cancel(this.ctx(request, key), parseId(documentId, 'documentId'), input.version);
  }

  @ApiOperation({ operationId: 'listInventoryOnecIssues', summary: '1C consumption lines not applied to the ERP ledger (reasons)' })
  @ApiResponse({ status: 200, description: 'Issues page with counts by code' })
  @Get('inventory/onec-consumption/issues')
  onecIssues(@Req() request: RequestWithCurrentUser, @Query() query: Record<string, string | undefined>) {
    const page = paging(query.offset, query.limit, 500);
    const code = query.code?.trim() || null;
    if (code !== null && !/^[A-Z_]{3,40}$/.test(code)) throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректный код', { field: 'code' });
    return this.projection.listIssues(this.user(request).permissions, {
      warehouseId: optionalId(query.warehouseId, 'warehouseId'), code, includeBeforeCutoff: query.includeBeforeCutoff === 'true', ...page,
    });
  }

  @ApiOperation({ operationId: 'runInventoryOnecConsumption', summary: 'Run the 1C consumption projection pass now' })
  @ApiResponse({ status: 200, description: 'Pass outcome' })
  @Post('inventory/onec-consumption/run')
  @HttpCode(200)
  runOnecConsumption(@Req() request: RequestWithCurrentUser) {
    return this.projection.runNow({ currentUser: this.user(request), requestId: request.requestId ?? 'unknown' });
  }

  @ApiOperation({ operationId: 'compensateInventoryOnecConsumption', summary: 'Return the 1C consumption of a warehouse to zero and clear its start moment (rollback)' })
  @ApiResponse({ status: 200, description: 'Compensation result: documents written and remaining applied amount; a replay returns the stored result' })
  @ApiResponse({ status: 404, description: 'Warehouse not found' })
  @ApiResponse({ status: 409, description: 'ONEC_COMPENSATION_SUPERSEDED: an interrupted rollback, consumption enabled again since; ONEC_COMPENSATION_CONFIRM_REQUIRED: the rollback would also remove 1C receipts and the request does not acknowledge it' })
  @ApiResponse({ status: 422, description: 'IDEMPOTENCY_KEY_REUSED' })
  @Post('inventory/warehouses/:warehouseId/onec-consumption/compensate')
  @HttpCode(200)
  compensateOnecConsumption(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') key: string | undefined,
    @Param('warehouseId') warehouseId: string,
    @Body() body?: unknown,
  ) {
    const parsedId = parseId(warehouseId, 'warehouseId');
    if (parsedId > 32767) throw new ApiError(404, 'WAREHOUSE_NOT_FOUND', 'Склад не найден');
    // Клиент подтверждает, что знает: откат снимает и поступления 1С (старый клиент этого поля не шлёт).
    const includesReceipts = typeof body === 'object' && body !== null && (body as { includesReceipts?: unknown }).includesReceipts === true;
    return this.projection.compensate(this.ctx(request, key), parsedId, { includesReceipts });
  }

  @ApiOperation({ operationId: 'getOrderSheetStock', summary: 'Stock of the sheet materials used by an order, from 1C balances (no reservation)' })
  @ApiResponse({ status: 200, description: 'Items with 1C quantity, m² equivalent, order demand and coverage status' })
  @ApiResponse({ status: 404, description: 'Order not found or outside the user scope' })
  @Get('orders/:orderId/sheet-stock')
  orderSheetStock(@Req() request: RequestWithCurrentUser, @Param('orderId') orderId: string) {
    return this.inventory.orderSheetStock(this.user(request), parseId(orderId, 'orderId'));
  }

  @ApiOperation({ operationId: 'getOrderFilmStock', summary: 'Stock of the films used by an order (physical, no reservation)' })
  @ApiResponse({ status: 200, description: 'Per-film stock and demand' })
  @ApiResponse({ status: 404, description: 'Order not found or outside the user scope' })
  @Get('orders/:orderId/film-stock')
  orderFilmStock(@Req() request: RequestWithCurrentUser, @Param('orderId') orderId: string) {
    return this.inventory.orderFilmStock(this.user(request), parseId(orderId, 'orderId'));
  }

  private user(request: RequestWithCurrentUser): CurrentUser {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }

  private ctx(request: RequestWithCurrentUser, key: string | undefined): CommandContext {
    const idempotencyKey = key?.trim() ?? '';
    if (idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Требуется заголовок Idempotency-Key (1..200 символов)');
    }
    return { currentUser: this.user(request), requestId: request.requestId ?? 'unknown', idempotencyKey };
  }
}
