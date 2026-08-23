import { describe, expect, it } from 'vitest';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';
import { mapOrderFormDataToReferences } from './useOrderFormData';

describe('useOrderFormData mapping', () => {
  it('maps backend form-data response to select options, maps, and defaults', () => {
    const references = mapOrderFormDataToReferences(createFormDataResponse());

    expect(references.clients).toEqual([{ label: 'Client A', value: 1, sortOrder: 0 }]);
    expect(references.employees).toEqual([{ label: 'Manager A', value: 11, sortOrder: 0 }]);
    expect(references.defaultOrderStatus).toBe(2);
    expect(references.defaultPaymentStatus).toBe(3);
    expect(references.defaultProductionStatus).toBe(4);
    expect(references.materialNameById.get(5)).toBe('MDF');
    expect(references.millingTypeNameById.get(6)).toBe('Modern');
    expect(references.paymentTypeNameById.get(10)).toBe('Cash');
  });

  it('returns empty references when backend data is not loaded yet', () => {
    const references = mapOrderFormDataToReferences(null);

    expect(references.clients).toEqual([]);
    expect(references.defaultOrderStatus).toBeUndefined();
    expect(references.materialNameById.size).toBe(0);
  });

  it('keeps older backend sheet materials when isCuttable is omitted', () => {
    const data = {
      ...createFormDataResponse(),
      sheetMaterialTypes: [{
        id: 21,
        name: 'МДФ 16',
        widthMm: 2800,
        heightMm: 2070,
        isActive: true,
      }],
    } as OrderFormDataResponse;

    expect(mapOrderFormDataToReferences(data).sheetMaterialTypes).toEqual([{
      label: 'МДФ 16',
      value: 21,
      widthMm: 2800,
      heightMm: 2070,
      isActive: true,
      isCuttable: true,
      sortOrder: undefined,
    }]);
  });
});

function createFormDataResponse(): OrderFormDataResponse {
  return {
    clients: [{ id: 1, name: 'Client A' }],
    orderStatuses: [
      { id: 9, name: 'Заявка CRM', code: 'crm_request', color: null },
      { id: 2, name: 'Предварительный', code: 'preliminary', color: null },
    ],
    paymentStatuses: [{ id: 3, name: 'Unpaid', code: 'unpaid', color: null }],
    productionStatuses: [{ id: 4, name: 'Cut', code: 'cut', color: null }],
    materials: [{ id: 5, name: 'MDF', unitId: null }],
    millingTypes: [{ id: 6, name: 'Modern', costPerSqm: 120 }],
    edgeTypes: [{ id: 7, name: 'PVC' }],
    films: [{ id: 8, name: 'White' }],
    workshops: [{ id: 9, name: 'Main' }],
    paymentTypes: [{ id: 10, name: 'Cash' }],
    employees: [{ id: 11, fullName: 'Manager A' }],
    units: [{ id: 12, code: 'pcs', name: 'Pieces', symbol: 'pcs' }],
  };
}
