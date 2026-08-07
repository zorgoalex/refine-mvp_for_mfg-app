import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { authSession } from '../api/authSession';
import { authStorage } from '../utils/auth';
import { resolveTabLabel, shouldPreserveTabLabel } from '../utils/tabLabels';
import { destroyOrderDraftStore } from './orderFormStore';

export const LEGACY_WORKSPACE_TABS_STORAGE_KEY = 'workspace-tabs';
const INACTIVE_WORKSPACE_TABS_STORAGE_KEY = 'erp.workspaceTabs.anonymous';

export const workspaceTabsStorageKey = (userId: string): string =>
  `erp.workspaceTabs.${userId}`;

export interface WorkspaceTab {
  key: string;      // pathname only (no query) — dedupe + activation
  path: string;     // pathname + location.search — navigate/persist target
  label: string;
  resource: string;
  dirty: boolean;
}

interface TabState {
  tabs: WorkspaceTab[];
  openTab: (t: Omit<WorkspaceTab, 'dirty'> & { preserveLabel?: boolean }) => void;
  closeTab: (key: string, opts?: { discard?: boolean }) => void;
  setTabTitle: (key: string, label: string) => void;
  setDirty: (key: string, dirty: boolean) => void;
  reorder: (from: number, to: number) => void;
}

export const computeNeighborPath = (tabs: WorkspaceTab[], closingKey: string): string => {
  const i = tabs.findIndex((t) => t.key === closingKey);
  if (i === -1) return '/orders';
  if (tabs.length <= 1) return '/orders';
  const neighbor = tabs[i + 1] ?? tabs[i - 1];
  return neighbor ? neighbor.path : '/orders';
};

export const hasAnyDirty = (tabs: WorkspaceTab[]): boolean => tabs.some((t) => t.dirty);

const orderKeyFromTab = (key: string): string | null => {
  const m = key.match(/^\/orders\/edit\/(\d+)$/);
  if (m) return m[1];
  if (key === '/orders/create') return 'new';
  return null;
};

export const migrateWorkspaceTabs = (persistedState: unknown, version: number): unknown => {
  if (version >= 1 || !persistedState || typeof persistedState !== 'object') {
    return persistedState;
  }

  const state = persistedState as { tabs?: WorkspaceTab[] };
  if (!Array.isArray(state.tabs)) {
    return persistedState;
  }

  return {
    ...state,
    tabs: state.tabs.map((tab) => ({
      ...tab,
      label: shouldPreserveTabLabel(tab.key) ? tab.label : resolveTabLabel(tab.key),
    })),
  };
};

const getCurrentWorkspaceTabsUserId = (): string | null => {
  const sessionUserId = authSession.getUser()?.id;
  if (sessionUserId != null) return String(sessionUserId);
  if (typeof localStorage === 'undefined') return null;

  const id = authStorage.getUser()?.id;
  return id == null ? null : String(id);
};

export const migrateLegacyWorkspaceTabsStorage = (
  userId: string,
  persistentStorage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  legacyStorage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage,
): string | null => {
  const storageKey = workspaceTabsStorageKey(userId);
  const persisted = persistentStorage.getItem(storageKey);
  if (persisted !== null) {
    legacyStorage.removeItem(LEGACY_WORKSPACE_TABS_STORAGE_KEY);
    return persisted;
  }

  const legacy = legacyStorage.getItem(LEGACY_WORKSPACE_TABS_STORAGE_KEY);
  if (legacy === null) return null;

  persistentStorage.setItem(storageKey, legacy);
  legacyStorage.removeItem(LEGACY_WORKSPACE_TABS_STORAGE_KEY);
  return legacy;
};

const userScopedWorkspaceTabsStorage: StateStorage = {
  getItem: (name) => {
    const userId = getCurrentWorkspaceTabsUserId();
    if (
      !userId ||
      name !== workspaceTabsStorageKey(userId) ||
      typeof localStorage === 'undefined' ||
      typeof sessionStorage === 'undefined'
    ) return null;
    return migrateLegacyWorkspaceTabsStorage(userId);
  },
  setItem: (name, value) => {
    const userId = getCurrentWorkspaceTabsUserId();
    if (!userId || name !== workspaceTabsStorageKey(userId) || typeof localStorage === 'undefined') return;
    localStorage.setItem(name, value);
  },
  removeItem: (name) => {
    const userId = getCurrentWorkspaceTabsUserId();
    if (!userId || name !== workspaceTabsStorageKey(userId) || typeof localStorage === 'undefined') return;
    localStorage.removeItem(name);
  },
};

let activeWorkspaceTabsUserId = getCurrentWorkspaceTabsUserId();

const workspaceTabsPersistName = (userId: string | null): string =>
  userId ? workspaceTabsStorageKey(userId) : INACTIVE_WORKSPACE_TABS_STORAGE_KEY;

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: [],
      openTab: (t) =>
        set((state) => {
          const { preserveLabel = true, ...nextTab } = t;
          const idx = state.tabs.findIndex((x) => x.key === t.key);
          if (idx >= 0) {
            const tabs = state.tabs.slice();
            tabs[idx] = {
              ...tabs[idx],
              path: nextTab.path,
              label: preserveLabel ? tabs[idx].label || nextTab.label : nextTab.label,
            };
            return { tabs };
          }
          return { tabs: [...state.tabs, { ...nextTab, dirty: false }] };
        }),
      closeTab: (key, opts) => {
        if (opts?.discard) {
          const orderKey = orderKeyFromTab(key);
          if (orderKey) destroyOrderDraftStore(orderKey);
        }
        set((state) => ({ tabs: state.tabs.filter((x) => x.key !== key) }));
      },
      setTabTitle: (key, label) =>
        set((state) => ({ tabs: state.tabs.map((x) => (x.key === key ? { ...x, label } : x)) })),
      setDirty: (key, dirty) =>
        set((state) => ({ tabs: state.tabs.map((x) => (x.key === key ? { ...x, dirty } : x)) })),
      reorder: (from, to) =>
        set((state) => {
          const tabs = state.tabs.slice();
          const [moved] = tabs.splice(from, 1);
          tabs.splice(to, 0, moved);
          return { tabs };
        }),
    }),
    {
      name: workspaceTabsPersistName(activeWorkspaceTabsUserId),
      version: 1,
      migrate: migrateWorkspaceTabs,
      storage: createJSONStorage(() => userScopedWorkspaceTabsStorage),
      partialize: (state) => ({
        tabs: state.tabs.map(({ key, path, label, resource }) => ({ key, path, label, resource, dirty: false })),
      }),
      merge: (persistedState, currentState) => {
        const persistedTabs = (persistedState as Partial<TabState> | undefined)?.tabs;
        return {
          ...currentState,
          tabs: Array.isArray(persistedTabs) ? persistedTabs as WorkspaceTab[] : [],
        };
      },
    }
  )
);

export const syncWorkspaceTabsForCurrentUser = (): void => {
  const userId = getCurrentWorkspaceTabsUserId();
  if (userId === activeWorkspaceTabsUserId) return;

  activeWorkspaceTabsUserId = userId;
  useTabStore.persist.setOptions({ name: workspaceTabsPersistName(userId) });
  void useTabStore.persist.rehydrate();
};

authSession.subscribe(syncWorkspaceTabsForCurrentUser);
