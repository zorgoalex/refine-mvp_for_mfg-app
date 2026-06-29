import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { DetailLabelActionsController } from './order-labels.controller';
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
      { templateId: 1, templateVersion: 2, detailIds: [101, 202], useBasisFields: false },
    );

    expect(service.previewDetailLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUser: user,
        requestId: 'req-preview',
        input: { templateId: 1, templateVersion: 2, detailIds: [101, 202], useBasisFields: false },
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
    expect(response.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="labels-generation-9.zip"');
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
    ...overrides,
  } as never;
}

function runtime(enabled: boolean): LabelsRuntimeConfigService {
  return {
    getFeatureFlags: () => ({ labelsEnabled: enabled }),
  } as LabelsRuntimeConfigService;
}
