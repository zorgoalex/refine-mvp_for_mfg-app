import { describe, expect, it } from 'vitest';
import { resolveTabLabel, RESOURCE_LABELS } from './tabLabels';

describe('resolveTabLabel', () => {
  it('maps a list route to its resource label', () => {
    expect(resolveTabLabel('/orders')).toBe('Заказы');
    expect(resolveTabLabel('/calendar')).toBe('Календарь');
  });
  it('labels an order edit route with the id and edit suffix', () => {
    expect(resolveTabLabel('/orders/edit/11195')).toBe('Заказ #11195 · Редактирование');
  });
  it('labels an order show route with the id only', () => {
    expect(resolveTabLabel('/orders/show/11195')).toBe('Заказ #11195');
  });
  it('distinguishes list, show, create and edit tabs for reference resources', () => {
    expect(resolveTabLabel('/sheet-material-types')).toBe('Листовые материалы');
    expect(resolveTabLabel('/sheet-material-types/show/3')).toBe('Листовые материалы · Просмотр #3');
    expect(resolveTabLabel('/sheet-material-types/edit/3')).toBe('Листовые материалы · Редактирование #3');
    expect(resolveTabLabel('/sheet-material-types/create')).toBe('Листовые материалы · Создание');
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
  });
});
