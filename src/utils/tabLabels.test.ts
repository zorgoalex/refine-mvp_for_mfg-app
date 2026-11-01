import { describe, expect, it } from 'vitest';
import {
  resolveOrderTabLabel,
  resolveTabLabel,
  resourceFromPath,
  RESOURCE_LABELS,
  shouldPreserveTabLabel,
  tabLabelHasRecordId,
  tabLabelNeedsName,
} from './tabLabels';

describe('resolveTabLabel', () => {
  it('maps a list route to its resource label', () => {
    expect(resolveTabLabel('/orders')).toBe('Заказы');
    expect(resolveTabLabel('/calendar')).toBe('Календарь');
    expect(resolveTabLabel('/order-status-board')).toBe('Доски статусов');
    expect(resolveTabLabel('/mdf-work-board')).toBe('МДФ-работы');
    expect(resolveTabLabel('/groups')).toBe('Группы');
  });
  it('does not expose an order id in an edit tab before the record loads', () => {
    expect(resolveTabLabel('/orders/edit/11195')).toBe('Заказ');
  });
  it('does not expose an order id in a show tab before the record loads', () => {
    expect(resolveTabLabel('/orders/show/11195')).toBe('Заказ');
  });
  it('uses only the loaded order name as the tab label', () => {
    expect(resolveOrderTabLabel('  Кухня-25  ')).toBe('Кухня-25');
    expect(resolveOrderTabLabel(null)).toBe('Заказ');
  });
  it('distinguishes list, show, create and edit tabs for reference resources', () => {
    expect(resolveTabLabel('/sheet-material-types')).toBe('Листовые материалы');
    expect(resolveTabLabel('/sheet-material-types/show/3')).toBe('Листовые материалы · Просмотр');
    expect(resolveTabLabel('/sheet-material-types/edit/3')).toBe('Листовые материалы · Редактирование');
    expect(resolveTabLabel('/sheet-material-types/create')).toBe('Листовые материалы · Создание');
    expect(resolveTabLabel('/extra-resources')).toBe('Доп. ресурсы');
  });
  it('normalizes kebab-case resource paths to known resource labels', () => {
    expect(resolveTabLabel('/material-types/edit/2')).toBe('Типы материалов · Редактирование');
  });
  it('labels the cut page tab "Раскрой", not the raw path', () => {
    expect(resolveTabLabel('/cut')).toBe('Раскрой');
  });
  it('labels the 1C documents list and card tabs despite the nested /procurement path', () => {
    expect(resolveTabLabel('/procurement/onec-documents')).toBe('Документы 1С');
    expect(resolveTabLabel('/procurement/onec-documents/show/42')).toBe('Документы 1С · Просмотр');
    expect(resourceFromPath('/procurement/onec-documents')).toBe('onec_purchase_documents');
    expect(resourceFromPath('/procurement/onec-documents/show/42')).toBe('onec_purchase_documents');
  });
  it('falls back to the last segment for unknown routes', () => {
    expect(resolveTabLabel('/unknown-thing')).toBe('unknown-thing');
  });
  it('exposes RESOURCE_LABELS for the sider', () => {
    expect(RESOURCE_LABELS.orders_view).toBe('Заказы');
    expect(RESOURCE_LABELS.groups).toBe('Группы');
    expect(RESOURCE_LABELS['order-status-board']).toBe('Доски статусов');
    expect(RESOURCE_LABELS['mdf-work-board']).toBe('МДФ-работы');
    expect(RESOURCE_LABELS.audit).toBe('Журналы');
  });
});

describe('shouldPreserveTabLabel', () => {
  it('preserves record-backed labels that are enriched after loading', () => {
    expect(shouldPreserveTabLabel('/orders/edit/42')).toBe(true);
    expect(shouldPreserveTabLabel('/materials/show/7')).toBe(true);
    expect(shouldPreserveTabLabel('/bazis/projects/6')).toBe(true);
    expect(shouldPreserveTabLabel('/bazis-cut/9')).toBe(true);
  });

  it('lets route sync restore labels for static and create pages', () => {
    expect(shouldPreserveTabLabel('/orders')).toBe(false);
    expect(shouldPreserveTabLabel('/cut')).toBe(false);
    expect(shouldPreserveTabLabel('/materials/create')).toBe(false);
  });
});

describe('tab names never carry a record id', () => {
  it('labels record tabs by resource and action until the name is known', () => {
    expect(resolveTabLabel('/clients/show/2606')).toBe('Клиенты · Просмотр');
    expect(resolveTabLabel('/cad/orders/11842')).toBe('CAD · заказ');
    expect(resolveTabLabel('/bazis/projects/6')).toBe('Базис-проект');
    expect(resolveTabLabel('/bazis-cut/9')).toBe('Базис-раскрой');
    for (const path of ['/clients/show/2606', '/cad/orders/11842', '/bazis/projects/6', '/bazis-cut/9', '/orders/show/11842']) {
      expect(resolveTabLabel(path)).not.toMatch(/\d/);
    }
  });

  it('asks for a name only on the id-free default label of a record tab', () => {
    expect(tabLabelNeedsName('/clients/show/2606', 'Клиенты · Просмотр')).toBe(true);
    expect(tabLabelNeedsName('/clients/show/2606', 'Клиенты · Просмотр · Ғибрат Шадет')).toBe(false);
    expect(tabLabelNeedsName('/clients/show/2606', 'Клиенты · Просмотр · #2606')).toBe(false); // имя «#2606» — имя
    expect(tabLabelNeedsName('/orders/show/11842', 'Заказ')).toBe(true);
    expect(tabLabelNeedsName('/orders/show/11842', '3087')).toBe(false); // номер заказа — это имя, не id
    expect(tabLabelNeedsName('/bazis-cut/9', 'БР #9')).toBe(false);
    expect(tabLabelNeedsName('/clients', 'Клиенты')).toBe(false);
  });
});

describe('old tab labels with a record id', () => {
  it('spots them per route; an order number is a name, not an id', () => {
    expect(tabLabelHasRecordId('/clients/show/2606', 'Клиенты · Просмотр #2606')).toBe(true);
    expect(tabLabelHasRecordId('/bazis/projects/6', '6')).toBe(true);
    expect(tabLabelHasRecordId('/bazis-cut/9', 'БР #9')).toBe(true);
    expect(tabLabelHasRecordId('/cad/orders/11842', 'CAD · заказ 11842')).toBe(true);
    expect(tabLabelHasRecordId('/cad/orders/11842', 'CAD · заказ 3087')).toBe(false);
    expect(tabLabelHasRecordId('/orders/show/11842', '3087')).toBe(false);
    expect(tabLabelHasRecordId('/procurement/onec-documents/show/42', 'Документы 1С · Просмотр #42')).toBe(true);
    expect(tabLabelHasRecordId('/clients', 'Клиенты')).toBe(false);
    // настоящие имена с «#» и цифрами — не номер записи
    expect(tabLabelHasRecordId('/clients/show/2606', 'Клиенты · Просмотр · Магазин #12')).toBe(false);
    expect(tabLabelHasRecordId('/clients/show/2606', 'Клиенты · Просмотр · #12')).toBe(false);
    expect(tabLabelHasRecordId('/clients/show/2606', 'Клиенты · Просмотр · #2606')).toBe(true);
    expect(tabLabelHasRecordId('/bazis-cut/9', 'БР #10')).toBe(false);
  });
});
