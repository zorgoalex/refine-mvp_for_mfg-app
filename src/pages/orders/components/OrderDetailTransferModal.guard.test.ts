import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'OrderDetailTransferModal.tsx'), 'utf8');

describe('OrderDetailTransferModal target selector', () => {
  it('renders target options with order, client, date, and order status', () => {
    expect(source).toContain('formatTargetOptionLabel(target)');
    expect(source).toContain('target.orderName');
    expect(source).toContain('target.clientName');
    expect(source).toContain('formatDate(target.orderDate)');
    expect(source).toContain('target.orderStatusName');
    expect(source).toContain('Статус заказа');
  });
});
