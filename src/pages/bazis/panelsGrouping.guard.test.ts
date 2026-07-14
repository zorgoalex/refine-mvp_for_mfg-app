import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-тест-env без jsdom: рендер-поверхность фиксируем source-text guard'ом.
 * Контракт вкладки «Панели»: список сгруппирован по материалу+размерам
 * (groupPanelRows), группы разворачиваются как Excel-группировки, вложенные
 * панели рендерятся детьми таблицы со сдвигом. Порядок колонок:
 * № → Размеры → Кол-во → Материал → Наименование → Обозначение → Изделие
 * → Базис-заказ → остальные.
 */
const panelsTab = readFileSync(new URL('./PanelsTab.tsx', import.meta.url), 'utf8');
const viewPage = readFileSync(new URL('./BazisProjectViewPage.tsx', import.meta.url), 'utf8');
const panelsCss = readFileSync(new URL('./panels.css', import.meta.url), 'utf8');

describe('bazis panels grouping UI guards', () => {
  it('PanelsTab группирует панели через groupPanelRows и отдаёт детей таблице', () => {
    expect(panelsTab).toContain("from './panelGrouping'");
    expect(panelsTab).toContain('groupPanelRows(');
    // Вложенные записи = tree-data таблицы (children) → AntD рисует их со сдвигом
    expect(panelsTab).toContain('children:');
    expect(panelsTab).toContain('expandable');
  });

  it('колонки идут в порядке №, Размеры, Кол-во, Материал, Наименование, Обозначение, Изделие, Базис-заказ', () => {
    const order = [
      "title: '№'",
      "title: 'Размеры, мм'",
      "title: 'Кол-во'",
      "title: 'Материал'",
      "title: 'Наименование'",
      "title: 'Обозначение'",
      "title: 'Изделие'",
      "title: 'Базис-заказ'",
    ];
    const positions = order.map((needle) => panelsTab.indexOf(needle));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('групповая строка показывает порядковый номер позиции, дети — нет', () => {
    expect(panelsTab).toContain('groupSeq');
  });

  it('выбор панели извне (goToPanel) авто-раскрывает её группу', () => {
    expect(panelsTab).toContain('findGroupKeyByPanelId');
    expect(panelsTab).toMatch(/useEffect\(\(\) => \{[\s\S]*?findGroupKeyByPanelId[\s\S]*?setExpandedKeys/);
  });

  it('повторный goToPanel на ту же панель форсирует раскрытие (focus-токен)', () => {
    // critic R2: эффект только по selectedId не перезапускается при повторной
    // навигации на ту же панель после ручного сворачивания группы
    expect(panelsTab).toContain('focusToken');
    expect(panelsTab).toMatch(/\[focusToken.*?\]|\[.*?focusToken.*?\]/);
    expect(viewPage).toMatch(/goToPanel[\s\S]*?setPanelFocusToken\(\(token\) => token \+ 1\)/);
    expect(viewPage).toContain('focusToken={panelFocusToken}');
    expect(viewPage).toContain('bazisOrderNo={projectCard.bazisOrderNo}');
  });

  it('смена ревизии сбрасывает состояние раскрытия (remount по key)', () => {
    // critic R2 MINOR: expandedKeys не должны переживать смену ревизии —
    // групповые ключи (материал+размеры) могут совпасть в другой ревизии
    expect(viewPage).toMatch(/<PanelsTab[^>]*key=\{selectedRevision\.bazisRevisionId\}/);
  });

  it('внизу таблицы итоговая строка: количество позиций и общая сумма панелей', () => {
    expect(panelsTab).toContain('summarizeVisibleRows');
    // итоги считаются из аргумента summary-колбэка (видимые строки после
    // фильтров), не из полного датасета (critic R1)
    expect(panelsTab).toMatch(/summary=\{\(visibleRows\)/);
    expect(panelsTab).toContain('Table.Summary');
    // Паттерн итогов ERP-заказа: muted bold строка, позиции серым, кол-во/площадь синим
    expect(panelsTab).toContain("backgroundColor: 'var(--app-surface-muted)', fontWeight: 'bold'");
    expect(panelsTab).toContain('{totals.positions}');
    expect(panelsTab).toContain("color: '#1890ff'");
    expect(panelsTab).toContain('bordered');
    // Индексы Summary.Cell рассчитаны на 11 колонок БЕЗ инжектированной
    // expand-колонки: rc-table вставляет её только при expandedRowRender
    // (rc-table/lib/Table.js: expandable: !!expandedRowRender); nest-режим
    // (children) рисует иконку внутри первой ячейки. Появится
    // expandedRowRender — пересчитать colSpan/index в summary.
    expect(panelsTab).not.toContain('expandedRowRender');
  });

  it('вложенные строки визуально отличаются фоном от групповых', () => {
    expect(panelsTab).toContain('bazis-panel-child-row');
    expect(panelsTab).toContain("import './panels.css'");
    // фон через СВОЮ тему-переменную (light+dark override): глобальная zebra
    // app.css красит чётные строки --app-surface-soft, а dark-блок бьёт
    // !important — поэтому отдельный цвет и !important обязательны
    expect(panelsCss).toMatch(/tr\.bazis-panel-child-row:not\(\.ant-table-row-selected\)\s*>\s*td/);
    expect(panelsCss).toContain('var(--bazis-panel-child-bg)');
    expect(panelsCss).toContain('!important');
    expect(panelsCss).toMatch(/\[data-theme="dark"\][\s\S]*--bazis-panel-child-bg/);
  });

  it('колонки сортируются кликом по заголовку (sorter → стрелки AntD)', () => {
    expect(panelsTab).toContain('panelComparators');
    const sorterCount = (panelsTab.match(/sorter:/g) ?? []).length;
    expect(sorterCount).toBeGreaterThanOrEqual(7);
  });

  it('чекбокс «Группировать» справа над списком, по дефолту включён', () => {
    expect(panelsTab).toContain('Группировать');
    expect(panelsTab).toMatch(/useState\(true\)/); // grouped default ON
    expect(panelsTab).toContain('Checkbox');
  });

  it('№ сортируется, всего сортировщиков ≥7', () => {
    expect(panelsTab).toContain('panelComparators.seq');
    const sorterCount = (panelsTab.match(/sorter:/g) ?? []).length;
    expect(sorterCount).toBeGreaterThanOrEqual(7);
  });

  it('фильтры Материал/Наименование/Изделие/Заказ: кастомный dropdown с тремя кнопками', () => {
    expect(panelsTab).toContain('filterDropdown');
    expect(panelsTab).toContain('Включить все');
    expect(panelsTab).toContain('Сбросить');
    expect(panelsTab).toContain('Отключить все');
    // live-apply без закрытия списка (в т.ч. после «Отключить все»)
    expect(panelsTab).toContain('closeDropdown: false');
    // «Отключить все» кодируется сентинелом: пустой выбор в antd = фильтр выключен
    expect(panelsTab).toContain('PANEL_FILTER_NONE');
    expect(panelsTab).toContain('panelFilterPredicate');
    expect(panelsTab).toContain("filterProps('productName', filterOptions.productNames)");
  });
});
