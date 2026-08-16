import { authSession } from '../api/authSession';
import { ordersApi } from '../api/ordersApi';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';

let cachedFormData: OrderFormDataResponse | null = null;
let pendingFormDataRequest: Promise<OrderFormDataResponse> | null = null;
let formDataCacheGeneration = 0;
let formDataCacheStale = false;
let formDataFetchedAt = 0;
let activationRefreshDecision: {
  revision: number;
  refreshRequired: boolean;
} = { revision: -1, refreshRequired: false };

export const ORDER_FORM_DATA_STALE_TIME_MS = 60_000;

authSession.subscribeBeforeClear(() => {
  clearOrderFormDataCache();
});

export function getCachedOrderFormData(): OrderFormDataResponse | null {
  return cachedFormData;
}

export function isOrderFormDataCacheStale(): boolean {
  return formDataCacheStale
    || (cachedFormData !== null && Date.now() - formDataFetchedAt >= ORDER_FORM_DATA_STALE_TIME_MS);
}

export function getOrderFormDataCacheGeneration(): number {
  return formDataCacheGeneration;
}

export function resetOrderFormDataCacheForTests(): void {
  formDataCacheGeneration += 1;
  cachedFormData = null;
  pendingFormDataRequest = null;
  formDataCacheStale = false;
  formDataFetchedAt = 0;
  activationRefreshDecision = { revision: -1, refreshRequired: false };
}

export function prepareOrderFormDataActivationRefresh(activationRevision: number): {
  refreshRequired: boolean;
  ownsRefresh: boolean;
} {
  if (activationRefreshDecision.revision === activationRevision) {
    return {
      refreshRequired: activationRefreshDecision.refreshRequired,
      ownsRefresh: false,
    };
  }

  const refreshRequired = pendingFormDataRequest === null && isOrderFormDataCacheStale();
  activationRefreshDecision = { revision: activationRevision, refreshRequired };
  if (refreshRequired) invalidateOrderFormDataCache();
  return { refreshRequired, ownsRefresh: refreshRequired };
}

export function invalidateOrderFormDataCache(): void {
  formDataCacheGeneration += 1;
  pendingFormDataRequest = null;
  formDataCacheStale = true;
}

export function clearOrderFormDataCache(): void {
  formDataCacheGeneration += 1;
  cachedFormData = null;
  pendingFormDataRequest = null;
  formDataCacheStale = false;
  formDataFetchedAt = 0;
  activationRefreshDecision = { revision: -1, refreshRequired: false };
}

export function prefetchOrderFormData(): Promise<OrderFormDataResponse> {
  if (!pendingFormDataRequest) {
    const requestGeneration = formDataCacheGeneration;
    const request = ordersApi
      .getFormData()
      .then((response) => {
        if (requestGeneration === formDataCacheGeneration) {
          cachedFormData = response;
          formDataCacheStale = false;
          formDataFetchedAt = Date.now();
        }
        return response;
      })
      .finally(() => {
        if (pendingFormDataRequest === request) pendingFormDataRequest = null;
      });
    pendingFormDataRequest = request;
  }

  return pendingFormDataRequest;
}
