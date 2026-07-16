import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Пост-импортное сопоставление материалов: если в визарде выбрали
// «Пропустить», заказ из панелей падает 422 — чинится на вкладке «Материалы»
// без переимпорта. Пины держат вход (кнопка), реюз шага визарда и корректный
// ключ details в ошибке (backend шлёт unmappedMaterials, НЕ materialNames).

const materialsTab = readFileSync(new URL('./MaterialsSummaryTab.tsx', import.meta.url), 'utf8');
const viewPage = readFileSync(new URL('./BazisProjectViewPage.tsx', import.meta.url), 'utf8');
const panelsTab = readFileSync(new URL('./PanelsTab.tsx', import.meta.url), 'utf8');
const addToOrder = readFileSync(new URL('./AddToOrderModal.tsx', import.meta.url), 'utf8');

describe('post-import material remapping', () => {
  it('Материалы tab has the remap entry point wired to the wizard step', () => {
    expect(materialsTab).toContain('Сопоставить материалы');
    expect(materialsTab).toContain('MaterialMappingStep');
    expect(materialsTab).toContain('upsertMaterialMappings');
    // «Пропустить»-строки из визарда тоже попадают в ремап (ignore), не только несопоставленные.
    expect(materialsTab).toMatch(/mappingTargetKind === 'ignore'\s*\|\|\s*!row\.erpMatch/);
    // После сохранения — перезагрузка сводки.
    expect(materialsTab).toMatch(/setMappingOpen\(false\);\s*reload\(\)/);
  });

  it('view page passes canManage into the Материалы tab', () => {
    expect(viewPage).toMatch(/<MaterialsSummaryTab[\s\S]*?canManage=\{canManage\}/);
  });

  it('unmapped-materials errors read the backend details key and point to the tab', () => {
    for (const source of [panelsTab, addToOrder]) {
      expect(source).toContain('unmappedMaterials');
      expect(source).toContain('вкладке «Материалы»');
      expect(source).not.toContain('визарде импорта');
    }
  });
});
