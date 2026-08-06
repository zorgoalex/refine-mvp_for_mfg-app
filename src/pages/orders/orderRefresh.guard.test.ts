import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('order refresh UI wiring', () => {
  it('uses the backend refresh command from both view and edit forms', () => {
    const show = read('./show.tsx');
    const edit = read('./components/tabs/OrderDetailsTab.tsx');

    expect(show).toContain('ordersApi.refresh(orderId, { version: currentVersion })');
    expect(show).toContain('{canUpdateOrders && (');
    expect(show).not.toContain('handleRefreshPaymentStatus');
    expect(edit).toContain('ordersApi.refresh(orderId, { version: baseVersion })');
    expect(edit).toContain('icon={<ReloadOutlined />}');
    expect(edit).toContain('<OrderToolbarLabel>Обновить</OrderToolbarLabel>');
    expect(edit).not.toContain('CalculatorOutlined');
    expect(edit).not.toContain('Пересчитать суммы');
  });

  it('rejects foreign version drift before merging a dirty draft', () => {
    const edit = read('./components/tabs/OrderDetailsTab.tsx');
    expect(edit).toContain('response.order.version !== response.version');
    expect(edit.indexOf('response.order.version !== response.version')).toBeLessThan(
      edit.indexOf('mergeOrderRefreshDetails(currentDetails, serverDetails)'),
    );
  });
});
