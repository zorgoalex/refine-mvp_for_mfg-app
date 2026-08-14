import { describe, expect, it } from 'vitest';
import {
  resolveOrderTabLabel,
  resolveTabLabel,
  RESOURCE_LABELS,
  shouldPreserveTabLabel,
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
    expect(resolveTabLabel('/sheet-material-types/show/3')).toBe('Листовые материалы · Просмотр #3');
    expect(resolveTabLabel('/sheet-material-types/edit/3')).toBe('Листовые материалы · Редактирование #3');
    expect(resolveTabLabel('/sheet-material-types/create')).toBe('Листовые материалы · Создание');
    expect(resolveTabLabel('/extra-resources')).toBe('Доп. ресурсы');
  });
  it('normalizes kebab-case resource paths to known resource labels', () => {
    expect(resolveTabLabel('/material-types/edit/2')).toBe('Типы материалов · Редактирование #2');
  });
  it('labels the cut page tab "Раскрой", not the raw path', () => {
    expect(resolveTabLabel('/cut')).toBe('Раскрой');
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
