import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const showSource = readFileSync('src/pages/orders/show.tsx', 'utf8');
const formSource = readFileSync('src/pages/orders/components/OrderForm.tsx', 'utf8');
const paymentsTabSource = readFileSync(
  'src/pages/orders/components/tabs/OrderPaymentsTab.tsx',
  'utf8',
);
const showHeaderSource = readFileSync(
  'src/pages/orders/components/sections/OrderShowHeader.tsx',
  'utf8',
);

describe('order show finance action wiring', () => {
  it('routes Add payment to the edit Finance tab', () => {
    expect(showSource).toContain('Добавить платёж');
    expect(showSource).toContain('buildOrderEditAddPaymentPath');
    expect(formSource).toContain('readAddPaymentIntent');
    expect(formSource).toContain('paymentsTabRef.current');
    expect(formSource).toContain('clearAddPaymentIntent');
    expect(paymentsTabSource).toContain('addInlinePayment');
  });

  it('shows only the current production status in the view summary', () => {
    expect(showSource).toContain('"production_status_id"');
    expect(showSource).toContain('"production_status_name"');
    expect(showHeaderSource).toContain('resolveCurrentProductionStatusCodes');
    expect(showHeaderSource).toContain('currentProductionStatusCodes');
    expect(showHeaderSource).not.toContain('productionEventsData');
  });
});
