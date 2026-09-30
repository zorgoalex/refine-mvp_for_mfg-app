import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { SupplierRequestsService } from '../application/supplier-requests.service';
import {
  SUPPLIER_REQUEST_DRAFT_ITEMS_LIMIT,
  SUPPLIER_REQUEST_LINE_ORDERS_LIMIT,
  SUPPLIER_REQUEST_LINES_LIMIT,
  type CreateSupplierRequestDraftsResultDto,
  type SupplierRequestCardDto,
  type SupplierRequestCommandResultDto,
  type SupplierRequestStatus,
  type SupplierRequestsListResponseDto,
  type SupplierRequestTransition,
} from '../application/supplier-requests.types';
import { withScale } from './onec-documents.controller';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const STATUSES = ['draft', 'sent', 'closed', 'cancelled'] as const;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, 'некорректная дата');
const quantity = withScale(3);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const resourceKey = z.string().regex(/^(sheet_material|film):[1-9][0-9]{0,15}$/, 'некорректный ключ материала');

export const listQuerySchema = z.object({
  status: z.string().max(60).optional().transform((value, ctx) => {
    if (!value) return undefined;
    const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
    for (const item of items) {
      if (!(STATUSES as readonly string[]).includes(item)) {
        ctx.addIssue({ code: 'custom', message: `неизвестный статус: ${item}` });
        return z.NEVER;
      }
    }
    return items as SupplierRequestStatus[];
  }),
  search: z.string().trim().max(200).optional().transform((value) => value || undefined),
}).strict();

export const draftsSchema = z.object({
  requestId: z.string().uuid(),
  items: z.array(z.object({ orderId: id, resourceKey }).strict()).min(1).max(SUPPLIER_REQUEST_DRAFT_ITEMS_LIMIT),
}).strict();

export const updateSchema = z.object({
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  comment: z.string().max(2000).nullable().optional(),
  expectedDate: dateOnly.nullable().optional(),
  supplierId: z.number().int().positive().max(32767).nullable().optional(),
  lines: z.array(z.object({
    lineId: id,
    quantity,
    orders: z.array(z.object({ lineOrderId: id, quantity }).strict()).max(SUPPLIER_REQUEST_LINE_ORDERS_LIMIT),
  }).strict()).max(SUPPLIER_REQUEST_LINES_LIMIT).optional(),
}).strict();

export const transitionSchema = z.object({
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('procurement/supplier-requests')
export class SupplierRequestsController {
  constructor(
    @Inject(SupplierRequestsService) private readonly requests: SupplierRequestsService,
    @Inject(OrdersRuntimeConfigService) private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiResponse({ status: 200, description: 'Supplier requests (drafts and sent first), counts by status' })
  @ApiResponse({ status: 403, description: 'procurement.view required' })
  @ApiResponse({ status: 503, description: 'Orders API, procurement, the workspace or supplier requests are disabled' })
  @ApiOperation({ operationId: 'listSupplierRequests', summary: 'List supplier requests' })
  @Get()
  async list(@Req() request: RequestWithCurrentUser, @Query() rawQuery: unknown): Promise<SupplierRequestsListResponseDto> {
    const user = this.requireEnabled(request, false);
    return this.requests.list(user, parse(listQuerySchema, rawQuery, 'SUPPLIER_REQUESTS_QUERY_INVALID'));
  }

  @ApiResponse({ status: 200, description: 'Drafts created (one per supplier); a repeat with the same requestId returns the stored result' })
  @ApiResponse({ status: 403, description: 'procurement.manage required' })
  @ApiResponse({ status: 404, description: 'Order not found or outside the user scope' })
  @ApiResponse({ status: 409, description: 'Idempotency key reused with another body' })
  @ApiResponse({ status: 422, description: 'Invalid input or nothing to order' })
  @ApiResponse({ status: 503, description: 'Supplier requests are disabled' })
  @ApiOperation({ operationId: 'createSupplierRequestDrafts', summary: 'Create supplier request drafts from worklist lines' })
  @Post('drafts')
  @HttpCode(200)
  async createDrafts(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<CreateSupplierRequestDraftsResultDto> {
    const user = this.requireEnabled(request, true);
    const input = parse(draftsSchema, body, 'SUPPLIER_REQUEST_INVALID_INPUT');
    return this.requests.createDrafts({ currentUser: user, requestId: input.requestId, items: input.items });
  }

  @ApiResponse({ status: 200, description: 'Supplier request card' })
  @ApiResponse({ status: 404, description: 'Supplier request not found' })
  @ApiResponse({ status: 503, description: 'Supplier requests are disabled' })
  @ApiOperation({ operationId: 'getSupplierRequest', summary: 'Supplier request card' })
  @Get(':supplierRequestId')
  async card(@Req() request: RequestWithCurrentUser, @Param('supplierRequestId') supplierRequestId: string): Promise<SupplierRequestCardDto> {
    const user = this.requireEnabled(request, false);
    return this.requests.getCard(user, parseId(supplierRequestId));
  }

  @ApiResponse({ status: 200, description: 'Draft updated (no-op when unchanged)' })
  @ApiResponse({ status: 403, description: 'procurement.manage required' })
  @ApiResponse({ status: 404, description: 'Supplier request not found' })
  @ApiResponse({ status: 409, description: 'Stale version or the request is not a draft' })
  @ApiResponse({ status: 422, description: 'Invalid input' })
  @ApiOperation({ operationId: 'updateSupplierRequest', summary: 'Update a supplier request draft' })
  @Patch(':supplierRequestId')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('supplierRequestId') supplierRequestId: string,
    @Body() body: unknown,
  ): Promise<SupplierRequestCommandResultDto> {
    const user = this.requireEnabled(request, true);
    const input = parse(updateSchema, body, 'SUPPLIER_REQUEST_INVALID_INPUT');
    return this.requests.update({ ...input, currentUser: user, requestId: request.requestId ?? 'unknown', supplierRequestId: parseId(supplierRequestId) });
  }

  @ApiResponse({ status: 200, description: 'Sent (no-op when already sent)' })
  @ApiResponse({ status: 409, description: 'Stale version or invalid transition' })
  @ApiResponse({ status: 422, description: 'Supplier is not set' })
  @ApiOperation({ operationId: 'sendSupplierRequest', summary: 'Mark a supplier request as sent' })
  @Post(':supplierRequestId/send')
  @HttpCode(200)
  async send(@Req() request: RequestWithCurrentUser, @Param('supplierRequestId') supplierRequestId: string, @Body() body: unknown) {
    return this.transition(request, supplierRequestId, body, 'send');
  }

  @ApiResponse({ status: 200, description: 'Closed (no-op when already closed)' })
  @ApiResponse({ status: 409, description: 'Stale version or invalid transition' })
  @ApiOperation({ operationId: 'closeSupplierRequest', summary: 'Close a sent supplier request' })
  @Post(':supplierRequestId/close')
  @HttpCode(200)
  async close(@Req() request: RequestWithCurrentUser, @Param('supplierRequestId') supplierRequestId: string, @Body() body: unknown) {
    return this.transition(request, supplierRequestId, body, 'close');
  }

  @ApiResponse({ status: 200, description: 'Cancelled (no-op when already cancelled)' })
  @ApiResponse({ status: 409, description: 'Stale version or invalid transition' })
  @ApiOperation({ operationId: 'cancelSupplierRequest', summary: 'Cancel a draft or sent supplier request' })
  @Post(':supplierRequestId/cancel')
  @HttpCode(200)
  async cancel(@Req() request: RequestWithCurrentUser, @Param('supplierRequestId') supplierRequestId: string, @Body() body: unknown) {
    return this.transition(request, supplierRequestId, body, 'cancel');
  }

  private async transition(
    request: RequestWithCurrentUser,
    supplierRequestId: string,
    body: unknown,
    transition: SupplierRequestTransition,
  ): Promise<SupplierRequestCommandResultDto> {
    const user = this.requireEnabled(request, true);
    const input = parse(transitionSchema, body, 'SUPPLIER_REQUEST_INVALID_INPUT');
    return this.requests.transition({
      currentUser: user,
      requestId: request.requestId ?? 'unknown',
      supplierRequestId: parseId(supplierRequestId),
      expectedVersion: input.expectedVersion,
      transition,
    });
  }

  private requireEnabled(request: RequestWithCurrentUser, write: boolean): CurrentUser {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.ordersEnabled) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', { feature: 'orders' });
    if (write && flags.ordersReadOnly) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is read-only', { feature: 'orders' });
    if (flags.resourceProcurementEnabled !== true || flags.procurementWorkspaceEnabled !== true || flags.supplierRequestsEnabled !== true) {
      throw new ApiError(503, 'SUPPLIER_REQUESTS_DISABLED', 'Заявки поставщикам пока выключены', { feature: 'supplierRequests' });
    }
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}

function parseId(value: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError(422, 'SUPPLIER_REQUEST_INVALID_INPUT', 'Некорректный номер заявки', { field: 'supplierRequestId' });
  }
  return Number(value);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError(422, code, 'Некорректные данные запроса', {
      issues: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}
