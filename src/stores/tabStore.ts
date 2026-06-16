import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { destroyOrderDraftStore } from './orderFormStore';

export interface WorkspaceTab {
  key: string;      // pathname only (no query) — dedupe + activation
  path: string;     // pathname + location.search — navigate/persist target
  label: string;
  resource: string;
  dirty: boolean;
}

interface TabState {
  tabs: WorkspaceTab[];
  openTab: (t: Omit<WorkspaceTab, 'dirty'>) => void;
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

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: [],
      openTab: (t) =>
        set((state) => {
          const idx = state.tabs.findIndex((x) => x.key === t.key);
          if (idx >= 0) {
            const tabs = state.tabs.slice();
            tabs[idx] = { ...tabs[idx], path: t.path, label: t.label || tabs[idx].label };
            return { tabs };
          }
          return { tabs: [...state.tabs, { ...t, dirty: false }] };
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
      name: 'workspace-tabs',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        tabs: state.tabs.map(({ key, path, label, resource }) => ({ key, path, label, resource, dirty: false })),
      }),
    }
  )
);
