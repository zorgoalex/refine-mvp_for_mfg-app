import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const listSource = readFileSync(new URL('./list.tsx', dir), 'utf8');
const resourceKindsSource = readFileSync(new URL('./resourceKinds.ts', dir), 'utf8');
const resourceDemandPartsSource = readFileSync(new URL('./ResourceDemandParts.tsx', dir), 'utf8');
const resourceDemandCardSource = readFileSync(new URL('./ResourceDemandCard.tsx', dir), 'utf8');
const materialRowsViewSource = readFileSync(new URL('./MaterialRowsView.tsx', dir), 'utf8');
const splitPanelViewSource = readFileSync(new URL('./SplitPanelView.tsx', dir), 'utf8');
const useStoredViewModeSource = readFileSync(new URL('./useStoredViewMode.ts', dir), 'utf8');

describe('order resource requirements — переключатель видов списка (Сводка/Материалы/Панель)', () => {
  it('содержит Segmented с тремя видами и ключом хранения', () => {
    expect(listSource).toContain("Segmented");
    expect(listSource).toContain("aria-label=\"Вид списка\"");
    expect(listSource).toContain("{ value: 'summary', label: 'Сводка' }");
    expect(listSource).toContain("{ value: 'materials', label: 'Материалы' }");
    expect(listSource).toContain("{ value: 'panel', label: 'Панель' }");
    expect(listSource).toContain("'order-resource-requirements:list-view'");
  });

  it('рендерит MaterialRowsView, SplitPanelView и Drawer с ResourceDemandCard', () => {
    expect(listSource).toContain('<MaterialRowsView');
    expect(listSource).toContain('<SplitPanelView');
    expect(listSource).toContain('<Drawer');
    expect(listSource).toContain('<ResourceDemandCard');
  });

  it('использует общий paginationConfig и для Table «Сводка», и для Pagination других видов', () => {
    expect(listSource).toContain('const paginationConfig: TablePaginationConfig');
    expect(listSource).toContain('pagination={paginationConfig}');
    expect(listSource).toContain('<Pagination {...paginationConfig}');
  });

  it('таблица «Сводка» раскрывается в ResourceDemandBreakdown', () => {
    expect(listSource).toContain('expandable={{');
    expect(listSource).toContain('ResourceDemandBreakdown');
  });
});

describe('order resource requirements — границы владения данными (без прямых Hasura/dataProvider обращений)', () => {
  const sourcesByFile: Array<[string, string]> = [
    ['resourceKinds.ts', resourceKindsSource],
    ['ResourceDemandParts.tsx', resourceDemandPartsSource],
    ['ResourceDemandCard.tsx', resourceDemandCardSource],
    ['MaterialRowsView.tsx', materialRowsViewSource],
    ['SplitPanelView.tsx', splitPanelViewSource],
    ['useStoredViewMode.ts', useStoredViewModeSource],
    ['list.tsx', listSource],
  ];

  it.each(sourcesByFile)('%s не содержит graphql/hasura/dataProvider', (_name, source) => {
    expect(source).not.toMatch(/graphql/i);
    expect(source).not.toMatch(/hasura/i);
    expect(source).not.toMatch(/dataProvider/i);
  });
});

describe('order resource requirements — карточка ресурса, два режима', () => {
  it('ResourceDemandCard.tsx содержит подписи режимов «Вкладки» и «Сводка»', () => {
    expect(resourceDemandCardSource).toContain("label: 'Вкладки'");
    expect(resourceDemandCardSource).toContain("label: 'Сводка'");
  });
});

describe('order resource requirements — устаревшие show/create/edit удалены', () => {
  it('show.tsx / create.tsx / edit.tsx больше не существуют в папке экрана', () => {
    expect(existsSync(new URL('./show.tsx', dir))).toBe(false);
    expect(existsSync(new URL('./create.tsx', dir))).toBe(false);
    expect(existsSync(new URL('./edit.tsx', dir))).toBe(false);
  });
});
