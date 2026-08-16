import { useEffect, useRef, useSyncExternalStore } from 'react';
import { featureFlags } from '../config/featureFlags';
import {
  getOrderFormDataResourceSnapshot,
  invalidateOrderFormDataCache,
  ORDER_FORM_DATA_BACKEND_MODE,
  prefetchOrderFormData,
  prepareOrderFormDataActivationRefresh,
  retainOrderFormDataRead,
  subscribeOrderFormDataResource,
  type OrderFormDataResourceSnapshot,
} from '../query/orderFormDataCache';
import { useOrderLifecycleReadActive } from '../query/orderLifecycleQueries';
import { useAuthCacheNamespace } from '../query/authCacheNamespace';
import {
  EMPTY_ORDER_FORM_DATA_REFERENCES,
  type OrderFormDataReferences,
} from '../query/orderFormDataReferences';
import {
  recordAppActivityRefreshTrigger,
  useAppActivitySnapshot,
} from '../performance/appActivityCoordinator';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';

export {
  invalidateOrderFormDataCache,
  prefetchOrderFormData,
  resetOrderFormDataCacheForTests,
} from '../query/orderFormDataCache';
export {
  createBackendSelectProps,
  mapOrderFormDataToReferences,
  type OrderFormDataReferences,
  type ReferenceOption,
  type SheetMaterialTypeOption,
} from '../query/orderFormDataReferences';

interface UseOrderFormDataResult {
  enabled: boolean;
  data: OrderFormDataResponse | null;
  references: OrderFormDataReferences;
  isLoading: boolean;
  error: Error | null;
}

export function useOrderFormData(enabled = featureFlags.useBackendReferences): UseOrderFormDataResult {
  const lifecycleReadActive = useOrderLifecycleReadActive();
  const { activationRevision, documentVisible } = useAppActivitySnapshot();
  const namespace = useAuthCacheNamespace(ORDER_FORM_DATA_BACKEND_MODE);
  const snapshot = useSyncExternalStore(
    enabled ? subscribeOrderFormDataResource : subscribeDisabledResource,
    enabled ? () => getOrderFormDataResourceSnapshot(namespace) : getDisabledSnapshot,
    enabled ? () => getServerSnapshot(namespace) : getDisabledSnapshot,
  );
  const readEnabled = enabled && lifecycleReadActive && documentVisible;
  const handledActivationRevisionRef = useRef(activationRevision);

  useEffect(() => {
    if (!readEnabled) return undefined;
    return retainOrderFormDataRead(namespace);
  }, [namespace, readEnabled]);

  useEffect(() => {
    if (handledActivationRevisionRef.current === activationRevision) return;
    handledActivationRevisionRef.current = activationRevision;
    if (!readEnabled) return;
    const decision = prepareOrderFormDataActivationRefresh(activationRevision, namespace);
    if (decision.ownsRefresh) recordAppActivityRefreshTrigger();
  }, [activationRevision, namespace, readEnabled]);

  useEffect(() => {
    if (!readEnabled) return;
    void prefetchOrderFormData(namespace).catch(() => undefined);
  }, [namespace, readEnabled, snapshot.generation]);

  if (!enabled) {
    return {
      enabled: false,
      data: null,
      references: EMPTY_ORDER_FORM_DATA_REFERENCES,
      isLoading: false,
      error: null,
    };
  }

  return {
    enabled: true,
    data: snapshot.data,
    references: snapshot.normalizedReferences,
    isLoading: readEnabled && snapshot.data === null && snapshot.inFlight,
    error: snapshot.error,
  };
}

function getServerSnapshot(namespace: string): OrderFormDataResourceSnapshot {
  return getOrderFormDataResourceSnapshot(namespace);
}

const DISABLED_SNAPSHOT: OrderFormDataResourceSnapshot = {
  namespace: 'disabled-order-form-data',
  data: null,
  normalizedReferences: EMPTY_ORDER_FORM_DATA_REFERENCES,
  revision: 0,
  fetchedAt: 0,
  status: 'idle',
  error: null,
  inFlight: false,
  generation: 0,
};

function subscribeDisabledResource(): () => void {
  return () => undefined;
}

function getDisabledSnapshot(): OrderFormDataResourceSnapshot {
  return DISABLED_SNAPSHOT;
}
