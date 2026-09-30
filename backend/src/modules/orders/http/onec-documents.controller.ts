import { Body, Controller, HttpCode, Delete, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { OnecDocumentsService } from '../application/onec-documents.service';
import type { RequestLinkResultDto } from '../adapters/pg-request-links-repository';
import { MAX_REQUEST_LINKS_PER_ALLOCATION } from '../domain/supplier-request-links';
import {
  ONEC_ALLOCATION_BATCH_LIMIT,
  type AllocationSuggestionsResponseDto,
  type BatchOnecAllocationResultDto,
  type OnecAllocationResultDto,
  type OnecDocumentCardResponseDto,
  type OnecDocumentListQuery,
  type OnecDocumentListResponseDto,
} from '../application/onec-documents.types';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/, 'expectedDemandFingerprint must be a sha256 hex digest');
const expectedVersion = z.number().int().min(0).max(2147483646);
/** Точность как в БД (NUMERIC(14,3) / NUMERIC(14,2)): лишние знаки отклоняются, а не округляются молча. */
export const withScale = (scale: number) => z.number().finite().min(10 ** -scale).max(99_999_999_999)
  // Проверяем десятичную запись числа, без допусков: 10.050000001 и 1e-10 не проходят.
  .refine((value) => new RegExp(`^\\d+(\\.\\d{1,${scale}})?$`).test(String(value)),
    `не больше ${scale} знаков после запятой`);
const addSchema = z.object({
  orderId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  resourceKey: z.string().min(1).max(64),
  quantity: withScale(3).optional(),
  amount: withScale(2).optional(),
  expectedVersion,
  expectedDemandFingerprint: fingerprint,
}).strict();
const removeSchema = z.object({ expectedVersion }).strict();
export const linkSchema = z.object({
  lineOrderId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  quantity: withScale(3),
  expectedVersion,
}).strict();
export const batchSchema = z.object({
  requestId: z.string().uuid(),
  origin: z.enum(['suggested', 'manual']),
  items: z.array(z.object({
    lineId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    orderId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    resourceKey: z.string().min(1).max(64),
    quantity: withScale(3),
    expectedVersion,
    expectedDemandFingerprint: fingerprint,
    // Контекст пересчёта единиц, в котором построено предложение: сверяется в транзакции (CR3-1).
    expectedDocUnit: z.enum(['sheet', 'm2', 'lm', 'pcs', 'set']).nullable(),
    expectedSheetAreaM2: z.number().positive().max(1000).nullable(),
    // Связи нового распределения с заказами строк отправленных заявок (ф.3б), количество — в единице строки заявки.
    requestLinks: z.array(z.object({
      lineOrderId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      quantity: withScale(3),
    }).strict()).max(MAX_REQUEST_LINKS_PER_ALLOCATION).optional(),
  }).strict()).min(1).max(ONEC_ALLOCATION_BATCH_LIMIT),
}).strict();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const flag = z.enum(['true', 'false']).optional().transform((value) => value === 'true');
const listSchema = z.object({
  tab: z.enum(['receipts', 'payments']).default('receipts'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional().transform((value) => value || undefined),
  dateFrom: dateOnly.optional(),
  dateTo: dateOnly.optional(),
  unlinkedOnly: flag,
  postedOnly: flag,
}).strict();

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('procurement/onec-documents')
export class OnecDocumentsController {
  constructor(
    @Inject(OnecDocumentsService) private readonly documents: OnecDocumentsService,
    @Inject(OrdersRuntimeConfigService) private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiResponse({ status: 200, description: '1C documents (receipts or payments) with linked orders' })
  @ApiResponse({ status: 503, description: 'Procurement is disabled' })
  @ApiOperation({ operationId: 'listOnecDocuments', summary: '1C purchase and payment documents' })
  @Get()
  async list(@Req() request: RequestWithCurrentUser, @Query() rawQuery: unknown): Promise<OnecDocumentListResponseDto> {
    const user = this.requireUser(request, false);
    const query = parse(listSchema, rawQuery, 'ONEC_DOCUMENTS_QUERY_INVALID') as OnecDocumentListQuery;
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      throw new ApiError(422, 'ONEC_DOCUMENTS_QUERY_INVALID', 'Дата «с» позже даты «по»', { field: 'dateFrom' });
    }
    return this.documents.list(user, query, true);
  }

  @ApiResponse({ status: 200, description: '1C document with lines and allocations' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  @ApiResponse({ status: 503, description: 'Procurement is disabled' })
  @ApiOperation({ operationId: 'getOnecDocument', summary: '1C document card' })
  @Get(':documentId')
  async card(@Req() request: RequestWithCurrentUser, @Param('documentId') documentId: string): Promise<OnecDocumentCardResponseDto> {
    const user = this.requireUser(request, false);
    return this.documents.getCard(user, parseId(documentId, 'documentId'), true,
      this.runtimeConfig.getFeatureFlags().procurementWorkspaceEnabled === true);
  }

  @ApiResponse({ status: 200, description: 'Allocation state after the command (no-op when repeated)' })
  @ApiResponse({ status: 404, description: 'Document line or order not found' })
  @ApiResponse({ status: 409, description: 'Stale version, changed demand, exceeded line or unposted document' })
  @ApiResponse({ status: 422, description: 'Invalid body, unmapped line or material mismatch' })
  @ApiResponse({ status: 503, description: 'Orders API or procurement is disabled' })
  @ApiOperation({ operationId: 'addOnecAllocation', summary: 'Allocate a 1C document line to an order material' })
  @Post(':documentId/lines/:lineId/allocations')
  async add(
    @Req() request: RequestWithCurrentUser,
    @Param('documentId') documentId: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ): Promise<OnecAllocationResultDto> {
    const user = this.requireUser(request, true);
    const input = parse(addSchema, body, 'ONEC_ALLOCATION_INVALID_INPUT');
    return this.documents.addAllocation({
      ...input,
      currentUser: user,
      documentId: parseId(documentId, 'documentId'),
      lineId: parseId(lineId, 'lineId'),
      requestId: request.requestId ?? 'unknown',
    });
  }

  @ApiResponse({ status: 200, description: 'Suggested orders per receipt line, ranked, with proposed quantities' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  @ApiResponse({ status: 409, description: 'Document is not a posted receipt' })
  @ApiResponse({ status: 503, description: 'Procurement or the workspace is disabled' })
  @ApiOperation({ operationId: 'getOnecAllocationSuggestions', summary: 'Suggest orders for a 1C receipt' })
  @Get(':documentId/allocation-suggestions')
  async suggestions(@Req() request: RequestWithCurrentUser, @Param('documentId') documentId: string): Promise<AllocationSuggestionsResponseDto> {
    const user = this.requireUser(request, false, true);
    // Без флага заявок подбор их не учитывает: откат фазы 3 не ломает применение предложений (CR1-3).
    return this.documents.allocationSuggestions(user, parseId(documentId, 'documentId'), request.requestId ?? 'unknown', {
      supplierRequestsEnabled: this.runtimeConfig.getFeatureFlags().supplierRequestsEnabled === true,
    });
  }

  @ApiResponse({ status: 200, description: 'All items allocated, or every item already present (no-op)' })
  @ApiResponse({ status: 404, description: 'Order out of scope or document line not found' })
  @ApiResponse({ status: 409, description: 'ONEC_ALLOCATION_BATCH_CONFLICT with details.failures; nothing written' })
  @ApiResponse({ status: 422, description: 'Invalid body, duplicates or inconsistent versions' })
  @ApiResponse({ status: 503, description: 'Procurement or the workspace is disabled' })
  @ApiOperation({ operationId: 'addOnecAllocationsBatch', summary: 'Allocate a 1C receipt to several orders at once' })
  @Post(':documentId/allocations/batch')
  async batch(
    @Req() request: RequestWithCurrentUser,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ): Promise<BatchOnecAllocationResultDto> {
    const user = this.requireUser(request, true, true);
    const input = parse(batchSchema, body, 'ONEC_ALLOCATION_BATCH_INVALID_INPUT');
    if (input.items.some((item) => (item.requestLinks?.length ?? 0) > 0)) this.requireRequests();
    return this.documents.addAllocationsBatch({
      currentUser: user,
      documentId: parseId(documentId, 'documentId'),
      requestId: input.requestId,
      origin: input.origin,
      items: input.items,
    });
  }

  @ApiResponse({ status: 200, description: 'Allocation removed (no-op when already removed)' })
  @ApiResponse({ status: 404, description: 'Allocation not found or outside the user scope' })
  @ApiResponse({ status: 409, description: 'Stale version' })
  @ApiResponse({ status: 503, description: 'Orders API or procurement is disabled' })
  @ApiOperation({ operationId: 'removeOnecAllocation', summary: 'Remove a 1C document allocation' })
  @Delete(':documentId/lines/:lineId/allocations/:allocationId')
  async remove(
    @Req() request: RequestWithCurrentUser,
    @Param('documentId') documentId: string,
    @Param('lineId') lineId: string,
    @Param('allocationId') allocationId: string,
    @Body() body: unknown,
  ): Promise<OnecAllocationResultDto> {
    const user = this.requireUser(request, true);
    const input = parse(removeSchema, body, 'ONEC_ALLOCATION_INVALID_INPUT');
    return this.documents.removeAllocation({
      ...input,
      currentUser: user,
      documentId: parseId(documentId, 'documentId'),
      lineId: parseId(lineId, 'lineId'),
      allocationId: parseId(allocationId, 'allocationId'),
      requestId: request.requestId ?? 'unknown',
    });
  }

  @ApiResponse({ status: 200, description: 'Receipt allocation linked to a sent supplier request line order (no-op when the same link exists)' })
  @ApiResponse({ status: 404, description: 'Allocation, line order or order not found / outside the scope' })
  @ApiResponse({ status: 409, description: 'Stale version, request not sent, link exists with another quantity' })
  @ApiResponse({ status: 422, description: 'Supplier mismatch, incompatible units, over the request or the allocation' })
  @ApiResponse({ status: 503, description: 'Procurement, the workspace or supplier requests are disabled' })
  @ApiOperation({ operationId: 'linkOnecAllocationToRequest', summary: 'Link a receipt allocation to a supplier request' })
  @Post(':documentId/lines/:lineId/allocations/:allocationId/request-links')
  @HttpCode(200)
  async linkToRequest(
    @Req() request: RequestWithCurrentUser,
    @Param('documentId') documentId: string,
    @Param('lineId') lineId: string,
    @Param('allocationId') allocationId: string,
    @Body() body: unknown,
  ): Promise<RequestLinkResultDto> {
    const user = this.requireUser(request, true, true);
    this.requireRequests();
    const input = parse(linkSchema, body, 'SUPPLIER_REQUEST_LINK_INVALID_INPUT');
    return this.documents.linkToRequest({
      ...input,
      currentUser: user,
      documentId: parseId(documentId, 'documentId'),
      lineId: parseId(lineId, 'lineId'),
      allocationId: parseId(allocationId, 'allocationId'),
      requestId: request.requestId ?? 'unknown',
    });
  }

  @ApiResponse({ status: 200, description: 'Link removed (no-op when already removed)' })
  @ApiResponse({ status: 404, description: 'Link not found' })
  @ApiResponse({ status: 409, description: 'Stale version' })
  @ApiOperation({ operationId: 'unlinkOnecAllocationFromRequest', summary: 'Unlink a receipt allocation from a supplier request' })
  @Delete(':documentId/lines/:lineId/allocations/:allocationId/request-links/:linkId')
  async unlinkFromRequest(
    @Req() request: RequestWithCurrentUser,
    @Param('documentId') documentId: string,
    @Param('lineId') lineId: string,
    @Param('allocationId') allocationId: string,
    @Param('linkId') linkId: string,
    @Body() body: unknown,
  ): Promise<RequestLinkResultDto> {
    const user = this.requireUser(request, true, true);
    this.requireRequests();
    const input = parse(removeSchema, body, 'SUPPLIER_REQUEST_LINK_INVALID_INPUT');
    return this.documents.unlinkFromRequest({
      ...input,
      currentUser: user,
      documentId: parseId(documentId, 'documentId'),
      lineId: parseId(lineId, 'lineId'),
      allocationId: parseId(allocationId, 'allocationId'),
      linkId: parseId(linkId, 'linkId'),
      requestId: request.requestId ?? 'unknown',
    });
  }

  private requireRequests(): void {
    if (this.runtimeConfig.getFeatureFlags().supplierRequestsEnabled !== true) {
      throw new ApiError(503, 'SUPPLIER_REQUESTS_DISABLED', 'Заявки поставщикам пока выключены', { feature: 'supplierRequests' });
    }
  }

  private requireUser(request: RequestWithCurrentUser, write: boolean, workspace = false): CurrentUser {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (workspace && flags.ordersEnabled && flags.resourceProcurementEnabled === true && flags.procurementWorkspaceEnabled !== true) {
      throw new ApiError(503, 'PROCUREMENT_WORKSPACE_DISABLED', 'Экран снабжения пока выключен', { feature: 'procurementWorkspace' });
    }
    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', { feature: 'orders' });
    }
    if (flags.resourceProcurementEnabled !== true) {
      // Таблицы документов 1С читаются только при включённом закупе (откат флагом).
      throw new ApiError(503, 'PROCUREMENT_DISABLED', 'Документы 1С пока выключены', { feature: 'resourceProcurement' });
    }
    if (write && flags.ordersReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is read-only', { feature: 'orders' });
    }
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}

function parseId(value: string, field: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError(422, 'ONEC_ID_INVALID', 'Некорректный идентификатор', { field });
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
