import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-тест-env без jsdom: рендер-поверхности фиксируем source-text guard'ами.
 * Контракт: у панелей Базис-проекта видно, в какой ERP-заказ они добавлены
 * (bazis_node_order_detail_map, только реально созданные детали).
 */
const panelsTab = readFileSync(new URL('./PanelsTab.tsx', import.meta.url), 'utf8');
const bazisPage = readFileSync(new URL('./BazisPage.tsx', import.meta.url), 'utf8');
const viewerTree = readFileSync(new URL('./ViewerTree.tsx', import.meta.url), 'utf8');
const nodeCard = readFileSync(new URL('./NodeCard.tsx', import.meta.url), 'utf8');
const panelsCss = readFileSync(new URL('./panels.css', import.meta.url), 'utf8');

describe('bazis node order-provenance UI guards', () => {
  it('Bazis project list shows linked ERP order names with links', () => {
    expect(bazisPage).toContain("title: 'Заказы'");
    expect(bazisPage).toContain('record.linkedOrders.map');
    expect(bazisPage).toContain('order.orderName');
    expect(bazisPage).toContain('/orders/show/');
  });

  it('PanelsTab has an order column with ORDER NAMES linking to /orders/show/:id', () => {
    expect(panelsTab).toContain("title: 'Заказ'");
    expect(panelsTab).toContain('order.orderName');
    expect(panelsTab).toContain('OrderDeletedTag');
    expect(panelsTab).toContain('order.orderDeleted');
    expect(panelsTab).toContain('orderDeletedReferenceClassName');
    expect(panelsCss).toContain('.bazis-panels-table .ant-table-tbody > tr.order-deleted-reference-row > td');
    expect(panelsTab).toContain('/orders/show/');
    // Клик по ссылке не должен триггерить выбор строки (row onClick)
    expect(panelsTab).toMatch(/RouterLink[\s\S]*?stopPropagation/);
  });

  it('ViewerTree marks nodes that are already in an ERP order with the order NAME', () => {
    expect(viewerTree).toContain('order.orderName');
    expect(viewerTree).toContain('formatTreeOrderRef');
    expect(viewerTree).toContain('(удалён)');
    expect(viewerTree).toContain('ORDER_DELETED_REFERENCE_LINE_CLASS');
    expect(nodeCard).toContain('ORDER_DELETED_REFERENCE_LINE_CLASS');
  });
});
