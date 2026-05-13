import { useEffect, useMemo, useState } from 'react';
import { ordersApi } from '../api/ordersApi';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';
import { featureFlags } from '../config/featureFlags';

export interface ReferenceOption {
  label: string;
  value: number;
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

export function useOrderFormData(enabled = featureFlags.useBackendReferences): UseOrderFormDataResult {
  const [data, setData] = useState<OrderFormDataResponse | null>(() =>
    enabled ? cachedFormData : null,
  );
  const [isLoading, setIsLoading] = useState(() => enabled && !cachedFormData);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setError(null);

    if (cachedFormData) {
      setData(cachedFormData);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
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
  }, [enabled]);

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
    defaultOrderStatus: orderStatuses[0]?.value,
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
  cachedFormData = null;
  pendingFormDataRequest = null;
}

async function loadOrderFormData(): Promise<OrderFormDataResponse> {
  if (!pendingFormDataRequest) {
    pendingFormDataRequest = ordersApi
      .getFormData()
      .then((response) => {
        cachedFormData = response;
        return response;
      })
      .catch((error) => {
        pendingFormDataRequest = null;
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
  }));
}

function toNameMap(options: ReferenceOption[]): Map<number, string> {
  return new Map(options.map((option) => [option.value, option.label]));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Failed to load order form data');
}
