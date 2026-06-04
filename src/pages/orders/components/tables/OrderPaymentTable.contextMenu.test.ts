import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('OrderPaymentTable context menu implementation', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/pages/orders/components/tables/OrderPaymentTable.tsx'),
    'utf8',
  );

  it('uses React and AntD Dropdown instead of imperative DOM menu creation', () => {
    expect(source).toContain('Dropdown');
    expect(source).toContain('MenuProps');
    expect(source).toContain('paymentContextMenu');
    expect(source).not.toContain('document.createElement');
    expect(source).not.toContain('innerHTML');
    expect(source).not.toContain('querySelectorAll');
    expect(source).not.toContain('addEventListener');
    expect(source).not.toContain('order-payment-context-menu');
  });
});
