import { describe, it, expect, vi } from 'vitest';
import { SheetMaterialsService } from './sheet-materials.service';

const port = {
  list: vi.fn().mockResolvedValue([]),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deactivate: vi.fn(),
  recordPermissionDenied: vi.fn().mockResolvedValue(undefined),
};
const allow = { canUser: () => true } as any;
const deny = { canUser: () => false } as any;
const ctx = { currentUser: { id: '1', role: 'viewer', username: 'u' }, requestId: 'r1' } as any;

describe('SheetMaterialsService RBAC', () => {
  it('list requires sheet_materials.view (allowed)', async () => {
    const svc = new SheetMaterialsService({ repo: port as any, permissions: allow });
    await expect(svc.list(ctx)).resolves.toEqual([]);
  });
  it('create denied without sheet_materials.manage → 403 + denied-audit via port', async () => {
    const svc = new SheetMaterialsService({ repo: port as any, permissions: deny });
    await expect(svc.create({ ...ctx, input: {} as any })).rejects.toMatchObject({ statusCode: 403 });
    expect(port.recordPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermissions: ['sheet_materials.manage'] }),
    );
  });

  it('1C items for the form: manage only; one item per key with the ERP sheet already linked; no mirror → unavailable', async () => {
    const KEY = 'f4bfb4c0-d6bf-43d8-86b4-88b01b8cba9b';
    const item = { code: '00-1', name: 'МДФ 16 мм', unitName: 'л.', categoryName: 'Сырье', nomenclatureType: 'Запас', deletionMark: false };
    const repo = { ...port, list: vi.fn().mockResolvedValue([{ sheetMaterialTypeId: 8, name: 'МДФ 16мм', refKey1c: KEY.toUpperCase() }, { sheetMaterialTypeId: 9, name: 'МДФ 18мм', refKey1c: null }]) };
    const source = vi.fn().mockResolvedValue([{ ...item, refKey: KEY }, { ...item, refKey: KEY.toUpperCase(), name: 'копия из второго источника' }, { ...item, refKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'ХДФ 3 мм' }]);
    const svc = new SheetMaterialsService({ repo: repo as any, permissions: allow, onecItems: source });
    await expect(svc.onecItems(ctx)).resolves.toEqual({ available: true, items: [
      { ...item, refKey: KEY, linkedSheetMaterialTypeId: 8, linkedName: 'МДФ 16мм' },
      { ...item, refKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'ХДФ 3 мм', linkedSheetMaterialTypeId: null, linkedName: null },
    ] });
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ includeInactive: true }));
    // Копия 1С недоступна или источник не подключён — выбора нет.
    await expect(new SheetMaterialsService({ repo: repo as any, permissions: allow, onecItems: async () => null }).onecItems(ctx)).resolves.toEqual({ available: false, items: [] });
    await expect(new SheetMaterialsService({ repo: repo as any, permissions: allow }).onecItems(ctx)).resolves.toEqual({ available: false, items: [] });
    // Копия есть, но номенклатура ещё не загружена: пустой список не должен отнять ручной ввод ключа.
    await expect(new SheetMaterialsService({ repo: repo as any, permissions: allow, onecItems: async () => [] }).onecItems(ctx)).resolves.toEqual({ available: false, items: [] });
    // Без права правки справочника список 1С не отдаётся и источник не читается.
    source.mockClear();
    const denied = new SheetMaterialsService({ repo: repo as any, permissions: deny, onecItems: source });
    await expect(denied.onecItems(ctx)).rejects.toMatchObject({ statusCode: 403 });
    expect(source).not.toHaveBeenCalled();
    await expect(svc.capabilities(ctx)).resolves.toEqual({ nomenclatureFields: true, onecItemPicker: true });
  });
});
