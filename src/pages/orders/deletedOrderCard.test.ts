import { describe, expect, it } from 'vitest';

import type { OrderDto } from '../../api/types/orderApi.types';
import { buildDeletedOrderCardModel } from './deletedOrderCard';

const deletedOrder: OrderDto = {
  header: {
    orderId: 42,
    orderName: 'Ф-42',
    clientId: 7,
    clientName: 'Тест Клиент',
    orderDate: '2026-07-01',
    orderStatusId: 1,
    deleteFlag: true,
    deletedAt: '2026-07-14T12:34:00.000Z',
    deletedByName: 'Иван Петров',
  },
  details: [
    {
      id: 1,
      detailNumber: 1,
      height: 100,
      width: 200,
      quantity: 1,
      materialId: null,
      millingTypeId: 1,
      edgeTypeId: 1,
      detailCost: 500,
    },
    {
      id: 2,
      detailNumber: 2,
      height: 300,
      width: 400,
      quantity: 2,
      materialId: null,
      millingTypeId: 1,
      edgeTypeId: 1,
      detailCost: 900,
    },
  ],
  payments: [],
  workshops: [],
  requirements: [],
  dowelingLinks: [],
  primaryGroup: null,
  groups: [],
  totals: {
    totalAmount: 1800,
    finalAmount: 1500,
    paidAmount: 0,
    debtAmount: 1500,
    partsCount: 2,
    totalArea: 1.5,
  },
  version: 4,
};

describe('buildDeletedOrderCardModel', () => {
  it('builds model from deleted OrderDto header/totals/details', () => {
    expect(buildDeletedOrderCardModel(deletedOrder)).toEqual({
      orderId: 42,
      orderName: 'Ф-42',
      clientName: 'Тест Клиент',
      finalAmount: 1500,
      orderDate: '2026-07-01',
      deletedAt: '2026-07-14T12:34:00.000Z',
      deletedByName: 'Иван Петров',
      version: 4,
      detailsCount: 2,
    });
  });

  it('returns null for alive order', () => {
    expect(
      buildDeletedOrderCardModel({
        ...deletedOrder,
        header: {
          ...deletedOrder.header,
          deleteFlag: false,
        },
      }),
    ).toBeNull();
  });
});
