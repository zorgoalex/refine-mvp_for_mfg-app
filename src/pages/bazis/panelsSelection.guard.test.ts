import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-test env без jsdom: фиксируем source-text контракт интеграции
 * мультиселекта во вкладку «Панели».
 */
const panelsTab = readFileSync(new URL('./PanelsTab.tsx', import.meta.url), 'utf8');

describe('bazis panels selection UI guards', () => {
  it('PanelsTab импортирует selection helpers и хранит локальное состояние селекции', () => {
    expect(panelsTab).toContain("from './panelSelection'");
    expect(panelsTab).toContain('useState<PanelSelectionState>');
    expect(panelsTab).toContain('emptySelection()');
  });

  it('чистит селекцию через pruneSelection при смене набора панелей', () => {
    expect(panelsTab).toContain('pruneSelection');
    expect(panelsTab).toContain('alivePanelIds');
    expect(panelsTab).toMatch(/useEffect\(\(\) => \{[\s\S]*?pruneSelection/);
  });

  it('первая колонка таблицы занята чекбоксами группы и панели', () => {
    expect(panelsTab).toMatch(/allFreeCheckState\(selection, visiblePanels\)[\s\S]*?key: 'selection'/);
    // Header-чекбокс «выбрать все» работает по видимым (фильтры) строкам
    expect(panelsTab).toContain('toggleAll(current, visiblePanels, event.target.checked)');
    expect(panelsTab).toContain('setTableFilters(filters)');
    expect(panelsTab).toContain('groupCheckState');
    expect(panelsTab).toContain('indeterminate');
    expect(panelsTab).toContain('toggleGroup');
    expect(panelsTab).toContain('togglePanel');
  });

  it('чекбоксы не всплывают в row onClick и не ломают выбор панели', () => {
    const stopPropagationCount = (panelsTab.match(/stopPropagation/g) ?? []).length;
    expect(stopPropagationCount).toBeGreaterThanOrEqual(4);
    expect(panelsTab).toContain('onSelect(row.bazisNodeId)');
  });

  it('тулбар рендерит summary и две disabled-aware кнопки без обработчиков', () => {
    expect(panelsTab).toContain('selectionSummary');
    expect(panelsTab).toContain('Выбрано:');
    expect(panelsTab).toContain('исключено');
    expect(panelsTab).toContain('В новый заказ');
    expect(panelsTab).toContain('В существующий заказ');
    expect(panelsTab).toContain('onClick={noop}');
    expect(panelsTab).toContain('selectionPossible');
  });

  it('занятая панель, включённая в селекцию чекбоксом, подсвечивается warn-фоном (не карточный selectedId)', () => {
    expect(panelsTab).toContain('BUSY_SELECTED_ROW_STYLE');
    expect(panelsTab).toContain("row.orders.length > 0 &&\n            selection.selected.has(row.bazisNodeId)");
    expect(panelsTab).toContain("backgroundColor: '#fff2e8'");
    // Карточное выделение строки не зависит от занятости
    expect(panelsTab).toContain("row.bazisNodeId === selectedId ? 'ant-table-row-selected' : ''");
  });
});
