import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { LabelTemplateStaleVersionError } from '../errors/labels.errors';
import { LabelTemplatesController } from './label-templates.controller';
import type { LabelsRuntimeConfigService } from './labels-runtime-config.service';

const user: CurrentUser = {
  id: '15',
  username: 'top',
  role: 'top_manager',
  roleId: 15,
  permissions: ['labels.view', 'labels.manage_templates', 'labels.generate'],
};

describe('LabelTemplatesController', () => {
  it('returns 503 when labels feature is disabled', async () => {
    const controller = new LabelTemplatesController(fakeService(), runtime(false));

    await expect(controller.list({ user, requestId: 'req-1' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'labels' },
    });
  });

  it('returns 401 when auth context is missing', async () => {
    const controller = new LabelTemplatesController(fakeService(), runtime(true));

    await expect(controller.list({ requestId: 'req-1' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('returns 422 for invalid create payloads', async () => {
    const controller = new LabelTemplatesController(fakeService(), runtime(true));

    await expect(controller.create({ user, requestId: 'req-1' }, { name: '' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('passes stale template errors through as 409', async () => {
    const service = fakeService({
      updateTemplate: vi.fn(async () => {
        throw new LabelTemplateStaleVersionError(1, 2);
      }),
    });
    const controller = new LabelTemplatesController(service, runtime(true));

    await expect(controller.update({ user, requestId: 'req-1' }, '1', validBody({ version: 1 }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'LABEL_TEMPLATE_VERSION_STALE',
    });
  });

  it('parses valid create payloads and calls the service', async () => {
    const service = fakeService();
    const controller = new LabelTemplatesController(service, runtime(true));

    await controller.create({ user, requestId: 'req-1' }, validBody());
    expect(service.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUser: user,
        requestId: 'req-1',
        input: expect.objectContaining({ name: 'Default', idempotencyKey: 'template-create-1' }),
      }),
    );
  });
});

function runtime(enabled: boolean): LabelsRuntimeConfigService {
  return {
    getFeatureFlags: () => ({ labelsEnabled: enabled }),
  } as LabelsRuntimeConfigService;
}

function fakeService(overrides: Record<string, unknown> = {}) {
  return {
    listTemplates: vi.fn(async () => []),
    getTemplateById: vi.fn(),
    createTemplate: vi.fn(async () => ({})),
    updateTemplate: vi.fn(async () => ({})),
    deleteTemplate: vi.fn(async () => undefined),
    ...overrides,
  } as never;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Default',
    canvasWidthMm: 84,
    canvasHeightMm: 55,
    dpi: 203,
    defaultExportFormats: ['bmp'],
    customFieldSchema: {},
    elements: [],
    idempotencyKey: 'template-create-1',
    ...overrides,
  };
}
