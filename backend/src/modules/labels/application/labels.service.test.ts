import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { LabelsPort, LabelTemplateInput } from './labels.types';
import { LabelsService } from './labels.service';

const manager: CurrentUser = {
  id: '10',
  username: 'manager',
  role: 'manager',
  roleId: 10,
  permissions: ['labels.view', 'labels.generate'],
};

const templateManager: CurrentUser = {
  ...manager,
  permissions: ['labels.view', 'labels.manage_templates', 'labels.generate'],
};

describe('LabelsService', () => {
  it('enforces labels.view for reads', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });

    await expect(
      service.listTemplates({ currentUser: { ...manager, permissions: [] }, requestId: 'req-1' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(repo.recordPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermissions: ['labels.view'] }),
    );

    await expect(service.listTemplates({ currentUser: manager, requestId: 'req-2' })).resolves.toEqual([]);
  });

  it('routes label field catalog denials through denied audit', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });

    await expect(service.listFields({ currentUser: { ...manager, permissions: [] }, requestId: 'req-fields' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(repo.recordPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermissions: ['labels.view'], requestId: 'req-fields' }),
    );
  });

  it('enforces labels.manage_templates for template writes', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });

    await expect(
      service.createTemplate({ currentUser: manager, requestId: 'req-1', input: validInput() }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

    await service.createTemplate({ currentUser: templateManager, requestId: 'req-2', input: validInput() });
    expect(repo.createTemplate).toHaveBeenCalledOnce();
  });

  it('rejects unsupported field bindings before repository writes', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      elements: [
        {
          elementKey: 'bad',
          kind: 'text',
          sourceField: 'bazis.missing',
          xMm: 0,
          yMm: 0,
          widthMm: 20,
          heightMm: 5,
        },
      ],
    });

    await expect(
      service.createTemplate({ currentUser: templateManager, requestId: 'req-1', input }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'LABEL_FIELD_BINDING_INVALID' });
    expect(repo.createTemplate).not.toHaveBeenCalled();
  });

  it('rejects invalid qr placeholders before create template repository writes', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      elements: [
        {
          elementKey: 'qr-invalid',
          kind: 'qr',
          xMm: 0,
          yMm: 0,
          widthMm: 20,
          heightMm: 20,
          style: { qrTemplate: '{unknown.field}' },
        },
      ],
    });

    await expect(
      service.createTemplate({ currentUser: templateManager, requestId: 'req-qr-create', input }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'LABEL_FIELD_BINDING_INVALID',
      details: { fieldBinding: 'unknown.field' },
    });
    expect(repo.createTemplate).not.toHaveBeenCalled();
  });

  it('rejects empty qr templates before update template repository writes', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      elements: [
        {
          elementKey: 'qr-empty',
          kind: 'qr',
          xMm: 0,
          yMm: 0,
          widthMm: 20,
          heightMm: 20,
          style: { qrTemplate: '   ' },
        },
      ],
    });

    await expect(
      service.updateTemplate({
        currentUser: templateManager,
        requestId: 'req-qr-update',
        id: 7,
        expectedVersion: 3,
        input,
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'LABEL_QR_TEMPLATE_EMPTY',
      details: { elementIndex: 0 },
    });
    expect(repo.updateTemplate).not.toHaveBeenCalled();
  });

  it('rejects a placed qr element with an empty name before create template repository writes', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      elements: [
        {
          elementKey: 'qr-noname',
          kind: 'qr',
          xMm: 0,
          yMm: 0,
          widthMm: 20,
          heightMm: 20,
          style: { qrTemplate: '{bazis.detail_id}', qrName: '' },
        },
      ],
    });

    await expect(
      service.createTemplate({ currentUser: templateManager, requestId: 'req-qr-name-required', input }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'LABEL_QR_NAME_REQUIRED',
    });
    expect(repo.createTemplate).not.toHaveBeenCalled();
  });

  it('rejects placed qr elements whose names collide case-insensitively before create template repository writes', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      elements: [
        {
          elementKey: 'qr-a',
          kind: 'qr',
          xMm: 0,
          yMm: 0,
          widthMm: 20,
          heightMm: 20,
          style: { qrTemplate: '{bazis.detail_id}', qrName: 'A' },
        },
        {
          elementKey: 'qr-b',
          kind: 'qr',
          xMm: 25,
          yMm: 0,
          widthMm: 20,
          heightMm: 20,
          style: { qrTemplate: '{bazis.detail_id}', qrName: 'a' },
        },
      ],
    });

    await expect(
      service.createTemplate({ currentUser: templateManager, requestId: 'req-qr-name-duplicate', input }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'LABEL_QR_NAME_DUPLICATE',
    });
    expect(repo.createTemplate).not.toHaveBeenCalled();
  });

  it('accepts custom schema bindings from the same template input', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      customFieldSchema: { 'custom.operator_note': { type: 'string' } },
      elements: [
        {
          elementKey: 'custom-note',
          kind: 'text',
          sourceField: 'custom.operator_note',
          xMm: 0,
          yMm: 0,
          widthMm: 20,
          heightMm: 5,
        },
      ],
    });

    await service.createTemplate({ currentUser: templateManager, requestId: 'req-1', input });
    expect(repo.createTemplate).toHaveBeenCalledOnce();
  });

  it('accepts detail and order field bindings and custom field source mappings', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      customFieldSchema: {
        'custom.client': { type: 'string', sourceField: 'order.client_name' },
      },
      elements: [
        {
          elementKey: 'detail-name',
          kind: 'text',
          sourceField: 'detail.detail_name',
          xMm: 0,
          yMm: 0,
          widthMm: 20,
          heightMm: 5,
        },
        {
          elementKey: 'custom-client',
          kind: 'text',
          sourceField: 'custom.client',
          xMm: 0,
          yMm: 6,
          widthMm: 20,
          heightMm: 5,
        },
      ],
    });

    await service.createTemplate({ currentUser: templateManager, requestId: 'req-1', input });
    expect(repo.createTemplate).toHaveBeenCalledOnce();
  });

  it('rejects custom field source mappings outside the label field catalog', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      customFieldSchema: {
        'custom.bad': { type: 'string', sourceField: 'orders.raw_sql' },
      },
    });

    await expect(
      service.createTemplate({ currentUser: templateManager, requestId: 'req-1', input }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'LABEL_FIELD_BINDING_INVALID' });
    expect(repo.createTemplate).not.toHaveBeenCalled();
  });

  it('allows labels.view to read latest preview but requires labels.generate for ZIP export', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });

    await service.getLatestOrderLabelsPreview({
      currentUser: { ...manager, permissions: ['labels.view'] },
      requestId: 'req-1',
      orderId: 42,
    });
    expect(repo.getLatestOrderLabelsPreview).toHaveBeenCalledOnce();

    await expect(
      service.exportOrderLabels({
        currentUser: { ...manager, permissions: ['labels.view'] },
        requestId: 'req-2',
        orderId: 42,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(repo.recordPermissionDenied).toHaveBeenLastCalledWith(expect.objectContaining({ targetEntityType: 'order' }));
  });

  it('supports labels preview/generate/export for explicit details across orders', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });

    await service.previewDetailLabels({
      currentUser: { ...manager, permissions: ['labels.view'] },
      requestId: 'req-preview',
      input: { templateId: 1, templateVersion: 1, detailIds: [101, 202] },
    });
    expect(repo.previewDetailLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ detailIds: [101, 202] }),
      }),
    );

    await service.generateDetailLabels({
      currentUser: manager,
      requestId: 'req-generate',
      input: {
        templateId: 1,
        templateVersion: 1,
        detailIds: [101, 202],
        previewToken: 'detail-preview-token-12345',
        exportFormats: ['bmp'],
        idempotencyKey: 'detail-labels-generate-1',
      },
    });
    expect(repo.generateDetailLabels).toHaveBeenCalledOnce();

    await service.exportDetailLabels({
      currentUser: manager,
      requestId: 'req-export',
      generationId: 9,
    });
    expect(repo.exportDetailLabels).toHaveBeenCalledWith(expect.objectContaining({ generationId: 9 }));
  });
});

function validInput(overrides: Partial<LabelTemplateInput> = {}): LabelTemplateInput {
  return {
    name: 'Default',
    canvasWidthMm: 84,
    canvasHeightMm: 55,
    dpi: 203,
    defaultExportFormats: ['bmp'],
    customFieldSchema: {},
    elements: [
      {
        elementKey: 'order',
        kind: 'text',
        sourceField: 'bazis.order_number',
        xMm: 1,
        yMm: 1,
        widthMm: 20,
        heightMm: 5,
      },
    ],
    idempotencyKey: 'template-create-1',
    ...overrides,
  };
}

function fakeRepo(): LabelsPort {
  return {
    listTemplates: vi.fn(async () => []),
    getTemplateById: vi.fn(),
    createTemplate: vi.fn(async () => ({
      labelTemplateId: 1,
      name: 'Default',
      description: null,
      version: 1,
      isActive: true,
      canvasWidthMm: 84,
      canvasHeightMm: 55,
      dpi: 203,
      defaultExportFormats: ['bmp'],
      customFieldSchema: {},
      elements: [],
    })),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    getOrderLabelData: vi.fn(),
    updateOrderLabelData: vi.fn(),
    previewOrderLabels: vi.fn(),
    generateOrderLabels: vi.fn(),
    previewDetailLabels: vi.fn(async () => ({
      generationScope: 'details',
      templateId: 1,
      templateVersion: 1,
      labelCount: 2,
      rows: [],
      svgPages: [],
      previewToken: 'detail-preview-token-12345',
    })),
    generateDetailLabels: vi.fn(async () => ({
      generationId: 9,
      orderId: null,
      templateId: 1,
      templateVersion: 1,
      labelCount: 2,
      generatedAt: '2026-06-24T00:00:00.000Z',
    })),
    getLatestOrderLabelsPreview: vi.fn(async () => ({
      generationId: 1,
      orderId: 42,
      templateId: 1,
      templateVersion: 1,
      labelCount: 1,
      generatedAt: '2026-06-24T00:00:00.000Z',
      svgPages: [],
    })),
    exportOrderLabels: vi.fn(),
    exportDetailLabels: vi.fn(async () => ({
      filename: 'labels-generation-9.zip',
      contentType: 'application/zip',
      body: Buffer.from('zip'),
    })),
    recordPermissionDenied: vi.fn(async () => undefined),
  };
}
