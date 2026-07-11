import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-тест-env без jsdom: рендер-поверхности фиксируем source-text guard'ами.
 * Контракт: у панелей Базис-проекта видно, в какой ERP-заказ они добавлены
 * (bazis_node_order_detail_map, только реально созданные детали).
 */
const panelsTab = readFileSync(new URL('./PanelsTab.tsx', import.meta.url), 'utf8');
const viewerTree = readFileSync(new URL('./ViewerTree.tsx', import.meta.url), 'utf8');

describe('bazis node order-provenance UI guards', () => {
  it('PanelsTab has an order column linking to /orders/show/:id', () => {
    expect(panelsTab).toContain("title: 'Заказ'");
    expect(panelsTab).toMatch(/orderIds/);
    expect(panelsTab).toContain('/orders/show/');
  });

  it('ViewerTree marks nodes that are already in an ERP order', () => {
    expect(viewerTree).toMatch(/orderIds/);
  });
});
