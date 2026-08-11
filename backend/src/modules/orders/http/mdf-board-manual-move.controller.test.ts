import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import {
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
  Inject: () => () => undefined,
  Injectable: () => () => undefined,
  Param: () => () => undefined,
  Put: () => () => undefined,
  Req: () => () => undefined,
}));

vi.mock('@nestjs/swagger', () => ({
  ApiBearerAuth: () => () => undefined,
  ApiOperation: () => () => undefined,
  ApiResponse: () => () => undefined,
  ApiTags: () => () => undefined,
}));

vi.mock('@nestjs/config', () => ({
  ConfigService: class ConfigService {},
}));

describe('MdfBoardManualMoveController parsing', () => {
  it('accepts safe card identities and strict move bodies', () => {
    expect(parseMdfManualCardKind('packet')).toBe('packet');
    expect(parseMdfManualCardKind('bazisCutSet')).toBe('bazisCutSet');
    expect(parseMdfManualCardId('cut-result%3A42')).toBe('cut-result:42');
    expect(parseMdfManualMoveBody({ targetColumn: 'completed_laminated' })).toBe('completed_laminated');
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
    expect(() => assertMdfManualMoveAllowed('order', 'orders_issued')).not.toThrow();

    expect(() => assertMdfManualMoveAllowed('packet', 'baths_ready')).toThrow(ApiError);
    expect(() => assertMdfManualMoveAllowed('bath', 'orders_ready')).toThrow(ApiError);
    expect(() => assertMdfManualMoveAllowed('order', 'completed')).toThrow(ApiError);
  });
});
