import { describe, expect, it } from 'vitest';
import type { SaveOrderDto } from '../dto/save-order.dto';
import { OrderValidationError } from '../errors/order.errors';
import { normalizeSaveOrderDto } from './order-normalizer';

function createRawOrder(overrides: Partial<SaveOrderDto> = {}): SaveOrderDto {
  return {
    header: {
      orderName: ' Test order ',
      clientId: 1001,
      orderDate: '2026-04-30',
      priority: undefined,
      orderStatusId: 1001,
      productionStatusFromDetailsEnabled: undefined,
      discount: undefined,
      surcharge: undefined,
      notes: ' ',
    },
    details: [
      {
        clientId: 'legacy-temp-1',
        detailNumber: 10,
        detailName: ' фасад ',
        height: '550' as unknown as number,
        width: 200,
        quantity: '2' as unknown as number,
        materialId: 1001,
        millingTypeId: 1001,
        edgeTypeId: 1001,
        filmId: '',
        detailCost: '10000.25' as unknown as number,
        note: '',
      },
      {
        height: 0,
        width: 0,
        quantity: 0,
        materialId: 0,
        millingTypeId: 0,
        edgeTypeId: 0,
      },
    ],
    payments: [
      {
        clientKey: 'payment-temp-1',
        typePaidId: 1001,
        amount: '3000' as unknown as number,
        paymentDate: '2026-04-30',
        notes: '',
      },
      {
        typePaidId: 0,
        amount: 0,
        paymentDate: '',
      },
    ],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deleted: {
      detailIds: ['11'] as unknown as number[],
    },
    ...overrides,
  };
}

describe('normalizeSaveOrderDto', () => {
  it('normalizes strings, numeric values, blank rows and deleted arrays', () => {
    const normalized = normalizeSaveOrderDto(createRawOrder());

    expect(normalized.header).toMatchObject({
      orderName: 'Test order',
      priority: 100,
      productionStatusFromDetailsEnabled: true,
      discount: 0,
      surcharge: 0,
      notes: null,
    });
    expect(normalized.details).toHaveLength(1);
    expect(normalized.details[0]).toMatchObject({
      clientKey: 'legacy-temp-1',
      detailName: 'фасад',
      height: 550,
      quantity: 2,
      filmId: null,
      detailCost: 10000.25,
      note: null,
    });
    expect(normalized.payments).toHaveLength(1);
    expect(normalized.payments[0]).toMatchObject({
      clientKey: 'payment-temp-1',
      amount: 3000,
      notes: null,
    });
    expect(normalized.deleted).toEqual({
      detailIds: [11],
      paymentIds: [],
      workshopIds: [],
      requirementIds: [],
      dowelingLinkIds: [],
    });
  });

  it('rejects missing required aggregate arrays', () => {
    const invalid = {
      ...createRawOrder(),
      details: undefined,
    } as unknown as SaveOrderDto;

    expect(() => normalizeSaveOrderDto(invalid)).toThrow(OrderValidationError);
  });

  it('rejects ambiguous numeric strings', () => {
    const invalid = createRawOrder({
      details: [
        {
          height: '5,5' as unknown as number,
          width: 200,
          quantity: 1,
          materialId: 1001,
          millingTypeId: 1001,
          edgeTypeId: 1001,
        },
      ],
    });

    expect(() => normalizeSaveOrderDto(invalid)).toThrow(OrderValidationError);
  });
});
