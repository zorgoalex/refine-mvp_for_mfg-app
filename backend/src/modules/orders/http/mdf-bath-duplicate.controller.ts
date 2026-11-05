import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { MdfBathDuplicateService } from '../application/mdf-bath-duplicate.service';
import type {
  MdfBathDuplicatesResponseDto,
  ResolveMdfBathDuplicateRequestDto,
  ResolveMdfBathDuplicateResponseDto,
} from '../dto/mdf-bath-duplicate.dto';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const BATH_CARD_ID = z.string().regex(/^cut-result:[1-9][0-9]{0,15}$/, 'bath card id must be cut-result:<id>');
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const BATH_CARD_ID_RE = /^cut-result:[1-9][0-9]{0,15}$/;
export const MDF_BATH_DUPLICATES_LIST_LIMIT = 100;

const resolveBodySchema = z.object({
  bathCardId: BATH_CARD_ID,
  otherBathCardId: BATH_CARD_ID,
  action: z.enum(['keep_both', 'rework_mark']),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/, 'expectedDigest must be the board digest'),
}).strict().refine(body => body.bathCardId !== body.otherBathCardId, {
  message: 'the baths must differ', path: ['otherBathCardId'],
});

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders/status-board/mdf-bath-duplicates')
export class MdfBathDuplicateController {
  constructor(
    @Inject(MdfBathDuplicateService)
    private readonly duplicates: MdfBathDuplicateService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiOperation({
    operationId: 'listMdfBathDuplicates',
    summary: 'Duplicate pairs and rework marks of explicitly requested active MDF baths (hybrid board engine cards)',
  })
  @ApiResponse({ status: 200, description: 'Pair facts of the requested baths the user may see' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Missing orders.view' })
  @ApiResponse({ status: 422, description: 'Invalid or too many bathCardIds' })
  @ApiResponse({ status: 503, description: 'Orders API or the bath duplicates read is disabled' })
  @Get()
  list(
    @Req() request: RequestWithCurrentUser,
    @Query('bathCardIds') rawIds?: string,
  ): Promise<MdfBathDuplicatesResponseDto> {
    this.assertEnabled('read');
    const currentUser = requireCurrentUser(request);
    return this.duplicates.list({ currentUser, bathCardIds: parseMdfBathCardIds(rawIds), requestId: request.requestId });
  }

  @ApiOperation({
    operationId: 'resolveMdfBathDuplicate',
    summary: 'Record a «keep both» or «rework mark» decision for two active MDF baths sharing details',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Reuse only for an exact retry of this decision' })
  @ApiResponse({ status: 200, description: 'Decision recorded (or the same decision replayed)' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Missing cut.manage/orders.view or an order of either bath is out of scope' })
  @ApiResponse({ status: 409, description: 'The baths changed (digest) or the idempotency key was reused' })
  @ApiResponse({ status: 422, description: 'Invalid payload or Idempotency-Key' })
  @ApiResponse({ status: 503, description: 'Orders API or the bath duplicates command is disabled' })
  @Post('resolve')
  @HttpCode(200)
  resolve(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ResolveMdfBathDuplicateResponseDto> {
    this.assertEnabled('write');
    const currentUser = requireCurrentUser(request);
    const parsed = parseResolveMdfBathDuplicateBody(body);
    return this.duplicates.resolve({
      currentUser,
      ...parsed,
      idempotencyKey: parseMdfBathDuplicateIdempotencyKey(idempotencyKey),
      requestId: request.requestId,
    });
  }

  private assertEnabled(kind: 'read' | 'write'): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', { feature: 'orders' });
    }
    if (kind === 'read' ? !flags.mdfBathDuplicatesReadEnabled : !flags.mdfBathDuplicatesWriteEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Разбор дублей ванн выключен', {
        feature: 'mdf_bath_duplicates',
      });
    }
  }
}

export function parseResolveMdfBathDuplicateBody(body: unknown): ResolveMdfBathDuplicateRequestDto {
  const parsed = resolveBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid MDF bath duplicate payload', {
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

/** `cut-result:<id>` list, comma separated, 1..100 distinct ids. */
export function parseMdfBathCardIds(value: string | undefined): string[] {
  const ids = [...new Set((value ?? '').split(',').map(id => id.trim()).filter(Boolean))];
  if (!ids.length || ids.length > MDF_BATH_DUPLICATES_LIST_LIMIT || !ids.every(id => BATH_CARD_ID_RE.test(id))) {
    throw new ApiError(422, 'VALIDATION_ERROR', `bathCardIds must be 1-${MDF_BATH_DUPLICATES_LIST_LIMIT} cut-result:<id> values`, {
      field: 'bathCardIds',
    });
  }
  return ids;
}

export function parseMdfBathDuplicateIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? '';
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Idempotency-Key must be 8-200 safe characters', {
      field: 'Idempotency-Key',
    });
  }
  return key;
}

function requireCurrentUser(request: RequestWithCurrentUser) {
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return request.user;
}
