import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { StageAdminController } from './stage-admin.controller';
import type { StageAdminService } from './stage-admin.service';

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

describe('stage reconcile preview request validation', () => {
  const actor = {
    user: { id: '1' },
    requestId: 'E2E-stage-picker',
  } as RequestWithCurrentUser;
  function fixture() {
    const previewReconcile = vi.fn();
    return {
      previewReconcile,
      controller: new StageAdminController({
        previewReconcile,
      } as unknown as StageAdminService),
    };
  }
  it('preserves old API ascending and accepts exact normalized name and descending cursor', () => {
    const { controller, previewReconcile } = fixture();
    controller.reconcilePreview({}, actor);
    expect(previewReconcile).toHaveBeenLastCalledWith(
      0,
      25,
      { id: '1', requestId: 'E2E-stage-picker' },
      { sort: 'asc', orderId: undefined, orderName: undefined }
    );
    controller.reconcilePreview(
      { afterId: 123, sort: 'desc', orderName: ' 2947 ' },
      actor
    );
    expect(previewReconcile).toHaveBeenLastCalledWith(
      123,
      25,
      expect.anything(),
      { sort: 'desc', orderName: '2947', orderId: undefined }
    );
    controller.reconcilePreview({ orderId: 11634 }, actor);
    expect(previewReconcile).toHaveBeenLastCalledWith(
      0,
      25,
      expect.anything(),
      { sort: 'asc', orderId: 11634, orderName: undefined }
    );
  });
  it.each([
    { sort: 'desc; DROP TABLE orders' },
    { orderId: 0 },
    { orderId: -1 },
    { orderId: 1.5 },
    { orderId: Number.MAX_SAFE_INTEGER + 1 },
    { orderId: '11634' },
    { orderName: ' ' },
    { orderName: 'x'.repeat(201) },
    { orderId: 1, orderName: '1' },
    { afterId: -1 },
    { limit: 26 },
    { unknown: true },
  ])('rejects invalid or ambiguous query %j before calling service', (body) => {
    const { controller, previewReconcile } = fixture();
    expect(() => controller.reconcilePreview(body, actor)).toThrow();
    expect(previewReconcile).not.toHaveBeenCalled();
  });
});
