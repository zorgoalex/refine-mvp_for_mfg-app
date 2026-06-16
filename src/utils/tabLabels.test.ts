import { describe, expect, it } from 'vitest';
import { resolveTabLabel, RESOURCE_LABELS } from './tabLabels';

describe('resolveTabLabel', () => {
  it('maps a list route to its resource label', () => {
    expect(resolveTabLabel('/orders')).toBe('Заказы');
    expect(resolveTabLabel('/calendar')).toBe('Календарь');
  });
  it('labels an order edit route with the id', () => {
    expect(resolveTabLabel('/orders/edit/11195')).toBe('Заказ #11195');
  });
  it('labels an order show route with the id', () => {
    expect(resolveTabLabel('/orders/show/11195')).toBe('Заказ #11195');
  });
  it('falls back to the last segment for unknown routes', () => {
    expect(resolveTabLabel('/unknown-thing')).toBe('unknown-thing');
  });
  it('exposes RESOURCE_LABELS for the sider', () => {
    expect(RESOURCE_LABELS.orders_view).toBe('Заказы');
  });
});
