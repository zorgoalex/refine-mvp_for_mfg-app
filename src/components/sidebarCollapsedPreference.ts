const SIDEBAR_COLLAPSED_STORAGE_PREFIX = 'erp.sidebar.collapsed.';

type SidebarCollapsedStorageReader = Pick<Storage, 'getItem'>;
type SidebarCollapsedStorageWriter = Pick<Storage, 'setItem'>;
export type SidebarCollapsedUserId = string | number | null | undefined;

export function sidebarCollapsedStorageKey(userId: string | number): string {
  return `${SIDEBAR_COLLAPSED_STORAGE_PREFIX}${userId}`;
}

export function loadSidebarCollapsed(
  userId: SidebarCollapsedUserId,
  defaultCollapsed: boolean,
  storage: SidebarCollapsedStorageReader | undefined = globalThis.localStorage,
): boolean {
  if (!userId || !storage) return defaultCollapsed;
  try {
    const value = storage.getItem(sidebarCollapsedStorageKey(userId));
    if (value === 'true') return true;
    if (value === 'false') return false;
    return defaultCollapsed;
  } catch {
    return defaultCollapsed;
  }
}

export function saveSidebarCollapsed(
  userId: SidebarCollapsedUserId,
  collapsed: boolean,
  storage: SidebarCollapsedStorageWriter | undefined = globalThis.localStorage,
): void {
  if (!userId || !storage) return;
  try {
    storage.setItem(sidebarCollapsedStorageKey(userId), String(collapsed));
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
  }
}
