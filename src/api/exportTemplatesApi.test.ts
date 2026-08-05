import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportTemplatesApi, type ExportTemplateDraft } from './exportTemplatesApi';

const draft: ExportTemplateDraft = {
  name: 'Тестовый шаблон',
  description: 'Описание',
  targetScreen: 'bazis_cut_set',
  sourceType: 'bazis_cut_set_detail',
  format: 'xls_biff8',
  sheetName: 'Раскрой',
  schemaVersion: 1,
  columns: [{ columnKey: 'position', header: 'Позиция', expression: { type: 'field', field: 'detail.position' } }],
  isActive: true,
};

describe('exportTemplatesApi request contracts', () => {
  beforeEach(() => { vi.stubEnv('VITE_API_URL', ''); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('filters immutable fields out of the strict update body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await exportTemplatesApi.update(7, draft, 3, 'update-template-7');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/export-templates/7');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      name: draft.name,
      description: draft.description,
      sheetName: draft.sheetName,
      schemaVersion: 1,
      columns: draft.columns,
      isActive: true,
      expectedVersion: 3,
      idempotencyKey: 'update-template-7',
    });
  });

  it('filters editor-only fields out of the strict preview body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await exportTemplatesApi.preview(draft);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/export-templates/preview');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      targetScreen: draft.targetScreen,
      sourceType: draft.sourceType,
      format: draft.format,
      columns: draft.columns,
    });
  });
});
