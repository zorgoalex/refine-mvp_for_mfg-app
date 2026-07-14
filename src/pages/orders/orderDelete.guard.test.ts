import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const showSource = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
const orderFormSource = readFileSync(new URL('./components/OrderForm.tsx', import.meta.url), 'utf8');

describe('order delete guards', () => {
  it('delete button is gated by the unified permission gate in BOTH cards', () => {
    for (const source of [showSource, orderFormSource]) {
      expect(source).toMatch(/canManageOrderTrash\s*=\s*!featureFlags\.useBackendPermissions\s*\|\|\s*can\('orders\.delete'\)/);
      expect(source).toContain('featureFlags.useBackendOrdersWrite && canManageOrderTrash');
      expect(source).toContain('Popconfirm');
      expect(source).toContain('ordersApi.delete');
    }
  });
});
