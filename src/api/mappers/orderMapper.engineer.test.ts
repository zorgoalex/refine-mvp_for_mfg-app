import { describe, expect, it } from 'vitest';
import type { Order, OrderFormValues } from '../../types/orders';
import { mapOrderFormToSaveOrderDto } from './orderMapper';

function createValues(): OrderFormValues {
  return {
    header: {
      order_id: 42,
      order_name: 'Тест: инженер заказа',
      client_id: 12,
      order_date: '2026-09-12',
      priority: 100,
      order_status_id: 1,
      payment_status_id: 1,
      discount: 0,
      paid_amount: 0,
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [{
      order_id: 42,
      doweling_order_id: 44,
      doweling_order: {
        doweling_order_id: 44,
        doweling_order_name: 'Тест: присадка',
        design_engineer_id: 9,
        design_engineer: 'Тест: инженер присадки',
      },
    }],
  };
}

const engineerFields: Pick<Order, 'design_engineer_id' | 'design_engineer'>[] = [
  {},
  { design_engineer_id: undefined, design_engineer: undefined },
  { design_engineer_id: null, design_engineer: null },
  { design_engineer_id: 7, design_engineer: 'Тест: инженер представления' },
];

describe('order engineer view fields and command boundary', () => {
  it.each(engineerFields)('does not change the outbound order command for %j', fields => {
    const values = createValues();
    const expectedDto = mapOrderFormToSaveOrderDto(values);
    values.header = { ...values.header, ...fields };
    const input = structuredClone(values);

    const dto = mapOrderFormToSaveOrderDto(values);

    expect(dto).toEqual(expectedDto);
    expect(values).toEqual(input);
    for (const key of ['design_engineer_id', 'design_engineer', 'designEngineerId', 'designEngineer']) {
      expect(dto.header).not.toHaveProperty(key);
    }
    // The actual linked engineer remains part of its own existing command shape.
    expect(dto.dowelingLinks[0].designEngineerId).toBe(9);
  });
});
