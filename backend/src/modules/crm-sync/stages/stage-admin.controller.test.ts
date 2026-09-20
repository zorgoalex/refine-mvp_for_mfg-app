import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { PermissionsService } from '../../../permissions/permissions.service';
import { StageAdminController } from './stage-admin.controller';

describe('stage admin permission and validation contract', () => {
  const controller = new StageAdminController({
    previewSettings: vi.fn(),
    applyReconcile: vi.fn(),
  } as never);
  const guard = new PermissionsGuard(new Reflector(), new PermissionsService());
  const context = (user: unknown) => ({
    getClass: () => StageAdminController,
    getHandler: () => controller.state,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  });
  it('denies anonymous and ordinary managers before any stage reads/writes', () => {
    expect(() => guard.canActivate(context(undefined) as never)).toThrow();
    expect(() =>
      guard.canActivate(
        context({ id: '1', role: 'manager', permissions: [] }) as never
      )
    ).toThrow();
    expect(
      guard.canActivate(
        context({
          id: '1',
          role: 'admin',
          permissions: ['bitrix24.integration.manage'],
        }) as never
      )
    ).toBe(true);
  });
  it('validates bounded selections, UUID previews, and rejects unknown config fields', () => {
    expect(() =>
      controller.reconcileApply('bad', { orderIds: ['1'] }, {} as never)
    ).toThrow();
    expect(() =>
      controller.reconcileApply(
        '11111111-1111-4111-8111-111111111111',
        { orderIds: Array(26).fill('1') },
        {} as never
      )
    ).toThrow();
    expect(() =>
      controller.settingsPreview(
        {
          version: 1,
          categoryId: 0,
          completedStatusId: 8,
          enabled: true,
          mappings: [],
          portal: 'foreign',
        },
        {} as never
      )
    ).toThrow();
  });
});
