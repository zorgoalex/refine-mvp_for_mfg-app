import { authSession } from '../api/authSession';
import { ordersApi } from '../api/ordersApi';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';

let cachedFormData: OrderFormDataResponse | null = null;
let pendingFormDataRequest: Promise<OrderFormDataResponse> | null = null;
let formDataCacheGeneration = 0;
let formDataCacheStale = false;

authSession.subscribeBeforeClear(() => {
  clearOrderFormDataCache();
});

export function getCachedOrderFormData(): OrderFormDataResponse | null {
  return cachedFormData;
}

export function isOrderFormDataCacheStale(): boolean {
  return formDataCacheStale;
}

export function getOrderFormDataCacheGeneration(): number {
  return formDataCacheGeneration;
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

export function clearOrderFormDataCache(): void {
  formDataCacheGeneration += 1;
  cachedFormData = null;
  pendingFormDataRequest = null;
  formDataCacheStale = false;
}

export function prefetchOrderFormData(): Promise<OrderFormDataResponse> {
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
