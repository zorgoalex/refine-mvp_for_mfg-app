/**
 * What a tab of the order form shows right now, for the customer screen — for tabs that work out
 * their content themselves (loading stock, cut jobs and the like). The tab only writes its record
 * here; nothing in this module can change the tab or the order. One record per order draft (the
 * draft store object is the owner) and tab key, kept in memory only and gone when the tab unmounts.
 */
const records = new WeakMap<object, Map<string, unknown>>();
const listeners = new WeakMap<object, Set<() => void>>();

const notify = (owner: object): void => {
  for (const listener of [...(listeners.get(owner) ?? [])]) {
    try {
      listener();
    } catch {
      // A failing listener is the customer screen's problem, never the tab's.
    }
  }
};

export function publishOrderTabMirror<T>(owner: object, tab: string, record: T): void {
  const map = records.get(owner) ?? new Map<string, unknown>();
  records.set(owner, map);
  map.set(tab, record);
  notify(owner);
}

export function clearOrderTabMirror(owner: object, tab: string): void {
  if (!records.get(owner)?.delete(tab)) return;
  notify(owner);
}

export function readOrderTabMirror<T>(owner: object, tab: string): T | null {
  return (records.get(owner)?.get(tab) as T | undefined) ?? null;
}

export function subscribeOrderTabMirror(owner: object, listener: () => void): () => void {
  const set = listeners.get(owner) ?? new Set<() => void>();
  listeners.set(owner, set);
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
