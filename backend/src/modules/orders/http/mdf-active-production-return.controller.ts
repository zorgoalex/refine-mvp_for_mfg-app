import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type {
  MdfActiveProductionReturnConfirmRequestDto,
  MdfActiveProductionReturnConfirmResponseDto,
  MdfActiveProductionReturnPreviewRequestDto,
  MdfActiveProductionReturnPreviewResponseDto,
  MdfActiveProductionReturnSourceDto,
} from '../dto/mdf-active-production-return.dto';
import { MdfActiveProductionReturnService } from '../application/mdf-active-production-return.service';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const previewBodySchema = z.object({
  sourceToken: z.string().regex(/^[a-f0-9]{64}$/),
  targetColumn: z.enum(['parsed', 'completed', 'baths', 'baths_ready', 'baths_laminated']),
  productionStatusId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

const confirmBodySchema = previewBodySchema.extend({
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
}).strict();

const sourceSchema = z.object({
  kind: z.enum(['packet', 'bath', 'bazisCutSet']),
  id: z.string().max(100),
}).strict().refine(({ kind, id }) => kind === 'packet'
  ? /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
  : kind === 'bath'
    ? /^cut-result:[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id.slice('cut-result:'.length)))
    : /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)), 'Invalid MDF source identity');

const bodyProperties = {
  sourceToken: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  targetColumn: { type: 'string', enum: ['parsed', 'completed', 'baths', 'baths_ready', 'baths_laminated'] },
  productionStatusId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
};

@ApiTags('Orders')
@ApiBearerAuth()
@ApiParam({ name: 'cardKind', enum: ['packet', 'bath', 'bazisCutSet'] })
@ApiParam({ name: 'cardId', type: String })
@ApiResponse({ status: 401, description: 'Authentication required' })
@ApiResponse({ status: 403, description: 'Insufficient production/order scope' })
@ApiResponse({ status: 409, description: 'Stale preview or concurrent change' })
@ApiResponse({ status: 422, description: 'Unresolved source or blocked correction' })
@ApiResponse({ status: 503, description: 'Orders API or active MDF writer is unavailable' })
@Controller('orders/status-board/mdf-corrections/:cardKind/:cardId')
export class MdfActiveProductionReturnController {
  constructor(
    @Inject(MdfActiveProductionReturnService)
    private readonly corrections: MdfActiveProductionReturnService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtime: OrdersRuntimeConfigService,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'previewMdfActiveProductionReturn',
    summary: 'Preview accepted-evidence MDF correction consequences',
  })
  @ApiBody({ schema: {
    type: 'object', required: ['sourceToken', 'targetColumn'], additionalProperties: false,
    properties: bodyProperties,
  } })
  preview(
    @Req() request: RequestWithCurrentUser,
    @Param('cardKind') rawKind: string,
    @Param('cardId') rawId: string,
    @Body() body: unknown,
  ): Promise<MdfActiveProductionReturnPreviewResponseDto> {
    this.assertEnabled();
    const currentUser = requireCurrentUser(request);
    return this.corrections.preview(
      currentUser,
      parse(sourceSchema, { kind: rawKind, id: rawId }),
      parse(previewBodySchema, body),
      request.requestId ?? 'mdf-active-production-return-preview',
    );
  }

  @Post('confirm')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'confirmMdfActiveProductionReturn',
    summary: 'Confirm the previewed accepted-evidence MDF correction',
  })
  @ApiBody({ schema: {
    type: 'object',
    required: ['sourceToken', 'targetColumn', 'expectedDigest', 'idempotencyKey'],
    additionalProperties: false,
    properties: {
      ...bodyProperties,
      expectedDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$', maxLength: 128 },
    },
  } })
  confirm(
    @Req() request: RequestWithCurrentUser,
    @Param('cardKind') rawKind: string,
    @Param('cardId') rawId: string,
    @Body() body: unknown,
  ): Promise<MdfActiveProductionReturnConfirmResponseDto> {
    this.assertEnabled();
    const currentUser = requireCurrentUser(request);
    return this.corrections.confirm(
      currentUser,
      parse(sourceSchema, { kind: rawKind, id: rawId }),
      parse(confirmBodySchema, body),
      request.requestId ?? 'mdf-active-production-return-confirm',
    );
  }

  private assertEnabled(): void {
    const flags = this.runtime.getFeatureFlags();
    if (!flags.ordersEnabled || flags.ordersReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Изменения заказов недоступны');
    }
  }
}

function requireCurrentUser(request: RequestWithCurrentUser) {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректные параметры исправления МДФ');
  return result.data;
}

export type {
  MdfActiveProductionReturnConfirmRequestDto,
  MdfActiveProductionReturnPreviewRequestDto,
  MdfActiveProductionReturnSourceDto,
};
