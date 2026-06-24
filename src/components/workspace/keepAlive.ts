const CALENDAR_KEY = '/calendar';
// /cut holds rich in-page state (the open job + its loaded details) that an
// operator builds up; keep it mounted so navigating to an order card and back
// restores that state instead of remounting to a collapsed list.
const ALWAYS_KEEP = new Set(['/orders', '/cut']);

export const isKeepAliveEligible = (key: string, { dirty }: { dirty: boolean }): boolean => {
  if (key === CALENDAR_KEY) return false;            // B7: global-class hack ⇒ remount only
  if (ALWAYS_KEEP.has(key)) return true;
  return dirty;                                       // dirty non-orders tab kept while dirty
};

interface CacheInput {
  activeKey: string;
  tabs: Array<{ key: string; dirty: boolean }>;
}

export const nextKeepAliveCache = (cache: Set<string>, { activeKey, tabs }: CacheInput): Set<string> => {
  const open = new Map(tabs.map((t) => [t.key, t]));
  const next = new Set<string>();
  for (const key of cache) {
    const tab = open.get(key);
    if (!tab) continue;                               // tab closed → drop
    if (isKeepAliveEligible(key, { dirty: tab.dirty })) next.add(key);
  }
  // ensure the active eligible key is present
  const active = open.get(activeKey);
  if (active && isKeepAliveEligible(activeKey, { dirty: active.dirty })) next.add(activeKey);
  return next;
};
