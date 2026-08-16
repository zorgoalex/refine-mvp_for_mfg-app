import { useEffect, useMemo, useState } from 'react';
import { authSession } from '../api/authSession';
import { subscribeOrderFormReferencesChanged } from '../api/orderFormReferenceEvents';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';
import { featureFlags } from '../config/featureFlags';
import { resolveDefaultNewOrderStatusId } from '../domain/orderStatusDefaults';
import {
  getCachedOrderFormData,
  getOrderFormDataCacheGeneration,
  invalidateOrderFormDataCache,
  isOrderFormDataCacheStale,
  prefetchOrderFormData,
} from '../query/orderFormDataCache';
import { useOrderLifecycleReadActive } from '../query/orderLifecycleQueries';

export {
  invalidateOrderFormDataCache,
  prefetchOrderFormData,
  resetOrderFormDataCacheForTests,
} from '../query/orderFormDataCache';

export interface ReferenceOption {
  label: string;
  value: number;
  sortOrder: number;
}

// SP3: richer option for the sheet-material picker — carries dimensions (FE
// dimension mirror) and is_active (disable, not drop, a deactivated-but-selected
// sheet). Absent entirely when the caller lacks sheet_materials.view.
// Variant B: isCuttable=false = header-only material; DETAIL picker must exclude
// these (HEADER picker keeps the full list).
export interface SheetMaterialTypeOption extends ReferenceOption {
  widthMm: number | null;
  heightMm: number | null;
  isActive: boolean;
  isCuttable: boolean;
}

export interface OrderFormDataReferences {
  clients: ReferenceOption[];
  materials: ReferenceOption[];
  millingTypes: ReferenceOption[];
  edgeTypes: ReferenceOption[];
  films: ReferenceOption[];
  orderStatuses: ReferenceOption[];
  paymentStatuses: ReferenceOption[];
  paymentTypes: ReferenceOption[];
  productionStatuses: ReferenceOption[];
  workshops: ReferenceOption[];
  employees: ReferenceOption[];
  units: ReferenceOption[];
  // SP3: empty array when the response omitted it (no sheet_materials.view).
  sheetMaterialTypes: SheetMaterialTypeOption[];
  defaultOrderStatus: number | undefined;
  defaultPaymentStatus: number | undefined;
  defaultProductionStatus: number | undefined;
  materialNameById: Map<number, string>;
  millingTypeNameById: Map<number, string>;
  edgeTypeNameById: Map<number, string>;
  filmNameById: Map<number, string>;
  paymentTypeNameById: Map<number, string>;
  productionStatusNameById: Map<number, string>;
}

interface UseOrderFormDataResult {
  enabled: boolean;
  data: OrderFormDataResponse | null;
  references: OrderFormDataReferences;
  isLoading: boolean;
  error: Error | null;
}

export function useOrderFormData(enabled = featureFlags.useBackendReferences): UseOrderFormDataResult {
  const lifecycleReadActive = useOrderLifecycleReadActive();
  const readEnabled = enabled && lifecycleReadActive;
  const cacheGeneration = getOrderFormDataCacheGeneration();
  const [dataState, setDataState] = useState<{
    generation: number;
    data: OrderFormDataResponse | null;
  }>(() => ({
    generation: cacheGeneration,
    data: enabled ? getCachedOrderFormData() : null,
  }));
  const data = dataState.generation === cacheGeneration
    ? dataState.data
    : (enabled ? getCachedOrderFormData() : null);
  const [isLoading, setIsLoading] = useState(() => readEnabled && !getCachedOrderFormData());
  const [error, setError] = useState<Error | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [, setAuthRevision] = useState(0);

  useEffect(() => authSession.subscribe(() => {
    setAuthRevision((revision) => revision + 1);
  }), []);

  useEffect(() => {
    if (!readEnabled) return;

    const refresh = () => {
      invalidateOrderFormDataCache();
      setRefreshVersion((version) => version + 1);
    };
    const unsubscribe = subscribeOrderFormReferencesChanged(refresh);

    // Covers reference changes made in another browser/session: returning to
    // the order tab refreshes the aggregate without reloading the order page.
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', refresh);
    }

    return () => {
      unsubscribe();
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', refresh);
      }
    };
  }, [readEnabled]);

  useEffect(() => {
    if (!enabled) {
      setDataState({ generation: cacheGeneration, data: null });
      setIsLoading(false);
      setError(null);
      return;
    }
    if (!lifecycleReadActive) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setError(null);

    const cachedFormData = getCachedOrderFormData();
    if (cachedFormData && !isOrderFormDataCacheStale() && refreshVersion === 0) {
      setDataState({ generation: cacheGeneration, data: cachedFormData });
      setIsLoading(false);
      return;
    }

    const isBackgroundRefresh = data !== null;
    if (!isBackgroundRefresh) {
      setIsLoading(true);
    }
    const requestGeneration = cacheGeneration;
    prefetchOrderFormData()
      .then((response) => {
        if (
          cancelled
          || requestGeneration !== getOrderFormDataCacheGeneration()
        ) return;
        setDataState({ generation: requestGeneration, data: response });
      })
      .catch((unknownError) => {
        if (
          cancelled
          || requestGeneration !== getOrderFormDataCacheGeneration()
        ) return;
        setError(toError(unknownError));
      })
      .finally(() => {
        if (
          !cancelled
          && requestGeneration === getOrderFormDataCacheGeneration()
        ) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cacheGeneration, enabled, lifecycleReadActive, refreshVersion]);

  const references = useMemo(() => mapOrderFormDataToReferences(data), [data]);

  return {
    enabled,
    data,
    references,
    isLoading,
    error,
  };
}

export function mapOrderFormDataToReferences(
  data: OrderFormDataResponse | null,
): OrderFormDataReferences {
  const empty: ReferenceOption[] = [];
  const clients = data ? toOptions(data.clients, (item) => item.name) : empty;
  const materials = data ? toOptions(data.materials, (item) => item.name) : empty;
  const millingTypes = data ? toOptions(data.millingTypes, (item) => item.name) : empty;
  const edgeTypes = data ? toOptions(data.edgeTypes, (item) => item.name) : empty;
  const films = data ? toOptions(data.films, (item) => item.name) : empty;
  const orderStatuses = data ? toOptions(data.orderStatuses, (item) => item.name) : empty;
  const paymentStatuses = data ? toOptions(data.paymentStatuses, (item) => item.name) : empty;
  const paymentTypes = data ? toOptions(data.paymentTypes, (item) => item.name) : empty;
  const productionStatuses = data ? toOptions(data.productionStatuses, (item) => item.name) : empty;
  const workshops = data ? toOptions(data.workshops, (item) => item.name) : empty;
  const employees = data ? toOptions(data.employees, (item) => item.fullName) : empty;
  const units = data ? toOptions(data.units, (item) => item.name) : empty;
  // Absent field (no sheet_materials.view) maps to [] — the picker is hidden anyway.
  const sheetMaterialTypes: SheetMaterialTypeOption[] = data?.sheetMaterialTypes
    ? data.sheetMaterialTypes.map((item) => ({
        label: item.name,
        value: item.id,
        widthMm: item.widthMm ?? null,
        heightMm: item.heightMm ?? null,
        isActive: item.isActive,
        isCuttable: item.isCuttable,
        sortOrder: item.sortOrder,
      }))
    : [];

  return {
    clients,
    materials,
    millingTypes,
    edgeTypes,
    films,
    orderStatuses,
    paymentStatuses,
    paymentTypes,
    productionStatuses,
    workshops,
    employees,
    units,
    sheetMaterialTypes,
    defaultOrderStatus: resolveDefaultNewOrderStatusId(orderStatuses),
    defaultPaymentStatus: paymentStatuses[0]?.value,
    defaultProductionStatus: productionStatuses[0]?.value,
    materialNameById: toNameMap(materials),
    millingTypeNameById: toNameMap(millingTypes),
    edgeTypeNameById: toNameMap(edgeTypes),
    filmNameById: toNameMap(films),
    paymentTypeNameById: toNameMap(paymentTypes),
    productionStatusNameById: toNameMap(productionStatuses),
  };
}

export function createBackendSelectProps(options: ReferenceOption[], isLoading = false) {
  return {
    options,
    loading: isLoading,
  };
}

function toOptions<T extends { id: number }>(
  items: T[],
  getLabel: (item: T) => string,
): ReferenceOption[] {
  return items.map((item) => ({
    label: getLabel(item),
    value: item.id,
    sortOrder: item.sortOrder,
  }));
}

function toNameMap(options: ReferenceOption[]): Map<number, string> {
  return new Map(options.map((option) => [option.value, option.label]));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Failed to load order form data');
}
