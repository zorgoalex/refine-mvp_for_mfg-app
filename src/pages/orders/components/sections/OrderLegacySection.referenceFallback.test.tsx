import { beforeEach, describe, expect, it, vi } from 'vitest';

const useSelectMock = vi.hoisted(() => vi.fn(() => ({
  selectProps: { options: [{ label: 'Legacy option', value: 1 }] },
})));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useMemo: (factory: () => unknown) => factory(),
  };
});

vi.mock('../../../../query/orderLifecycleQueries', () => ({
  useSelect: useSelectMock,
}));

vi.mock('../../../../stores/orderFormStore', () => ({
  useOrderFormStore: () => ({
    header: {
      sheet_material_type_id: null,
      milling_type_id: null,
      edge_type_id: null,
      film_id: null,
    },
    updateHeaderField: vi.fn(),
  }),
}));

vi.mock('../../../../hooks/useOrderFormData', () => ({
  useOrderFormData: () => ({
    enabled: false,
    isLoading: false,
    references: {
      millingTypes: [],
      edgeTypes: [],
      films: [],
    },
  }),
  createBackendSelectProps: vi.fn(),
}));

vi.mock('../../../../hooks/useSheetMaterialOptions', () => ({
  useSheetMaterialOptions: () => ({
    options: [],
    isLoading: false,
    promoteUsage: vi.fn(),
  }),
  toSheetSelectOptions: () => [],
}));

import { OrderLegacySection } from './OrderLegacySection';

describe('OrderLegacySection reference fallback', () => {
  beforeEach(() => {
    useSelectMock.mockClear();
  });

  it('enables every legacy detail lookup after the aggregate reference request fails', () => {
    OrderLegacySection({});

    expect(useSelectMock).toHaveBeenCalledTimes(3);
    expect(useSelectMock.mock.calls.map(([options]) => ({
      resource: options.resource,
      enabled: options.queryOptions?.enabled,
    }))).toEqual([
      { resource: 'milling_types', enabled: true },
      { resource: 'edge_types', enabled: true },
      { resource: 'films', enabled: true },
    ]);
  });
});
