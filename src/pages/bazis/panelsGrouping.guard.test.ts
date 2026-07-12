import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-тест-env без jsdom: рендер-поверхность фиксируем source-text guard'ом.
 * Контракт вкладки «Панели»: список сгруппирован по материалу+размерам
 * (groupPanelRows), группы разворачиваются как Excel-группировки, вложенные
 * панели рендерятся детьми таблицы со сдвигом. Порядок колонок:
 * № → Размеры → Кол-во → Материал → Наименование → остальные.
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

  it('колонки идут в порядке №, Размеры, Кол-во, Материал, Наименование', () => {
    const order = ["title: '№'", "title: 'Размеры, мм'", "title: 'Кол-во'", "title: 'Материал'", "title: 'Наименование'"];
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
  });

  it('смена ревизии сбрасывает состояние раскрытия (remount по key)', () => {
    // critic R2 MINOR: expandedKeys не должны переживать смену ревизии —
    // групповые ключи (материал+размеры) могут совпасть в другой ревизии
    expect(viewPage).toMatch(/<PanelsTab[^>]*key=\{selectedRevision\.bazisRevisionId\}/);
  });

  it('внизу таблицы итоговая строка: количество позиций и общая сумма панелей', () => {
    expect(panelsTab).toContain('summarizePanelGroups');
    expect(panelsTab).toContain('Table.Summary');
    expect(panelsTab).toContain('Итого');
    expect(panelsTab).toContain('позиций');
    // Индексы Summary.Cell рассчитаны на 8 колонок БЕЗ инжектированной
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
    expect(sorterCount).toBeGreaterThanOrEqual(5);
  });
});
