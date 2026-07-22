import { describe, expect, it } from 'vitest';
import {
  BITRIX24_ENTITY_TYPE,
  hash,
  mapClient,
  mapOrder,
  mapPayment,
} from './bitrix24-sync-mapper';
import type { ClientRow, OrderRow, PaymentRow } from './crm-sync.types';

const options = {
  erpBaseUrl: 'https://erp.example/',
  currencyId: 'KZT',
  assignedById: 12,
  paySystemId: 6,
};

function client(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    clientId: '10',
    clientName: 'Иван Иванов',
    personType: 'individual',
    notes: null,
    isActive: true,
    phones: [{ phoneNumber: '+77001234567', phoneType: 'mobile', isPrimary: true }],
    ...overrides,
  };
}

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderId: '20',
    orderNumber: '20',
    orderName: '24001',
    clientId: '10',
    totalAmount: 100000,
    finalAmount: 90000,
    paidAmount: 40000,
    orderStatusName: 'В работе',
    paymentStatusName: 'Частично оплачен',
    orderDate: '2026-07-20',
    completionDate: null,
    deleteFlag: false,
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    paymentId: '30',
    orderId: '20',
    typePaidId: '1',
    typePaidName: 'Наличные',
    amount: 40000,
    paymentDate: '2026-07-20',
    notes: null,
    ...overrides,
  };
}

describe('Bitrix24 sync mapper', () => {
  it('maps individual to Contact with phones and external ID', () => {
    const result = mapClient(client(), 12);
    expect(result.entityTypeId).toBe(BITRIX24_ENTITY_TYPE.contact);
    expect(result.object).toBe('contact');
    expect(result.fields).toMatchObject({
      name: 'Иван Иванов',
      originatorId: 'MEBELKZ_ERP',
      originId: 'CLIENT_10',
      assignedById: 12,
      fm: [{ typeId: 'PHONE', valueType: 'MOBILE', value: '+77001234567' }],
    });
  });

  it('maps legal entity to Company', () => {
    const result = mapClient(client({ personType: 'legal', clientName: 'ТОО Мебель' }), null);
    expect(result.entityTypeId).toBe(BITRIX24_ENTITY_TYPE.company);
    expect(result.fields).toMatchObject({ title: 'ТОО Мебель' });
    expect(result.fields).not.toHaveProperty('assignedById');
  });

  it('maps one deal product at final amount and embeds ERP link', () => {
    const result = mapOrder(order(), { object: 'contact', id: '77' }, options);
    expect(result.fields).toMatchObject({
      opportunity: 90000,
      currencyId: 'KZT',
      contactId: 77,
      companyId: null,
      originId: 'ORDER_20',
    });
    expect(result.fields.comments).toContain('https://erp.example/orders/show/20');
    expect(result.productRows).toHaveLength(1);
    expect(result.productRows[0]).toMatchObject({ price: 90000, quantity: 1 });
  });

  it('falls back to total amount when a legacy order has no final amount', () => {
    const result = mapOrder(
      order({ finalAmount: null, totalAmount: 125000 }),
      { object: 'contact', id: '77' },
      options,
    );
    expect(result.fields.opportunity).toBe(125000);
    expect(result.productRows[0]?.price).toBe(125000);
  });

  it('maps ERP payment to paid native payment fields', () => {
    const result = mapPayment(payment(), options);
    expect(result.xmlId).toBe('MEBELKZ_ERP_PAYMENT_30');
    expect(result.fields).toMatchObject({
      paySystemId: 6,
      paid: 'Y',
      sum: 40000,
      psCurrency: 'KZT',
      xmlId: 'MEBELKZ_ERP_PAYMENT_30',
    });
  });

  it('hash is stable across object key order', () => {
    expect(hash({ a: 1, nested: { b: 2, a: 1 } }))
      .toBe(hash({ nested: { a: 1, b: 2 }, a: 1 }));
  });
});
