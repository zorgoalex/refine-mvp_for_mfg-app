import { readFileSync } from 'node:fs';
import { sheetMaterialEditSource } from './editSource';
import type { SheetMaterialTypeDto } from '../../api/sheetMaterialsApi';
import { describe, it, expect } from 'vitest';

const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const dp  = readFileSync(new URL('../../utils/dataProvider.ts', import.meta.url), 'utf8');
const nav = readFileSync(new URL('../../utils/navigationPermissions.ts', import.meta.url), 'utf8');
const menuConfig = readFileSync(new URL('../../utils/navigationMenuConfig.ts', import.meta.url), 'utf8');
const create = readFileSync(new URL('./create.tsx', import.meta.url), 'utf8');
const show = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
const edit = readFileSync(new URL('./edit.tsx', import.meta.url), 'utf8');
const list = readFileSync(new URL('./list.tsx', import.meta.url), 'utf8');

describe('sheet-materials resource wiring', () => {
  it('registers resource', () => expect(app).toMatch(/name:\s*["']sheet_material_types["']/));

  it('has PK in ID_COLUMNS', () => expect(dp).toMatch(/sheet_material_types:\s*["']sheet_material_type_id["']/));

  it('uses bare relationship names (no :alias)', () => {
    expect(dp).toMatch(/supplier \{ supplier_id supplier_name \}/);
    expect(dp).not.toMatch(/supplier:suppliers/);
  });

  it('nav-permission mapped to sheet_materials.view', () => expect(nav).toMatch(/sheet_material_types:\s*\[\s*['"]sheet_materials\.view['"]\s*\]/));

  it('desktop + mobile nav both place it under Материалы', () => {
    expect(menuConfig).toMatch(/sheet_material_types:\s*['"]Материалы['"]/);
  });

  it('tab label resolves (path seg → resource → label)', async () => {
    const { resourceFromPath, resolveTabLabel } = await import('../../utils/tabLabels');
    expect(resourceFromPath('/sheet-material-types')).toBe('sheet_material_types');
    expect(resolveTabLabel('/sheet-material-types')).toBe('Листовые материалы');
  });

  it('create writes via backend api, not dataProvider', () => {
    expect(create).toMatch(/sheetMaterialsApi/);
    expect(create).not.toMatch(/useForm\(\{[^}]*resource:\s*["']sheet_material_types["']/);
  });

  it('write UI is gated on sheet_materials.manage', () => {
    expect(list).toMatch(/sheet_materials\.manage/);   // create/edit buttons gated
    expect(create).toMatch(/sheet_materials\.manage/);  // create page guards on manage
  });

  it('show/edit tabs are enriched with the loaded sheet material name', () => {
    expect(show).toMatch(/useRecordTabTitle/);
    expect(show).toMatch(/actionLabel:\s*['"]Просмотр['"]/);
    expect(show).toMatch(/preferredFields:\s*\[\s*['"]name['"]\s*\]/);
    expect(edit).toMatch(/useRecordTabTitle/);
    expect(edit).toMatch(/actionLabel:\s*['"]Редактирование['"]/);
    expect(edit).toMatch(/preferredFields:\s*\[\s*['"]name['"]\s*\]/);
  });

  it('exposes is_cuttable in list/show/edit/create surfaces', () => {
    expect(dp).toMatch(/["']is_cuttable["']/);
    expect(list).toMatch(/dataIndex=["']is_cuttable["']/);
    expect(list).toMatch(/title=["']Для раскроя["']/);
    expect(show).toMatch(/Для раскроя/);
    expect(show).toMatch(/is_cuttable/);
    expect(readFileSync(new URL('./editSource.ts', import.meta.url), 'utf8')).toMatch(/isCuttable:\s*record\.is_cuttable/);
    expect(edit).toContain('sheetMaterialEditSource(backendQuery.data, record)');
    expect(edit).toMatch(/name=["']isCuttable["']/);
    expect(create).toMatch(/initialValues=\{\{[^}]*isCuttable:\s*true/);
    expect(create).toMatch(/name=["']isCuttable["']/);
  });

  it('shows conversion_key as read-only diagnostic info', () => {
    expect(dp).toMatch(/["']conversion_key["']/);
    expect(list).toMatch(/dataIndex=["']conversion_key["']/);
    expect(list).toMatch(/title=["']Conversion Key["']/);
    expect(show).toMatch(/Conversion Key/);
    expect(show).toMatch(/conversion_key/);
    expect(edit).toMatch(/Conversion Key/);
    expect(edit).toMatch(/conversion_key/);
    expect(edit).toMatch(/disabled/);
    expect(edit).not.toMatch(/name=["']conversion_key["']/);
    expect(create).not.toMatch(/name=["']conversion_key["']/);
  });
});

describe('sheet materials nomenclature fields', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  it('reads them through the backend, never through Hasura (a mixed deploy must not break sheet reads)', () => {
    const provider = read('../../utils/dataProvider.ts');
    const fields = provider.slice(provider.indexOf('sheet_material_types: ['), provider.indexOf('],', provider.indexOf('sheet_material_types: [')));
    for (const column of ['nomenclature_type', 'nomenclature_category', '"note"']) expect(fields).not.toContain(column);
    expect(read('./useSheetMaterialNomenclature.ts')).toContain('sheetMaterialsApi.list(true)');
    expect(read('./edit.tsx')).toContain('sheetMaterialsApi.get(Number(id))');
    // Поддержка — отдельным запросом возможностей, а не по первой записи списка (пустой справочник — тоже поддержка).
    expect(read('./useSheetMaterialNomenclature.ts')).toContain('sheetMaterialsApi.capabilities()');
    expect(read('./useSheetMaterialNomenclature.ts')).toContain('query.data?.nomenclatureFields === true');
  });
  it('shows and sends them only when the backend knows them', () => {
    expect(read('./list.tsx')).toContain('title="Категория номенклатуры"');
    expect(read('./edit.tsx')).toContain('{nomenclatureEditable && <NomenclatureFormItems');
    expect(read('./edit.tsx')).toContain('nomenclaturePayload({ nomenclatureType, nomenclatureCategory, note }, nomenclatureEditable)');
    expect(read('./edit.tsx')).toContain("const nomenclatureEditable = nomenclatureSupported && source?.fromBackend === true;");
    expect(read('./create.tsx')).toContain('{nomenclature.supported && <NomenclatureFormItems');
  });
  it('the edit form takes the draft and the version from one snapshot (another edit between two reads must give 409)', () => {
    const snapshot = {
      sheetMaterialTypeId: 5, name: 'МДФ 16 (новое)', materialTypeId: 2, unitId: 1, thicknessMm: 16, widthMm: 2800, heightMm: 2070,
      supplierId: null, vendorId: null, supplierArticle: null, texture: null, color: null, refKey1c: null,
      isActive: true, isCuttable: true, sortOrder: 0, version: 7, nomenclatureType: 'Запас', nomenclatureCategory: null, note: 'из backend',
    } as unknown as SheetMaterialTypeDto;
    // Hasura прочитана раньше: старая версия и старое название.
    const record = { name: 'МДФ 16', material_type_id: 2, unit_id: 1, thickness_mm: 16, width_mm: 2800, height_mm: 2070, is_active: true, version: 6 };
    const source = sheetMaterialEditSource(snapshot, record)!;
    expect(source).toMatchObject({ fromBackend: true, expectedVersion: 7 });
    expect(source.values).toMatchObject({ name: 'МДФ 16 (новое)', nomenclatureType: 'Запас', nomenclatureCategory: undefined, note: 'из backend' });
    // Backend не ответил: и поля, и версия — из Hasura, новых полей нет (и в PUT они не уйдут).
    const fallback = sheetMaterialEditSource(undefined, record)!;
    expect(fallback).toMatchObject({ fromBackend: false, expectedVersion: 6 });
    expect(fallback.values).toMatchObject({ name: 'МДФ 16', isCuttable: true });
    expect(fallback.values).not.toHaveProperty('note');
    expect(sheetMaterialEditSource(undefined, undefined)).toBeNull();
    expect(read('./edit.tsx')).not.toContain('record?.version');
  });
  it('after a save the list and the card do not show the cached old values', () => {
    for (const file of ['./edit.tsx', './create.tsx']) expect(read(file)).toContain("await queryClient.invalidateQueries({ queryKey: ['sheet-materials'] });");
    expect(read('./useSheetMaterialNomenclature.ts')).toContain("queryKey: ['sheet-materials', 'nomenclature']");
  });
});
