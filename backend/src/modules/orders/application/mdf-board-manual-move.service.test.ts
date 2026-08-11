import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { MdfBoardManualMoveService } from './mdf-board-manual-move.service';
import type { MdfBoardManualMoveRepositoryPort } from './mdf-board-manual-move.types';

vi.mock('@nestjs/common', () => ({
  Injectable: () => () => undefined,
}));

describe('MdfBoardManualMoveService', () => {
  it('uses production task permissions, not order visibility, for shared MDF manual moves', async () => {
    const moves: MdfBoardManualMoveRepositoryPort = {
      list: vi.fn().mockResolvedValue({ generatedAt: now(), moves: [] }),
      upsert: vi.fn().mockResolvedValue({ generatedAt: now(), changed: false, move: move() }),
      delete: vi.fn().mockResolvedValue({ generatedAt: now(), cardKind: 'packet', cardId: 'p1', deleted: false }),
    };
    const service = new MdfBoardManualMoveService({ moves });

    await expect(service.list({ currentUser: user(['production.tasks.view']) })).resolves.toMatchObject({ moves: [] });
    await expect(service.upsert({
      currentUser: user(['production.tasks.update']),
      cardKind: 'packet',
      cardId: 'p1',
      targetColumn: 'completed',
    })).resolves.toMatchObject({ changed: false });
    await expect(service.delete({
      currentUser: user(['production.tasks.update']),
      cardKind: 'packet',
      cardId: 'p1',
    })).resolves.toMatchObject({ deleted: false });

    await expect(service.list({ currentUser: user(['orders.view']) })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
    await expect(service.upsert({
      currentUser: user(['production.tasks.view']),
      cardKind: 'packet',
      cardId: 'p1',
      targetColumn: 'completed',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
  });
});

function user(permissions: CurrentUser['permissions']): CurrentUser {
  return {
    id: '7',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions,
  };
}

function move() {
  return {
    cardKind: 'packet' as const,
    cardId: 'p1',
    targetColumn: 'completed' as const,
    version: 1,
    createdAt: now(),
    createdByUserId: 7,
    updatedAt: now(),
    updatedByUserId: 7,
  };
}

function now(): string {
  return '2026-08-11T00:00:00.000Z';
}
