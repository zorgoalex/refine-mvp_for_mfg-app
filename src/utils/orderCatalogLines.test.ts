import { describe, it, expect } from 'vitest';
import { orderCatalogLineAmount, orderCatalogSubtotal, orderCatalogLineInput, type OrderCatalogLine } from './orderCatalogLines';
import { orderFormSchema } from '../schemas/orderSchema';

const row: OrderCatalogLine = { id: 1, catalogItemId: 3, catalogVersion: 1, name: 'Доставка', kind: 'service',
  sku: null, unitId: 1, unitName: 'шт', refKey1c: null, quantity: '2', unitPrice: '1500.50', notes: 'draft', catalogActive: true };
const form = { header: { order_name: 'E2E-catalog', client_id: 1, order_date: '2026-09-10', order_status_id: 1, payment_status_id: 1 },
  details: [], payments: [], workshops: [], requirements: [], catalogLines: [row] };

describe('order catalogue preview and save boundary', () => {
  it.each([['2', '1500.50', '3001.00'], ['1.5', '0.01', '0.02'], ['1', '0', '0.00'], ['0', '1', null],
    ['1.0001', '1', null], ['1', '', null], ['1', '1e2', null], ['999999999', '9999999999.99', null]])('amount %s × %s', (q, p, expected) => {
    expect(orderCatalogLineAmount(q, p)).toBe(expected);
  });
  it('sends only editable fields, never trusted snapshot/amount', () => {
    expect(orderCatalogLineInput(row)).toEqual({ id: 1, clientKey: undefined, catalogItemId: 3, catalogVersion: 1, quantity: '2', unitPrice: '1500.50', notes: 'draft' });
    expect(orderCatalogSubtotal([row, row])).toBe(6002);
  });
  it('accepts goods-only, rejects empty composition and invalid product amount', () => {
    expect(orderFormSchema.safeParse(form).success).toBe(true);
    expect(orderFormSchema.safeParse({ ...form, catalogLines: [] }).success).toBe(false);
    expect(orderFormSchema.safeParse({ ...form, catalogLines: [], details: [{ is_placeholder: true }] }).success).toBe(false);
    expect(orderFormSchema.safeParse({ ...form, details: [{ is_placeholder: true }] }).success).toBe(true);
    expect(orderFormSchema.safeParse({ ...form, catalogLines: [{ ...row, quantity: '999999999', unitPrice: '9999999999.99' }] }).success).toBe(false);
  });
});
