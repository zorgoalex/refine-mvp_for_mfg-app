import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { InventoryService } from '../application/inventory.service';
import type { CommandContext } from '../application/inventory.types';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const quantity = z.number().finite().min(0).max(1_000_000);
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
}).strict().refine((body) => !body.orderId || body.docType === 'writeoff', { message: 'orderId only for writeoff', path: ['orderId'] });

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
}).strict();

const lineSchema = z.object({
  version,
  filmId: id.optional(),
  quantity: quantity.optional(),
  confirmMatch: z.boolean().optional(),
  confirmQuantity: z.boolean().optional(),
  skip: z.boolean().optional(),
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
  constructor(@Inject(InventoryService) private readonly inventory: InventoryService) {}

  @ApiOperation({ operationId: 'listInventoryWarehouses', summary: 'Active warehouses' })
  @ApiResponse({ status: 200, description: 'Warehouses' })
  @Get('inventory/warehouses')
  async warehouses(@Req() request: RequestWithCurrentUser) {
    return { items: await this.inventory.listWarehouses(this.user(request)) };
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

  @ApiOperation({ operationId: 'listInventoryDocuments', summary: 'Stock documents journal' })
  @ApiResponse({ status: 200, description: 'Documents page' })
  @Get('inventory/documents')
  documents(@Req() request: RequestWithCurrentUser, @Query() query: Record<string, string | undefined>) {
    const page = paging(query.offset, query.limit, 200);
    const type = query.type && ['receipt', 'writeoff', 'inventory'].includes(query.type) ? query.type as 'receipt' : null;
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
