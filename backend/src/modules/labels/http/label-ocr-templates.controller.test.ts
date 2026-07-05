import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { LabelOcrTemplatesController } from './label-ocr-templates.controller';
import type { LabelsRuntimeConfigService } from './labels-runtime-config.service';

const user: CurrentUser = {
  id: '15',
  username: 'top',
  role: 'top_manager',
  roleId: 15,
  permissions: ['labels.view', 'labels.manage_templates'],
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const NON_IMAGE_BUFFER = Buffer.from('<script>alert(1)</script>');

const validRules = [
  { field: 'order_number', sampleText: '12345' },
  { field: 'dimensions', sampleText: '500x300' },
];

describe('LabelOcrTemplatesController', () => {
  it('returns 503 when labels feature is disabled', async () => {
    const controller = new LabelOcrTemplatesController(fakeService(), runtime(false));

    await expect(controller.list({ user, requestId: 'req-1' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'labels' },
    });
  });

  it('returns 401 when auth context is missing', async () => {
    const controller = new LabelOcrTemplatesController(fakeService(), runtime(true));

    await expect(controller.list({ requestId: 'req-1' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('list delegates with includeInactive parsed', async () => {
    const service = fakeService();
    const controller = new LabelOcrTemplatesController(service, runtime(true));

    await controller.list({ user, requestId: 'req-1' }, 'true');
    expect(service.listOcrTemplates).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser: user, requestId: 'req-1', includeInactive: true }),
    );

    await controller.list({ user, requestId: 'req-1' });
    expect(service.listOcrTemplates).toHaveBeenCalledWith(
      expect.objectContaining({ includeInactive: false }),
    );
  });

  it('create parses body and delegates', async () => {
    const service = fakeService();
    const controller = new LabelOcrTemplatesController(service, runtime(true));

    await controller.create({ user, requestId: 'req-1' }, validBody());
    expect(service.createOcrTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUser: user,
        requestId: 'req-1',
        input: expect.objectContaining({ name: 'Default template', idempotencyKey: 'ocr-template-create-1' }),
      }),
    );
  });

  it('returns 422 for invalid create payloads', async () => {
    const controller = new LabelOcrTemplatesController(fakeService(), runtime(true));

    await expect(controller.create({ user, requestId: 'req-1' }, { name: '' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('update splits version from input and passes expectedVersion', async () => {
    const service = fakeService();
    const controller = new LabelOcrTemplatesController(service, runtime(true));

    await controller.update({ user, requestId: 'req-1' }, '7', validBody({ version: 3 }));
    expect(service.updateOcrTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUser: user,
        requestId: 'req-1',
        id: 7,
        expectedVersion: 3,
        input: expect.objectContaining({ name: 'Default template' }),
      }),
    );
    const call = service.updateOcrTemplate.mock.calls[0][0];
    expect(call.input).not.toHaveProperty('version');
  });

  it('delete passes version + idempotencyKey', async () => {
    const service = fakeService();
    const controller = new LabelOcrTemplatesController(service, runtime(true));

    await controller.delete({ user, requestId: 'req-1' }, '9', {
      version: 2,
      idempotencyKey: 'ocr-template-delete-1',
    });
    expect(service.deleteOcrTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUser: user,
        requestId: 'req-1',
        id: 9,
        expectedVersion: 2,
        idempotencyKey: 'ocr-template-delete-1',
      }),
    );
  });

  it('preview delegates to service.previewOcrLabel with sniffed contentType', async () => {
    const service = fakeService();
    const controller = new LabelOcrTemplatesController(service, runtime(true));
    const file = { buffer: PNG_MAGIC, mimetype: 'application/octet-stream', originalname: 'label.png', size: PNG_MAGIC.length };

    await controller.preview({ user, requestId: 'req-1' }, file);
    expect(service.previewOcrLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUser: user,
        requestId: 'req-1',
        image: PNG_MAGIC,
        contentType: 'image/png',
      }),
    );
  });

  it('preview returns 415 for a non-image buffer regardless of client mimetype', async () => {
    const controller = new LabelOcrTemplatesController(fakeService(), runtime(true));
    const file = { buffer: NON_IMAGE_BUFFER, mimetype: 'image/png', originalname: 'fake.png', size: NON_IMAGE_BUFFER.length };

    await expect(controller.preview({ user, requestId: 'req-1' }, file)).rejects.toMatchObject({
      statusCode: 415,
      code: 'UNSUPPORTED_IMAGE_TYPE',
    });
  });

  it('preview returns 422 when no file is uploaded', async () => {
    const controller = new LabelOcrTemplatesController(fakeService(), runtime(true));

    await expect(controller.preview({ user, requestId: 'req-1' }, undefined)).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('test parses rules JSON and delegates to service.testOcrTemplate', async () => {
    const service = fakeService();
    const controller = new LabelOcrTemplatesController(service, runtime(true));
    const file = { buffer: PNG_MAGIC, mimetype: 'application/octet-stream', originalname: 'label.png', size: PNG_MAGIC.length };

    await controller.test({ user, requestId: 'req-1' }, file, JSON.stringify(validRules));
    expect(service.testOcrTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUser: user,
        requestId: 'req-1',
        image: PNG_MAGIC,
        contentType: 'image/png',
        rules: validRules,
      }),
    );
  });

  it('test returns 400 for malformed rules JSON', async () => {
    const controller = new LabelOcrTemplatesController(fakeService(), runtime(true));
    const file = { buffer: PNG_MAGIC, mimetype: 'application/octet-stream', originalname: 'label.png', size: PNG_MAGIC.length };

    await expect(controller.test({ user, requestId: 'req-1' }, file, '{not-json')).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('test returns 422 for rules JSON that fails schema validation', async () => {
    const controller = new LabelOcrTemplatesController(fakeService(), runtime(true));
    const file = { buffer: PNG_MAGIC, mimetype: 'application/octet-stream', originalname: 'label.png', size: PNG_MAGIC.length };

    await expect(
      controller.test({ user, requestId: 'req-1' }, file, JSON.stringify([{ field: 'not_a_real_field' }])),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('test returns 415 for a non-image buffer before touching rules', async () => {
    const controller = new LabelOcrTemplatesController(fakeService(), runtime(true));
    const file = { buffer: NON_IMAGE_BUFFER, mimetype: 'image/png', originalname: 'fake.png', size: NON_IMAGE_BUFFER.length };

    await expect(controller.test({ user, requestId: 'req-1' }, file, JSON.stringify(validRules))).rejects.toMatchObject({
      statusCode: 415,
      code: 'UNSUPPORTED_IMAGE_TYPE',
    });
  });
});

function runtime(enabled: boolean): LabelsRuntimeConfigService {
  return {
    getFeatureFlags: () => ({ labelsEnabled: enabled }),
  } as LabelsRuntimeConfigService;
}

function fakeService(overrides: Record<string, unknown> = {}) {
  return {
    listOcrTemplates: vi.fn(async () => []),
    createOcrTemplate: vi.fn(async () => ({})),
    updateOcrTemplate: vi.fn(async () => ({})),
    deleteOcrTemplate: vi.fn(async () => undefined),
    previewOcrLabel: vi.fn(async () => ({ lines: [], durationMs: 1 })),
    testOcrTemplate: vi.fn(async () => ({ lines: [], matched: { templateWon: false, score: 0, fields: {} }, fallbackFields: {} })),
    ...overrides,
  } as never;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Default template',
    rules: validRules,
    sampleLines: [],
    isActive: true,
    idempotencyKey: 'ocr-template-create-1',
    ...overrides,
  };
}
