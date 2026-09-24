import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import {
  MdfBoardManualMoveController,
  assertMdfManualMoveAllowed,
  parseMdfManualCardId,
  parseMdfManualCardKind,
  parseMdfManualMoveBody,
} from './mdf-board-manual-move.controller';

vi.mock('@nestjs/common', () => ({
  Body: () => () => undefined,
  Controller: () => () => undefined,
  Delete: () => () => undefined,
  Get: () => () => undefined,
  Headers: () => () => undefined,
  Inject: () => () => undefined,
  Injectable: () => () => undefined,
  Optional: () => () => undefined,
  Param: () => () => undefined,
  Put: () => () => undefined,
  Req: () => () => undefined,
}));

vi.mock('@nestjs/swagger', () => ({
  ApiBearerAuth: () => () => undefined,
  ApiOperation: () => () => undefined,
  ApiHeader: () => () => undefined,
  ApiResponse: () => () => undefined,
  ApiTags: () => () => undefined,
}));

vi.mock('@nestjs/config', () => ({
  ConfigService: class ConfigService {},
}));

describe('MdfBoardManualMoveController parsing', () => {
  it('passes the active source token and idempotency key for both move and clear', async () => {
    const service = { upsert: vi.fn(),delete: vi.fn() };
    const controller = new MdfBoardManualMoveController(
      service as unknown as ConstructorParameters<typeof MdfBoardManualMoveController>[0],
      { getFeatureFlags: () => ({ ordersEnabled: true }) } as ConstructorParameters<typeof MdfBoardManualMoveController>[1]);
    const request = { user: { id: '1',username: 'test',role: 'admin',permissions: [] },requestId: 'request' } as Parameters<typeof controller.upsert>[0];
    await controller.upsert(request,'packet','packet-1',{ targetColumn: 'completed' },'token','move-key');
    expect(service.upsert).toHaveBeenCalledWith(expect.objectContaining({ sourceToken: 'token',idempotencyKey: 'move-key' }));
    await controller.delete(request,'packet','packet-1','token','clear-key');
    expect(service.delete).toHaveBeenCalledWith(expect.objectContaining({ sourceToken: 'token',idempotencyKey: 'clear-key' }));
  });
  it('accepts safe card identities and strict move bodies', () => {
    expect(parseMdfManualCardKind('packet')).toBe('packet');
    expect(parseMdfManualCardKind('bazisCutSet')).toBe('bazisCutSet');
    expect(parseMdfManualCardId('cut-result%3A42')).toBe('cut-result:42');
    expect(parseMdfManualMoveBody({ targetColumn: 'completed_laminated' })).toBe('completed_laminated');
    expect(parseMdfManualMoveBody({ targetColumn: 'completed_baths' })).toBe('completed_baths');
  });

  it('rejects unsafe identities and extra payload fields', () => {
    expect(() => parseMdfManualCardKind('telegram')).toThrow(ApiError);
    expect(() => parseMdfManualCardId('../secret')).toThrow(ApiError);
    expect(() => parseMdfManualCardId('')).toThrow(ApiError);
    expect(() => parseMdfManualCardId('%E0%A4%A')).toThrow(ApiError);
    expect(() => parseMdfManualMoveBody({ targetColumn: 'completed', stale: true })).toThrow(ApiError);
    expect(() => parseMdfManualMoveBody({ targetColumn: 'baths_done' })).toThrow(ApiError);
  });

  it('keeps the card kind to target column matrix explicit', () => {
    expect(() => assertMdfManualMoveAllowed('packet', 'completed')).not.toThrow();
    expect(() => assertMdfManualMoveAllowed('bazisCutSet', 'completed_laminated')).not.toThrow();
    expect(() => assertMdfManualMoveAllowed('bath', 'baths_ready')).not.toThrow();
    expect(() => assertMdfManualMoveAllowed('bath', 'completed_baths')).not.toThrow();
    expect(() => assertMdfManualMoveAllowed('order', 'orders_issued')).toThrowError(
      expect.objectContaining({ code: 'MDF_ORDER_MOVE_REQUIRES_STATUS_CHANGE' }),
    );

    expect(() => assertMdfManualMoveAllowed('packet', 'baths_ready')).toThrow(ApiError);
    expect(() => assertMdfManualMoveAllowed('bath', 'orders_ready')).toThrow(ApiError);
    expect(() => assertMdfManualMoveAllowed('order', 'completed')).toThrow(ApiError);
  });
});
