import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { ApiError } from '../../../common/errors/api-error';
import { DetailLabelActionsController, OrderLabelActionsController } from './order-labels.controller';
import type { LabelsRuntimeConfigService } from './labels-runtime-config.service';

const user: CurrentUser = {
  id: '15',
  username: 'top',
  role: 'top_manager',
  roleId: 15,
  permissions: ['labels.view', 'labels.generate'],
};

describe('DetailLabelActionsController', () => {
  it('parses multi-order detail label preview payloads and calls the service', async () => {
    const service = fakeService();
    const controller = new DetailLabelActionsController(service, runtime(true));

    await controller.preview(
      { user, requestId: 'req-preview' },
      {
        templateId: 1,
        templateVersion: 2,
        detailIds: [101, 202],
        useBasisFields: false,
        detailInstances: [{ detailId: 101, instance: 1 }],
        cutMapFallbackImage: {
          packetId: '11111111-1111-4111-8111-111111111111',
          sourceVersion: 1,
          storageKey: 'sheet.jpg',
        },
      },
    );

    expect(service.previewDetailLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUser: user,
        requestId: 'req-preview',
        input: expect.objectContaining({
          templateId: 1,
          templateVersion: 2,
          detailIds: [101, 202],
          useBasisFields: false,
          detailInstances: [{ detailId: 101, instance: 1 }],
          cutMapFallbackImage: expect.objectContaining({ storageKey: 'sheet.jpg' }),
        }),
      }),
    );
  });

  it('exports a detail label generation without an order id path segment', async () => {
    const service = fakeService();
    const controller = new DetailLabelActionsController(service, runtime(true));
    const response = { setHeader: vi.fn() };

    await controller.exportGeneration({ user, requestId: 'req-export' }, '9', response as never);

    expect(service.exportDetailLabels).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser: user, requestId: 'req-export', generationId: 9 }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      "attachment; filename=\"labels-generation-9.zip\"; filename*=UTF-8''labels-generation-9.zip",
    );
  });
});

describe('OrderLabelActionsController', () => {
  it('routes cut-map options through the order-scoped service contract', async () => {
    const service = fakeService({
      listOrderCutMapOptions: vi.fn(async () => ({ orderId: 11370, details: [] })),
    });
    const controller = new OrderLabelActionsController(service, runtime(true));

    await expect(controller.cutMapOptions({ user, requestId: 'req-cut-map' }, '11370'))
      .resolves.toEqual({ orderId: 11370, details: [] });
    expect(service.listOrderCutMapOptions).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser: user, requestId: 'req-cut-map', orderId: 11370 }),
    );
  });

  it('returns null when an order has no previous label generation', async () => {
    const service = fakeService({
      getLatestOrderLabelsPreview: vi.fn(async () => {
        throw new ApiError(404, 'ORDER_LABEL_GENERATION_NOT_FOUND', 'Order label generation not found');
      }),
    });
    const controller = new OrderLabelActionsController(service, runtime(true));

    await expect(controller.latest({ user, requestId: 'req-latest' }, '11370')).resolves.toBeNull();
  });

  it('uses RFC 5987 encoding for Unicode order label archive names', async () => {
    const service = fakeService({
      exportOrderLabels: vi.fn(async () => ({
        filename: 'заказ-Кухня № 7-бирки-22.zip',
        contentType: 'application/zip',
        body: Buffer.from('zip'),
      })),
    });
    const controller = new OrderLabelActionsController(service, runtime(true));
    const response = { setHeader: vi.fn() };

    await controller.exportGeneration({ user, requestId: 'req-export' }, '11370', '22', response as never);

    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringContaining("filename*=UTF-8''%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7-%D0%9A%D1%83%D1%85%D0%BD%D1%8F%20%E2%84%96%207-%D0%B1%D0%B8%D1%80%D0%BA%D0%B8-22.zip"),
    );
  });

  it('does not hide unrelated latest-preview errors', async () => {
    const denied = new ApiError(403, 'PERMISSION_DENIED', 'Permission denied');
    const service = fakeService({ getLatestOrderLabelsPreview: vi.fn(async () => { throw denied; }) });
    const controller = new OrderLabelActionsController(service, runtime(true));

    await expect(controller.latest({ user, requestId: 'req-latest' }, '11370')).rejects.toBe(denied);
  });
});

function fakeService(overrides: Record<string, unknown> = {}) {
  return {
    previewDetailLabels: vi.fn(async () => ({
      generationScope: 'details',
      templateId: 1,
      templateVersion: 2,
      labelCount: 2,
      rows: [],
      svgPages: [],
      previewToken: 'detail-preview-token-12345',
    })),
    generateDetailLabels: vi.fn(async () => ({
      generationId: 9,
      orderId: null,
      templateId: 1,
      templateVersion: 2,
      labelCount: 2,
      generatedAt: '2026-06-24T00:00:00.000Z',
    })),
    exportDetailLabels: vi.fn(async () => ({
      filename: 'labels-generation-9.zip',
      contentType: 'application/zip',
      body: Buffer.from('zip'),
    })),
    getLatestOrderLabelsPreview: vi.fn(),
    exportOrderLabels: vi.fn(),
    listOrderCutMapOptions: vi.fn(),
    ...overrides,
  } as never;
}

function runtime(enabled: boolean): LabelsRuntimeConfigService {
  return {
    getFeatureFlags: () => ({ labelsEnabled: enabled }),
  } as LabelsRuntimeConfigService;
}
