import { useEffect } from 'react';
import { useTabStore, hasAnyDirty } from '../stores/tabStore';

/** Bridge an editor's dirty flag into the tab registry. Single source of a tab's dirty state. */
export const useTabDirty = (tabKey: string | undefined, isDirty: boolean): void => {
  const setDirty = useTabStore((s) => s.setDirty);
  useEffect(() => {
    if (!tabKey) return;
    setDirty(tabKey, isDirty);
  }, [tabKey, isDirty, setDirty]);
  // On unmount, do NOT auto-clear: keep-alive dirty tabs persist their dirty marker.
};

/** Mounted once in the workspace layout. Owns THE only beforeunload handler. */
export const useGlobalUnloadGuard = (): void => {
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasAnyDirty(useTabStore.getState().tabs)) {
        e.preventDefault();
        e.returnValue = 'У вас есть несохраненные изменения. Вы уверены, что хотите покинуть страницу?';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
};
