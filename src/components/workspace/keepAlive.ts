const CALENDAR_KEY = '/calendar';
// /cut holds rich in-page state (the open job + its loaded details) that an
// operator builds up; keep it mounted so navigating to an order card and back
// restores that state instead of remounting to a collapsed list.
// /bazis и карточки проектов держат локальное состояние страницы: модалки,
// фильтры, сортировки и выделение. Ремаунт также повторно загружает проект.
// /mdf-work-board держит тяжелую доску в памяти, чтобы возврат во вкладку не
// показывал общий спиннер поверх уже загруженных карточек.
const ALWAYS_KEEP = new Set(['/orders', '/cut', '/bazis', '/configuration', '/mdf-work-board']);

const isOrderFormKey = (key: string): boolean =>
  key === '/orders/create' || key.startsWith('/orders/edit/');

const isBazisProjectKey = (key: string): boolean =>
  key.startsWith('/bazis/projects/');

export const isKeepAliveEligible = (key: string, { dirty }: { dirty: boolean }): boolean => {
  if (key === CALENDAR_KEY) return false;            // B7: global-class hack ⇒ remount only
  if (ALWAYS_KEEP.has(key) || isOrderFormKey(key) || isBazisProjectKey(key)) return true;
  return dirty;                                       // dirty non-orders tab kept while dirty
};

interface CacheInput {
  activeKey: string;
  tabs: Array<{ key: string; dirty: boolean }>;
  pinnedKeys?: ReadonlySet<string>;
  onPinnedEviction?: (key: string) => void;
}

export const nextKeepAliveCache = (
  cache: Set<string>,
  { activeKey, tabs, pinnedKeys = new Set(), onPinnedEviction }: CacheInput,
): Set<string> => {
  const open = new Map(tabs.map((t) => [t.key, t]));
  const next = new Set<string>();
  for (const key of cache) {
    const tab = open.get(key);
    const policyKeeps = Boolean(tab && isKeepAliveEligible(key, { dirty: tab.dirty }));
    if (key === activeKey || policyKeeps) {
      next.add(key);
      continue;
    }
    if (pinnedKeys.has(key)) {
      next.add(key);
      onPinnedEviction?.(key);
    }
  }
  // Active route always renders through the stable cache owner. Eligibility
  // controls only whether it survives after becoming inactive.
  const active = open.get(activeKey);
  if (active) next.add(activeKey);
  return next;
};
