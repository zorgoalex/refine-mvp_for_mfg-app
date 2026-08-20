import { useEffect, useMemo, useState } from 'react';
import { ordersApi } from '../api/ordersApi';
import { subscribeOrderFormReferencesChanged } from '../api/orderFormReferenceEvents';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';
import { featureFlags } from '../config/featureFlags';
import { resolveDefaultNewOrderStatusId } from '../domain/orderStatusDefaults';

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

let cachedFormData: OrderFormDataResponse | null = null;
let pendingFormDataRequest: Promise<OrderFormDataResponse> | null = null;
let formDataCacheGeneration = 0;
let formDataCacheStale = false;

export function useOrderFormData(enabled = featureFlags.useBackendReferences): UseOrderFormDataResult {
  const [data, setData] = useState<OrderFormDataResponse | null>(() =>
    enabled ? cachedFormData : null,
  );
  const [isLoading, setIsLoading] = useState(() => enabled && !cachedFormData);
  const [error, setError] = useState<Error | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;

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
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setError(null);

    if (cachedFormData && !formDataCacheStale && refreshVersion === 0) {
      setData(cachedFormData);
      setIsLoading(false);
      return;
    }

    const isBackgroundRefresh = data !== null;
    if (!isBackgroundRefresh) {
      setIsLoading(true);
    }
    loadOrderFormData()
      .then((response) => {
        if (cancelled) return;
        setData(response);
      })
      .catch((unknownError) => {
        if (cancelled) return;
        setError(toError(unknownError));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, refreshVersion]);

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
        // Older backend deployments omitted this field. Match the legacy
        // Hasura path: only an explicit false marks a header-only material.
        isCuttable: item.isCuttable !== false,
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

export function resetOrderFormDataCacheForTests(): void {
  formDataCacheGeneration += 1;
  cachedFormData = null;
  pendingFormDataRequest = null;
  formDataCacheStale = false;
}

export function invalidateOrderFormDataCache(): void {
  formDataCacheGeneration += 1;
  pendingFormDataRequest = null;
  formDataCacheStale = true;
}

async function loadOrderFormData(): Promise<OrderFormDataResponse> {
  if (!pendingFormDataRequest) {
    const requestGeneration = formDataCacheGeneration;
    pendingFormDataRequest = ordersApi
      .getFormData()
      .then((response) => {
        if (requestGeneration === formDataCacheGeneration) {
          cachedFormData = response;
          formDataCacheStale = false;
        }
        return response;
      })
      .catch((error) => {
        if (requestGeneration === formDataCacheGeneration) {
          pendingFormDataRequest = null;
        }
        throw error;
      });
  }

  return pendingFormDataRequest;
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
