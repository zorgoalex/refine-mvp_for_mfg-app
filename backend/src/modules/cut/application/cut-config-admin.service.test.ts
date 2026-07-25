import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { CutConfigAdminService } from './cut-config-admin.service';
import type { CutConfigAdminPort } from './cut-config-admin.types';

function user(permissions: string[]): CurrentUser {
  return { id: '7', username: 'cfg', role: 'operator', permissions } as unknown as CurrentUser;
}

function fakePort(): CutConfigAdminPort {
  return {
    recordPermissionDenied: vi.fn(async () => undefined),
    getConfig: vi.fn(async () => ({ settings: [], paramProfiles: [], renderPresets: [], pdfTemplates: [] })),
    updateSetting: vi.fn(async () => ({ key: 'grain.rules', value: {}, version: 1 })),
    upsertParamProfile: vi.fn(async () => ({ cutParamProfileId: 1, name: 'x', params: {}, isDefault: false, isActive: true, version: 0 })),
    deleteParamProfile: vi.fn(async () => undefined),
    upsertRenderPreset: vi.fn(async () => ({ cutRenderPresetId: 1, name: 'x', targetPx: 360, background: '#fff', isActive: true, version: 0 })),
    deleteRenderPreset: vi.fn(async () => undefined),
    upsertPdfTemplate: vi.fn(async () => ({ cutPdfTemplateId: 1, code: 'x', name: 'x', layout: {}, isActive: true, version: 1 })),
  };
}

describe('CutConfigAdminService RBAC', () => {
  it('allows reads with cut.view and writes with cut.manage', async () => {
    const port = fakePort();
    const service = new CutConfigAdminService({ config: port });
    await expect(service.getConfig({ currentUser: user(['cut.view']) })).resolves.toBeTruthy();
    await expect(
      service.updateSetting({ currentUser: user(['cut.view', 'cut.manage']), key: 'grain.rules', value: {}, expectedVersion: 0 }),
    ).resolves.toBeTruthy();
  });

  it('denies a read without cut.view', async () => {
    const service = new CutConfigAdminService({ config: fakePort() });
    await expect(service.getConfig({ currentUser: user([]) })).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });

  it('records the denied cut-config audit carrying the request id', async () => {
    const port = fakePort();
    const service = new CutConfigAdminService({ config: port });
    await expect(
      service.updateSetting({ currentUser: user(['cut.view']), key: 'defaults', value: {}, expectedVersion: 0, requestId: 'req-9' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await Promise.resolve();
    expect(port.recordPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermissions: ['cut.manage'], requestId: 'req-9' }),
    );
  });

  it('denies every write without cut.manage (cut.view is not enough)', async () => {
    const port = fakePort();
    const service = new CutConfigAdminService({ config: port });
    const viewer = user(['cut.view']);
    await expect(service.updateSetting({ currentUser: viewer, key: 'defaults', value: {}, expectedVersion: 0 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.deleteRenderPreset({ currentUser: viewer, id: 1, expectedVersion: 0 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.upsertPdfTemplate({ currentUser: viewer, id: 1, input: { name: 'x', layout: {} }, expectedVersion: 0 })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows updating pdf templates with cut.manage', async () => {
    const port = fakePort();
    const service = new CutConfigAdminService({ config: port });

    await expect(
      service.upsertPdfTemplate({ currentUser: user(['cut.view', 'cut.manage']), id: 1, input: { name: 'Bath', layout: { elements: [] } }, expectedVersion: 0 }),
    ).resolves.toMatchObject({ cutPdfTemplateId: 1, layout: {} });
    expect(port.upsertPdfTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: 1, expectedVersion: 0 }));
  });

  it('lists PDF template fields with cut.view only', async () => {
    const service = new CutConfigAdminService({ config: fakePort() });
    const fields = await service.listPdfTemplateFields({ currentUser: user(['cut.view']) });

    expect(fields.map((field) => field.id)).toEqual(expect.arrayContaining([
      'sheet.thumbnail',
      'detail.table',
      'detail.order',
    ]));
    expect(fields.some((field) => field.source === 'bazis')).toBe(true);
  });

  it('denies PDF template fields without cut.view', async () => {
    const service = new CutConfigAdminService({ config: fakePort() });
    await expect(service.listPdfTemplateFields({ currentUser: user([]) })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
  });

  it('rejects invalid v3 PDF layouts before persistence', async () => {
    const port = fakePort();
    const service = new CutConfigAdminService({ config: port });
    await expect(
      service.upsertPdfTemplate({
        currentUser: user(['cut.view', 'cut.manage']),
        id: 1,
        expectedVersion: 0,
        input: {
          name: 'bad',
          layout: {
            version: 3,
            page: { width: 297, height: 210 },
            customFieldSchema: {
              bad: {
                type: 'string',
                expression: { type: 'custom_expression', version: 1, root: { type: 'concat', parts: [] } },
              },
            },
            elements: [],
          },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'LABEL_CUSTOM_EXPRESSION_INVALID' });
    expect(port.upsertPdfTemplate).not.toHaveBeenCalled();
  });

  it('accepts v3 PDF layouts using the editor default detail table columns', async () => {
    const port = fakePort();
    const service = new CutConfigAdminService({ config: port });

    await expect(
      service.upsertPdfTemplate({
        currentUser: user(['cut.view', 'cut.manage']),
        id: 2,
        expectedVersion: 3,
        input: {
          name: 'standard',
          layout: {
            version: 3,
            page: { width: 297, height: 210 },
            customFieldSchema: {},
            elements: [
              {
                id: 'detail-table',
                type: 'detail_table',
                source: 'detail.table',
                x: 222,
                y: 34,
                w: 60,
                h: 78,
                rotation: 0,
                zIndex: 1,
                align: 'center',
                style: {
                  columns: [
                    { field: 'detail.row_number', label: '#', width: 0.55, visible: true },
                    { field: 'detail.order', label: 'Заказ', width: 1.6, visible: true },
                  ],
                  sort: { field: 'detail.row_number', direction: 'asc' },
                },
              },
            ],
          },
        },
      }),
    ).resolves.toMatchObject({ cutPdfTemplateId: 1 });
    expect(port.upsertPdfTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: 2, expectedVersion: 3 }));
  });
});
