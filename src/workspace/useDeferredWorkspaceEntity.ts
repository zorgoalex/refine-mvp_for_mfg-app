import { useCallback, useEffect, useRef, useState } from 'react';

export type WorkspaceEntityKey = string | number;

interface DeferredWorkspaceEntityOptions<T> {
  restoreRequested: boolean;
  restoredKey: WorkspaceEntityKey | null;
  entities: readonly T[];
  getKey: (entity: T) => WorkspaceEntityKey | null;
}

/**
 * Resolves an edit target that may arrive after checkpoint remount.
 * Missing identity stays fail-closed; cancellation prevents a late row from
 * reopening a modal the user already dismissed.
 */
export function useDeferredWorkspaceEntity<T>({
  restoreRequested,
  restoredKey,
  entities,
  getKey,
}: DeferredWorkspaceEntityOptions<T>): {
  entity: T | undefined;
  setEntity: (entity: T | undefined) => void;
  restoreReady: boolean;
  restorePending: boolean;
  cancelDeferredRestore: () => void;
} {
  const initialEntity = restoreRequested && restoredKey !== null
    ? entities.find((entity) => getKey(entity) === restoredKey)
    : undefined;
  const restoredKeyRef = useRef(restoredKey);
  const getKeyRef = useRef(getKey);
  getKeyRef.current = getKey;
  const pendingRef = useRef(
    restoreRequested && restoredKey !== null && initialEntity === undefined,
  );
  const [entity, setEntity] = useState<T | undefined>(initialEntity);
  const [restoreReady, setRestoreReady] = useState(
    () => !restoreRequested || initialEntity !== undefined,
  );
  const [restorePending, setRestorePending] = useState(
    () => restoreRequested && restoredKey !== null && initialEntity === undefined,
  );

  useEffect(() => {
    if (!pendingRef.current || restoredKeyRef.current === null) return;
    const resolved = entities.find(
      (candidate) => getKeyRef.current(candidate) === restoredKeyRef.current,
    );
    if (!resolved) return;
    pendingRef.current = false;
    setEntity(resolved);
    setRestoreReady(true);
    setRestorePending(false);
  }, [entities]);

  const cancelDeferredRestore = useCallback(() => {
    pendingRef.current = false;
    setRestorePending(false);
  }, []);

  return { entity, setEntity, restoreReady, restorePending, cancelDeferredRestore };
}
