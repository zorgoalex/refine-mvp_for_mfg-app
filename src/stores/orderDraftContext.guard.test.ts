import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

describe('order draft store is context-scoped', () => {
  it('store module exports provider + imperative accessor', () => {
    const store = read('./orderFormStore.ts');
    expect(store).toContain('OrderDraftStoreProvider');
    expect(store).toContain('useOrderDraftStoreApi');
    expect(store).toContain('OrderDraftStoreContext');
  });

  it('OrderForm wraps its subtree in the provider', () => {
    const form = read('../pages/orders/components/OrderForm.tsx');
    expect(form).toContain('<OrderDraftStoreProvider');
  });

  it('no component reads the unscoped singleton via static getState', () => {
    const files = [
      '../pages/orders/components/OrderForm.tsx',
      '../pages/orders/components/tabs/OrderDetailsTab.tsx',
      '../pages/orders/components/tabs/OrderPaymentsTab.tsx',
      '../pages/orders/components/OrderHeaderContextMenu.tsx',
    ];
    for (const f of files) {
      expect(read(f)).not.toContain('useOrderFormStore.getState()');
    }
  });
});
