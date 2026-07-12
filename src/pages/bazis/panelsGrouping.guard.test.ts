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
});
