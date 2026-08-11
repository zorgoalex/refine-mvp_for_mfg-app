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

  it('returns renderer capabilities independently of the template list', async () => {
    const service = new LabelsService({ repo: fakeRepo() });

    await expect(service.getRendererCapabilities({ currentUser: manager, requestId: 'req-capabilities' }))
      .resolves.toEqual({
        rendererCapabilities: ['if_else_v1', 'typography_v1', 'cut_map_v1', 'cut_map_flip_v1', 'custom_expression_v1'],
      });
  });

  it('exposes and snapshots new detail columns from the live view schema', async () => {
    const repo = fakeRepo();
    vi.mocked(repo.listDetailFieldColumns).mockResolvedValue([
      { columnName: 'detail_id', dataType: 'bigint' },
      { columnName: 'future_metric', dataType: 'numeric' },
    ]);
    const service = new LabelsService({ repo });

    await expect(service.listFields({ currentUser: manager, requestId: 'req-fields-live' })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'detail.future_metric', type: 'number' })]),
    );

    await service.createTemplate({
      currentUser: templateManager,
      requestId: 'req-template-live',
      input: validInput({
        elements: [{
          elementKey: 'future',
          kind: 'text',
          sourceField: 'detail.future_metric',
          xMm: 1,
          yMm: 1,
          widthMm: 20,
          heightMm: 5,
        }],
      }),
    });

    expect(repo.createTemplate).toHaveBeenCalledWith(expect.objectContaining({
      fieldCatalogSnapshot: {
        'detail.future_metric': {
          type: 'number',
          label: 'Future metric',
          sourceColumn: 'future_metric',
        },
      },
    }));
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

  it('requires both label generation and cut viewing for cut-map choices', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const query = { currentUser: manager, requestId: 'req-cut-map', orderId: 42 };

    await expect(service.listOrderCutMapOptions(query)).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(repo.listOrderCutMapOptions).not.toHaveBeenCalled();

    await expect(service.listOrderCutMapOptions({
      ...query,
      currentUser: { ...manager, permissions: [...manager.permissions, 'cut.view'] },
    })).resolves.toMatchObject({ orderId: 42 });

    const preview = {
      ...query,
      input: {
        templateId: 1,
        templateVersion: 1,
        cutMapSelections: [{ detailId: 11, copyIndex: 1, cutResultPlacementId: 99 }],
      },
    };
    await expect(service.previewOrderLabels(preview)).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(repo.previewOrderLabels).not.toHaveBeenCalled();
    await expect(service.previewOrderLabels({
      ...preview,
      currentUser: { ...manager, permissions: [...manager.permissions, 'cut.view'] },
    })).resolves.toBeUndefined();

    await expect(service.previewOrderLabels({
      ...query,
      input: {
        templateId: 1,
        templateVersion: 1,
        cutMapSource: 'regular',
        telegramCutMapFallbackVersion: 'v1',
      },
    })).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
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

  it('validates and snapshots if/else predicate and branch field bindings', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      elements: [{
        elementKey: 'conditional',
        kind: 'text',
        sourceField: 'bazis.order_number',
        xMm: 0,
        yMm: 0,
        widthMm: 20,
        heightMm: 5,
        condition: {
          type: 'if_else',
          version: 1,
          when: { field: 'detail.material_name', op: 'not_empty' },
          then: { type: 'field', field: 'detail.detail_name' },
          else: { type: 'text', value: 'Без материала' },
        },
      }],
    });

    await service.createTemplate({ currentUser: templateManager, requestId: 'req-condition', input });

    expect(repo.createTemplate).toHaveBeenCalledWith(expect.objectContaining({
      fieldCatalogSnapshot: expect.objectContaining({
        'detail.material_name': expect.objectContaining({ sourceColumn: 'material_name' }),
        'detail.detail_name': expect.objectContaining({ sourceColumn: 'detail_name' }),
      }),
    }));
  });

  it('rejects unsupported if/else fields before repository writes', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      elements: [{
        elementKey: 'conditional-bad',
        kind: 'text',
        sourceField: 'bazis.order_number',
        xMm: 0,
        yMm: 0,
        widthMm: 20,
        heightMm: 5,
        condition: {
          type: 'if_else',
          version: 1,
          when: { field: 'detail.missing', op: 'exists' },
          then: { type: 'current' },
          else: { type: 'hidden' },
        },
      }],
    });

    await expect(service.createTemplate({ currentUser: templateManager, requestId: 'req-condition-bad', input }))
      .rejects.toMatchObject({ statusCode: 422, code: 'LABEL_FIELD_BINDING_INVALID' });
    expect(repo.createTemplate).not.toHaveBeenCalled();
  });

  it('rejects coercible strings in versioned typography before repository writes', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      elements: [{
        elementKey: 'malformed-typography',
        kind: 'text',
        staticText: 'Text',
        xMm: 0,
        yMm: 0,
        widthMm: 20,
        heightMm: 5,
        style: {
          typography: { version: 1, fontSizePt: '12', fontWeight: 'normal', italic: false },
        },
      }],
    } as unknown as Partial<LabelTemplateInput>);

    await expect(service.createTemplate({ currentUser: templateManager, requestId: 'req-typography-string', input }))
      .rejects.toMatchObject({ statusCode: 422, code: 'LABEL_ELEMENT_SCHEMA_INVALID' });
    expect(repo.createTemplate).not.toHaveBeenCalled();
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

  it('validates custom formula dependencies and snapshots only built-in fields', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    const input = validInput({
      customFieldSchema: {
        'custom.material': expressionSchema({ type: 'field', field: 'bazis.material' }),
        'custom.caption': expressionSchema({
          type: 'concat',
          parts: [
            { type: 'text', value: 'Материал: ' },
            { type: 'field', field: 'custom.material' },
          ],
        }),
      },
    });

    await service.createTemplate({ currentUser: templateManager, requestId: 'req-expression', input });
    expect(repo.createTemplate).toHaveBeenCalledWith(expect.objectContaining({
      fieldCatalogSnapshot: expect.objectContaining({
        'bazis.material': expect.objectContaining({ type: 'string' }),
      }),
    }));
    const call = vi.mocked(repo.createTemplate).mock.calls[0][0];
    expect(call.fieldCatalogSnapshot).not.toHaveProperty('custom.material');
  });

  it('rejects invalid, non-string, and cyclic custom formulas before repository writes', async () => {
    const cases: Record<string, unknown>[] = [
      {
        'custom.bad': expressionSchema({ type: 'field', field: 'orders.raw_sql' }),
      },
      {
        'custom.number': { ...expressionSchema({ type: 'text', value: '1' }), type: 'number' },
      },
      {
        'custom.a': expressionSchema({ type: 'field', field: 'custom.b' }),
        'custom.b': expressionSchema({ type: 'field', field: 'custom.a' }),
      },
    ];

    for (const [index, customFieldSchema] of cases.entries()) {
      const repo = fakeRepo();
      const service = new LabelsService({ repo });
      await expect(service.createTemplate({
        currentUser: templateManager,
        requestId: `req-expression-invalid-${index}`,
        input: validInput({ customFieldSchema }),
      })).rejects.toMatchObject({ statusCode: 422 });
      expect(repo.createTemplate).not.toHaveBeenCalled();
    }
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

  it('pins historical generation access and requires cut.view when its snapshot has a cut map', async () => {
    const repo = fakeRepo();
    vi.mocked(repo.getOrderLabelGenerationAccessDescriptor).mockResolvedValue({ generationId: 77, usesCutMap: true });
    const service = new LabelsService({ repo });
    const query = {
      currentUser: { ...manager, permissions: ['labels.view'] },
      requestId: 'req-history-cut',
      orderId: 42,
    };

    await expect(service.getLatestOrderLabelsPreview(query)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(repo.getLatestOrderLabelsPreview).not.toHaveBeenCalled();

    await service.getLatestOrderLabelsPreview({
      ...query,
      currentUser: { ...query.currentUser, permissions: ['labels.view', 'cut.view'] },
    });
    expect(repo.getLatestOrderLabelsPreview).toHaveBeenCalledWith(expect.objectContaining({ generationId: 77 }));
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

    await service.previewDetailLabels({
      currentUser: { ...manager, permissions: ['labels.view', 'cut.view'] },
      requestId: 'req-preview-sheet',
      input: {
        templateId: 1,
        templateVersion: 1,
        detailIds: [101],
        cutSheetScope: {
          cutJobId: 7,
          cutGroupId: 3,
          sheetIndex: 0,
          detailInstances: [{ detailId: 101, instance: 2 }],
        },
      },
    });
    expect(repo.previewDetailLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          cutSheetScope: expect.objectContaining({ cutJobId: 7 }),
        }),
      }),
    );

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

function expressionSchema(root: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'string',
    label: 'Формула',
    expression: { type: 'custom_expression', version: 1, root },
  };
}

function fakeRepo(): LabelsPort {
  return {
    listDetailFieldColumns: vi.fn(async () => [
      { columnName: 'detail_id', dataType: 'bigint' },
      { columnName: 'detail_name', dataType: 'text' },
      { columnName: 'material_name', dataType: 'text' },
    ]),
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
      fieldCatalogSnapshot: {},
      rendererCapabilities: ['if_else_v1', 'typography_v1'],
      elements: [],
    })),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    getOrderLabelData: vi.fn(),
    updateOrderLabelData: vi.fn(),
    listOrderCutMapOptions: vi.fn(async (query) => ({ orderId: query.orderId, details: [] })),
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
    getOrderLabelGenerationAccessDescriptor: vi.fn(async (query) => ({
      generationId: query.generationId ?? 1,
      usesCutMap: false,
    })),
    getDetailLabelGenerationAccessDescriptor: vi.fn(async (query) => ({
      generationId: query.generationId,
      usesCutMap: false,
    })),
    recordPermissionDenied: vi.fn(async () => undefined),
  };
}
