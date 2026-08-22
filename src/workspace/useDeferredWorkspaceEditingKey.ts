import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceEntityKey } from './useDeferredWorkspaceEntity';

interface DeferredWorkspaceEditingKeyOptions<T> {
  restoredKey: WorkspaceEntityKey | null;
  entities: readonly T[];
  getKey: (entity: T) => WorkspaceEntityKey | null;
}

interface DeferredWorkspaceEditingKeyState {
  editingKey: WorkspaceEntityKey | null;
  restorePending: boolean;
  restoredActive: boolean;
}

/**
 * Restores an inline-edit key only after its exact row exists. Pending restore
 * remains an active, fail-closed edit so parent saves cannot silently skip the
 * retained form. Any explicit user edit/cancel permanently wins over the late
 * checkpoint row.
 */
export function useDeferredWorkspaceEditingKey<T>({
  restoredKey,
  entities,
  getKey,
}: DeferredWorkspaceEditingKeyOptions<T>): DeferredWorkspaceEditingKeyState & {
  setEditingKey: (key: WorkspaceEntityKey | null) => void;
  canApplyCurrentEdit: boolean;
} {
  const restoredKeyRef = useRef(restoredKey);
  const getKeyRef = useRef(getKey);
  getKeyRef.current = getKey;

  const initialEntityExists = restoredKey !== null
    && entities.some((entity) => getKey(entity) === restoredKey);
  const restoreAllowedRef = useRef(restoredKey !== null && !initialEntityExists);
  const [state, setState] = useState<DeferredWorkspaceEditingKeyState>(() => ({
    editingKey: initialEntityExists ? restoredKey : null,
    restorePending: restoredKey !== null && !initialEntityExists,
    restoredActive: initialEntityExists,
  }));

  useEffect(() => {
    if (!state.restorePending || !restoreAllowedRef.current || restoredKeyRef.current === null) {
      return;
    }
    const resolved = entities.some(
      (entity) => getKeyRef.current(entity) === restoredKeyRef.current,
    );
    if (!resolved) return;

    restoreAllowedRef.current = false;
    setState({
      editingKey: restoredKeyRef.current,
      restorePending: false,
      restoredActive: true,
    });
  }, [entities, state.restorePending]);

  const setEditingKey = useCallback((key: WorkspaceEntityKey | null) => {
    restoreAllowedRef.current = false;
    setState({
      editingKey: key,
      restorePending: false,
      restoredActive: false,
    });
  }, []);

  return {
    ...state,
    setEditingKey,
    canApplyCurrentEdit: !state.restorePending,
  };
}
