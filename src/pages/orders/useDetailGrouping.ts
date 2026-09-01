// src/pages/orders/useDetailGrouping.ts
import { useCallback, useEffect, useState } from 'react';
import type { GroupField } from './detailGrouping';
import { GROUP_FIELDS } from './detailGrouping';

export interface DetailGroupingState {
  field: GroupField | null;
  showSeparation: boolean;
}

const DEFAULT_STATE: DetailGroupingState = { field: null, showSeparation: true };
const NEW_ORDER_STATE: DetailGroupingState = { field: null, showSeparation: false };
const VALID_FIELDS = new Set<string>(GROUP_FIELDS.map(f => f.field));

export function detailGroupingKey(userId: string, orderId: string | number): string {
  return `order-details:grouping:${userId}:${orderId}`;
}

export function loadDetailGrouping(userId: string, orderId: string | number): DetailGroupingState {
  try {
    const raw = localStorage.getItem(detailGroupingKey(userId, orderId));
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    const field = VALID_FIELDS.has(parsed?.field) ? (parsed.field as GroupField) : null;
    const showSeparation = parsed?.showSeparation !== false;
    return { field, showSeparation };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveDetailGrouping(
  userId: string,
  orderId: string | number,
  state: DetailGroupingState,
): void {
  try {
    localStorage.setItem(detailGroupingKey(userId, orderId), JSON.stringify(state));
  } catch {
    // ignore storage failures (private mode / quota)
  }
}

// Picking a field (re)activates grouping: separation turns back on, so a prior
// "unchecked" state never hides a freshly-picked grouping. Clearing keeps prior.
export function nextStateForField(
  prev: DetailGroupingState,
  field: GroupField | null,
): DetailGroupingState {
  return { field, showSeparation: field !== null ? true : prev.showSeparation };
}

export function initialDetailGroupingState(
  userId: string,
  orderId: string | number,
  startDisabled = false,
): DetailGroupingState {
  return startDisabled ? { ...NEW_ORDER_STATE } : loadDetailGrouping(userId, orderId);
}

export function useDetailGrouping(
  userId: string,
  orderId: string | number,
  startDisabled = false,
) {
  const [state, setState] = useState<DetailGroupingState>(() =>
    initialDetailGroupingState(userId, orderId, startDisabled),
  );

  // Re-load when the identity/order changes (e.g. tab switches to another order).
  useEffect(() => {
    setState(initialDetailGroupingState(userId, orderId, startDisabled));
  }, [userId, orderId, startDisabled]);

  const persist = useCallback(
    (next: DetailGroupingState) => {
      setState(next);
      saveDetailGrouping(userId, orderId, next);
    },
    [userId, orderId],
  );

  const setField = useCallback(
    (field: GroupField | null) => persist(nextStateForField(state, field)),
    [persist, state],
  );
  const setShowSeparation = useCallback(
    (showSeparation: boolean) => persist({ field: state.field, showSeparation }),
    [persist, state.field],
  );

  return { state, setField, setShowSeparation };
}
