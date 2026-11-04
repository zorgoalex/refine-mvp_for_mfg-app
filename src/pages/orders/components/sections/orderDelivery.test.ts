import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orderDeliveryMethodLabel, orderDeliverySummary, orderStartShiftLabel } from './orderDelivery';

describe('order delivery and start shift (labels)', () => {
  it('labels and the card summary', () => {
    expect(orderDeliveryMethodLabel('courier')).toBe('Курьер');
    expect(orderDeliveryMethodLabel('pickup')).toBe('Самовывоз');
    expect(orderDeliveryMethodLabel('drone')).toBeNull();
    expect(orderStartShiftLabel(3)).toBe('3 смена');
    expect(orderStartShiftLabel(4)).toBeNull();
    expect(orderDeliverySummary({ delivery_method: 'courier', delivery_address: ' ул. Абая 1 ', start_shift: 2 })).toBe('Курьер · ул. Абая 1 · 2 смена');
    expect(orderDeliverySummary({})).toBeNull();
  });

  it('the form section writes the four header fields and the form mounts it; the card reads them from the backend order', () => {
    const section = readFileSync(new URL('./OrderDeliverySection.tsx', import.meta.url), 'utf8');
    for (const field of ['start_shift', 'delivery_method', 'delivery_address', 'delivery_notes']) {
      expect(section).toContain(`updateHeaderField('${field}'`);
    }
    const form = readFileSync(new URL('../OrderForm.tsx', import.meta.url), 'utf8');
    expect(form).toContain('<OrderDeliverySection />');
    const show = readFileSync(new URL('../../show.tsx', import.meta.url), 'utf8');
    expect(show).toContain('deliveryMethod={backendOrder?.header?.deliveryMethod}');
  });
});
