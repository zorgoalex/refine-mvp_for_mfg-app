import { describe, expect, it } from 'vitest';
import type { SaveOrderDto } from '../dto/save-order.dto';
import { OrderFinalAmountNegativeError } from '../errors/order.errors';
import { prepareOrderSave } from './order-save-preparer';

function createOrder(overrides: Partial<SaveOrderDto> = {}): SaveOrderDto {
  return {
    header: {
      orderName: 'Test order',
      clientId: 1001,
      orderDate: '2026-04-30',
      orderStatusId: 1001,
      discount: 500,
      surcharge: 0,
    },
    details: [
      {
        clientKey: 'detail-temp-1',
        height: 550,
        width: 200,
        quantity: 2,
        materialId: 1001,
        millingTypeId: 1001,
        edgeTypeId: 1001,
        detailCost: 10000,
      },
    ],
    payments: [
      {
        clientKey: 'payment-temp-1',
        typePaidId: 1001,
        amount: 3000,
        paymentDate: '2026-04-30',
      },
    ],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deleted: {},
    ...overrides,
  };
}

describe('prepareOrderSave', () => {
  it('normalizes, validates and calculates an order save payload', () => {
    const prepared = prepareOrderSave(createOrder(), { mode: 'create' });

    expect(prepared.order.details[0].clientKey).toBe('detail-temp-1');
    expect(prepared.details[0]).toMatchObject({
      detailNumber: 1,
      area: 0.22,
      detailCost: 10000,
    });
    expect(prepared.totals).toMatchObject({
      totalAmount: 10000,
      finalAmount: 9500,
      paidAmount: 3000,
      debtAmount: 6500,
      paymentStatusId: 2,
    });
  });

  it('surfaces negative final amount as an API error before any DB work', () => {
    expect(() =>
      prepareOrderSave(
        createOrder({
          header: {
            orderName: 'Test order',
            clientId: 1001,
            orderDate: '2026-04-30',
            orderStatusId: 1001,
            discount: 100,
            surcharge: 0,
          },
          details: [],
          payments: [],
        }),
        { mode: 'create' },
      ),
    ).toThrow(OrderFinalAmountNegativeError);
  });
});
