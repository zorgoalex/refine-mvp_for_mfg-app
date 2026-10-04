import { useCallback, useEffect, useRef, useState } from 'react';

import { ordersApi } from '../../api/ordersApi';
import type { OrderResourceCardDto } from '../../api/types/orderApi.types';

export interface ResourceDemandCardState {
  data: OrderResourceCardDto | null;
  loading: boolean;
  error: string | null;
  /** Перечитать карточку (после отметки закупа этого заказа или вручную). */
  refresh: () => void;
}

/**
 * Карточка потребностей заказа с деталями (`capabilities.cardDetails`).
 * `orderId === null` или `enabled === false` — не запрашивает: вызывающая
 * сторона показывает данные строки списка без раскрытия до деталей.
 */
export function useResourceDemandCard(orderId: number | null, enabled: boolean): ResourceDemandCardState {
  const [data, setData] = useState<OrderResourceCardDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const requestSequence = useRef(0);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (orderId == null || !enabled) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let active = true;
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    // Смена заказа: данные прежнего заказа сразу сбрасываются, чтобы их строки
    // (версии, отпечатки) не попали в команду закупа для нового заказа.
    setData((current) => (current && current.orderId === orderId ? current : null));
    setLoading(true);
    setError(null);
    ordersApi.getResourceDemandCard(orderId)
      .then((response) => {
        if (!active || requestSequence.current !== requestId) return;
        setData(response.data.orderId === orderId ? response.data : null);
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        if (!active || requestSequence.current !== requestId) return;
        setError(cardErrorMessage(loadError));
        setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, enabled, revision]);

  return { data: data && data.orderId === orderId ? data : null, loading, error, refresh };
}

function cardErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Не удалось загрузить карточку потребностей заказа.';
}
