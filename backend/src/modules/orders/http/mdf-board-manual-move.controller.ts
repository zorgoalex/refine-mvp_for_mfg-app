import { Body, Controller, Delete, Get, Inject, Param, Put, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { MdfBoardManualMoveService } from '../application/mdf-board-manual-move.service';
import type {
  MdfBoardManualCardKind,
  MdfBoardManualMoveDeleteResponseDto,
  MdfBoardManualMovesResponseDto,
  MdfBoardManualMoveUpsertResponseDto,
  MdfBoardManualTargetColumn,
} from '../dto/mdf-board-manual-move.dto';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const CARD_ID_RE = /^[A-Za-z0-9._:-]{1,240}$/;

const moveBodySchema = z.object({
  targetColumn: z.enum([
    'parsed',
    'completed',
    'completed_laminated',
    'baths',
    'baths_ready',
    'baths_laminated',
    'orders',
    'orders_ready',
    'orders_issued',
  ]),
}).strict();

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders/status-board/mdf-manual-moves')
export class MdfBoardManualMoveController {
  constructor(
    @Inject(MdfBoardManualMoveService)
    private readonly moves: MdfBoardManualMoveService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiOperation({
    operationId: 'listMdfBoardManualMoves',
    summary: 'List shared manual card placements for the MDF work board',
  })
  @ApiResponse({ status: 200, description: 'Shared MDF board manual moves' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @Get()
  list(
    @Req() request: RequestWithCurrentUser,
  ): Promise<MdfBoardManualMovesResponseDto> {
    this.assertEnabled();
    const currentUser = requireCurrentUser(request);
    return this.moves.list({
      currentUser,
      requestId: request.requestId,
    });
  }

  @ApiOperation({
    operationId: 'upsertMdfBoardManualMove',
    summary: 'Create or update a shared manual MDF board card placement',
  })
  @ApiResponse({ status: 200, description: 'Manual move saved' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid card kind, card id, or target column' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @Put(':cardKind/:cardId')
  upsert(
    @Req() request: RequestWithCurrentUser,
    @Param('cardKind') rawKind: string,
    @Param('cardId') rawCardId: string,
    @Body() body: unknown,
  ): Promise<MdfBoardManualMoveUpsertResponseDto> {
    this.assertEnabled();
    const currentUser = requireCurrentUser(request);
    const cardKind = parseMdfManualCardKind(rawKind);
    const cardId = parseMdfManualCardId(rawCardId);
    const targetColumn = parseMdfManualMoveBody(body);
    assertMdfManualMoveAllowed(cardKind, targetColumn);
    return this.moves.upsert({
      currentUser,
      cardKind,
      cardId,
      targetColumn,
      requestId: request.requestId,
    });
  }

  @ApiOperation({
    operationId: 'deleteMdfBoardManualMove',
    summary: 'Clear a shared manual MDF board card placement',
  })
  @ApiResponse({ status: 200, description: 'Manual move cleared or already absent' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid card kind or card id' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @Delete(':cardKind/:cardId')
  delete(
    @Req() request: RequestWithCurrentUser,
    @Param('cardKind') rawKind: string,
    @Param('cardId') rawCardId: string,
  ): Promise<MdfBoardManualMoveDeleteResponseDto> {
    this.assertEnabled();
    const currentUser = requireCurrentUser(request);
    return this.moves.delete({
      currentUser,
      cardKind: parseMdfManualCardKind(rawKind),
      cardId: parseMdfManualCardId(rawCardId),
      requestId: request.requestId,
    });
  }

  private assertEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
      });
    }
  }
}

export function parseMdfManualCardKind(value: string): MdfBoardManualCardKind {
  if (
    value === 'packet'
    || value === 'bazisCutSet'
    || value === 'bath'
    || value === 'order'
  ) {
    return value;
  }
  throw validationError('cardKind', 'cardKind must be packet, bazisCutSet, bath, or order');
}

export function parseMdfManualCardId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    throw validationError('cardId', 'cardId must be valid URI text');
  }
  if (!CARD_ID_RE.test(decoded)) {
    throw validationError('cardId', 'cardId must be 1-240 safe characters');
  }
  return decoded;
}

export function parseMdfManualMoveBody(body: unknown): MdfBoardManualTargetColumn {
  const parsed = moveBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid MDF board manual move payload', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data.targetColumn;
}

export function assertMdfManualMoveAllowed(
  cardKind: MdfBoardManualCardKind,
  targetColumn: MdfBoardManualTargetColumn,
): void {
  if (
    (cardKind === 'packet' || cardKind === 'bazisCutSet')
    && (targetColumn === 'parsed' || targetColumn === 'completed' || targetColumn === 'completed_laminated')
  ) {
    return;
  }
  if (
    cardKind === 'bath'
    && (targetColumn === 'baths' || targetColumn === 'baths_ready' || targetColumn === 'baths_laminated')
  ) {
    return;
  }
  if (
    cardKind === 'order'
    && (targetColumn === 'orders' || targetColumn === 'orders_ready' || targetColumn === 'orders_issued')
  ) {
    return;
  }
  throw validationError('targetColumn', 'targetColumn is not allowed for this cardKind');
}

function requireCurrentUser(request: RequestWithCurrentUser) {
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return request.user;
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { field });
}
