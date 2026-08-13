import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const dp  = readFileSync(new URL('../../utils/dataProvider.ts', import.meta.url), 'utf8');
const nav = readFileSync(new URL('../../utils/navigationPermissions.ts', import.meta.url), 'utf8');
const sider = readFileSync(new URL('../../components/CustomSider.tsx', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('../../components/MobileSiderDrawer.tsx', import.meta.url), 'utf8');
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
    expect(sider).toMatch(/sheet_material_types:\s*["']Материалы["']/);
    expect(mobile).toMatch(/sheet_material_types:\s*["']Материалы["']/);
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
    expect(edit).toMatch(/isCuttable:\s*record\.is_cuttable/);
    expect(edit).toMatch(/name=["']isCuttable["']/);
    expect(create).toMatch(/initialValues=\{\{[^}]*isCuttable:\s*true/);
    expect(create).toMatch(/name=["']isCuttable["']/);
  });

  it('shows conversion_key as read-only diagnostic info in the list', () => {
    expect(dp).toMatch(/["']conversion_key["']/);
    expect(list).toMatch(/dataIndex=["']conversion_key["']/);
    expect(list).toMatch(/title=["']Conversion Key["']/);
    expect(edit).not.toMatch(/name=["']conversion_key["']/);
    expect(create).not.toMatch(/name=["']conversion_key["']/);
  });
});
