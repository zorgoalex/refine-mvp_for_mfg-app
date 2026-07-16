import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const app = read('../../App.tsx');
const list = read('./BazisCutListPage.tsx');
const card = read('./BazisCutSetPage.tsx');
const modal = read('./AddToBazisCutModal.tsx');
const editDetails = read('../orders/components/tabs/OrderDetailsTab.tsx');
const show = read('../orders/show.tsx');
const desktopSider = read('../../components/CustomSider.tsx');
const mobileSider = read('../../components/MobileSiderDrawer.tsx');

describe('Basis-cut UI integration guards', () => {
  it('registers list/card resource and both routes behind bazisCut', () => {
    expect(app).toMatch(/featureFlags\.bazisCut[\s\S]*name: "bazis-cut-sets"/);
    expect(app).toContain('path="/bazis-cut"');
    expect(app).toContain('path=":id"');
  });

  it('places the resource in Production on desktop and mobile', () => {
    expect(desktopSider).toContain('"bazis-cut-sets": "Производство"');
    expect(mobileSider).toContain('"bazis-cut-sets": "Производство"');
  });

  it('renders the exact requested list columns and source categories', () => {
    for (const label of ['Название набора', 'Дата формирования', 'Заказы / Базис-проекты / Базис-заказы', 'Количество деталей']) {
      expect(list).toContain(label);
    }
    expect(list).toContain('ERP-заказы');
    expect(list).toContain('Базис-проекты');
    expect(list).toContain('Базис-заказы');
  });

  it('supports new/existing searchable set selection', () => {
    expect(modal).toContain('Новый набор');
    expect(modal).toContain('Существующий набор');
    expect(modal).toContain('showSearch');
    expect(modal).toContain('filterOption={false}');
  });

  it('wires the action into order edit/show and blocks dirty edit drafts', () => {
    expect(editDetails).toContain('Добавить в Базис раскрой');
    expect(editDetails).toContain('Сначала сохраните изменения заказа');
    expect(editDetails).toMatch(/disabled=\{!bazisCutManage \|\| isDirty/);
    expect(show).toContain('Добавить в Базис раскрой');
    expect(show).toContain('AddToBazisCutModal');
  });

  it('keeps all 33 fields editable and uses native picker with fallback', () => {
    expect((card.match(/key: '[A-Za-z0-9]+'/g) ?? []).length).toBeGreaterThanOrEqual(33);
    expect(card).toContain("title: 'Базис заказ'");
    expect(card).toContain("dataIndex: 'sourceBazisOrderNo'");
    expect(card).toContain('showSaveFilePicker');
    expect(card).toContain('downloadBlob');
    expect(card).toContain("error.name === 'AbortError'");
  });

  it('shows the set number in its workspace tab and keeps detail headers visible', () => {
    expect(card).toContain('`Базис-раскрой #${setId}`');
    expect(card).toContain('sticky={{ offsetHeader: tableHeaderOffset }}');
    expect(card).toContain("document.querySelector<HTMLElement>('.workspace-tabs')");
    expect(card).toContain('new ResizeObserver(update)');
  });
});
