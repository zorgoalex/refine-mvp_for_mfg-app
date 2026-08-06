import { describe, expect, it } from 'vitest';
import {
  ordersViewStorageKey,
  resolveOrdersViewMode,
  setOrdersViewQuery,
} from './ordersViewMode';

describe('orders tablet view state', () => {
  it('prefers a valid query then user fallback then list', () => {
    expect(resolveOrdersViewMode('cards', 'list')).toBe('cards');
    expect(resolveOrdersViewMode('board', 'cards')).toBe('board');
    expect(resolveOrdersViewMode('invalid', 'cards')).toBe('cards');
    expect(resolveOrdersViewMode(null, 'board')).toBe('list');
    expect(resolveOrdersViewMode(null, 'invalid')).toBe('list');
  });

  it('uses a user-scoped storage key', () => {
    expect(ordersViewStorageKey('7')).toBe('erp.ui.tablet.orders.view.7');
    expect(ordersViewStorageKey(null)).toBeNull();
  });

  it('preserves unrelated table query parameters', () => {
    expect(setOrdersViewQuery('?current=3&sorters=x', 'cards')).toBe('?current=3&sorters=x&view=cards');
  });
});
