import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { OnecDocumentsService } from '../application/onec-documents.service';
import type {
  OnecAllocationResultDto,
  OnecDocumentCardResponseDto,
  OnecDocumentListQuery,
  OnecDocumentListResponseDto,
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
    return this.documents.getCard(user, parseId(documentId, 'documentId'), true);
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

  private requireUser(request: RequestWithCurrentUser, write: boolean): CurrentUser {
    const flags = this.runtimeConfig.getFeatureFlags();
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
