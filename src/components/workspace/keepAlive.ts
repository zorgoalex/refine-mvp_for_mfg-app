const CALENDAR_KEY = '/calendar';
const ORDERS_LIST_KEY = '/orders';
export const MAX_INACTIVE_HEAVY_ORDER_VIEWS = 2;

// /cut holds rich in-page state (the open job + its loaded details) that an
// operator builds up; keep it mounted so navigating to an order card and back
// restores that state instead of remounting to a collapsed list.
// /bazis и карточки проектов держат локальное состояние страницы: модалки,
// фильтры, сортировки и выделение. Ремаунт также повторно загружает проект.
// /mdf-work-board держит тяжелую доску в памяти, чтобы возврат во вкладку не
// показывал общий спиннер поверх уже загруженных карточек.
const ALWAYS_KEEP = new Set([ORDERS_LIST_KEY, '/cut', '/bazis', '/configuration', '/mdf-work-board']);

const isOrderFormKey = (key: string): boolean =>
  key === '/orders/create' || key.startsWith('/orders/edit/');

const isBazisProjectKey = (key: string): boolean =>
  key.startsWith('/bazis/projects/');

export const isHeavyOrderViewKey = (key: string): boolean =>
  isOrderFormKey(key) || key.startsWith('/orders/show/');

export const isLightweightOrdersListKey = (key: string): boolean => key === ORDERS_LIST_KEY;

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
  boundedHeavyOrderViews?: boolean;
  circuitOpen?: boolean;
  activationRevisionByKey?: ReadonlyMap<string, number>;
  maxInactiveHeavyOrderViews?: number;
}

export interface KeepAlivePlan {
  keep: Set<string>;
  evict: Set<string>;
  checkpointBeforeEviction: Set<string>;
  blockedPinnedKeys: Set<string>;
}

export interface KeepAliveEvictionCommitInput {
  plan: KeepAlivePlan;
  captureCheckpoint: (key: string) => boolean;
  evict: (key: string) => boolean;
  onPinnedEviction: (key: string) => void;
}

export interface KeepAliveEvictionCommitResult {
  circuitOpened: boolean;
  evictedKeys: string[];
}

export const planKeepAliveCache = (
  cache: ReadonlySet<string>,
  {
    activeKey,
    tabs,
    pinnedKeys = new Set(),
    boundedHeavyOrderViews = false,
    circuitOpen = false,
    activationRevisionByKey = new Map(),
    maxInactiveHeavyOrderViews = MAX_INACTIVE_HEAVY_ORDER_VIEWS,
  }: CacheInput,
): KeepAlivePlan => {
  const open = new Map(tabs.map((tab) => [tab.key, tab]));
  const legacy = buildLegacyKeepSet(cache, activeKey, open, pinnedKeys);
  if (!boundedHeavyOrderViews) {
    return buildPlan(cache, legacy.keep, new Set(), legacy.blockedPinnedKeys);
  }
  if (circuitOpen) {
    const failClosed = buildFailClosedKeepSet(cache, activeKey, open, pinnedKeys);
    return buildPlan(cache, failClosed.keep, new Set(), failClosed.blockedPinnedKeys);
  }

  const keep = new Set<string>();
  const blockedPinnedKeys = new Set<string>();
  for (const key of cache) {
    const tab = open.get(key);
    if (!tab) continue;
    if (key === activeKey || isHeavyOrderViewKey(key) || isKeepAliveEligible(key, { dirty: tab.dirty })) {
      keep.add(key);
      continue;
    }
    if (pinnedKeys.has(key)) {
      keep.add(key);
      blockedPinnedKeys.add(key);
    }
  }
  if (open.has(activeKey)) keep.add(activeKey);

  const inactiveHeavy = [...keep]
    .filter((key) => key !== activeKey && isHeavyOrderViewKey(key))
    .sort((left, right) => {
      const revisionDelta = (activationRevisionByKey.get(left) ?? 0)
        - (activationRevisionByKey.get(right) ?? 0);
      return revisionDelta || left.localeCompare(right);
    });
  const evictionCount = Math.max(0, inactiveHeavy.length - maxInactiveHeavyOrderViews);
  const heavyEvictions = new Set(inactiveHeavy.slice(0, evictionCount));
  for (const key of heavyEvictions) {
    if (pinnedKeys.has(key)) blockedPinnedKeys.add(key);
  }

  // An attempted eviction of page-owned work fails closed for this session.
  // Retain every already-mounted heavy view atomically; never partially enforce
  // the LRU or discard a checkpoint merely because the legacy policy remounted it.
  if (blockedPinnedKeys.size > 0) {
    const failClosed = buildFailClosedKeepSet(cache, activeKey, open, pinnedKeys);
    failClosed.blockedPinnedKeys.forEach((key) => blockedPinnedKeys.add(key));
    return buildPlan(cache, failClosed.keep, new Set(), blockedPinnedKeys);
  }

  heavyEvictions.forEach((key) => keep.delete(key));
  return buildPlan(cache, keep, heavyEvictions, blockedPinnedKeys);
};

export const nextKeepAliveCache = (
  cache: Set<string>,
  input: CacheInput,
): Set<string> => {
  const plan = planKeepAliveCache(cache, input);
  plan.blockedPinnedKeys.forEach((key) => input.onPinnedEviction?.(key));
  return plan.keep;
};

export const commitKeepAliveEvictions = ({
  plan,
  captureCheckpoint,
  evict,
  onPinnedEviction,
}: KeepAliveEvictionCommitInput): KeepAliveEvictionCommitResult => {
  const evictedKeys: string[] = [];
  const commitEviction = (key: string) => {
    if (evict(key)) evictedKeys.push(key);
  };

  if (plan.blockedPinnedKeys.size > 0) {
    plan.blockedPinnedKeys.forEach(onPinnedEviction);
    plan.evict.forEach(commitEviction);
    return { circuitOpened: true, evictedKeys };
  }

  const checkpointSafe = [...plan.checkpointBeforeEviction]
    .every((key) => captureCheckpoint(key));
  if (!checkpointSafe) {
    plan.evict.forEach((key) => {
      if (!plan.checkpointBeforeEviction.has(key)) commitEviction(key);
    });
    return { circuitOpened: true, evictedKeys };
  }

  plan.evict.forEach(commitEviction);
  return { circuitOpened: false, evictedKeys };
};

export const countMountedHeavyOrderViews = (keys: Iterable<string>): number =>
  [...keys].filter(isHeavyOrderViewKey).length;

function buildLegacyKeepSet(
  cache: ReadonlySet<string>,
  activeKey: string,
  open: ReadonlyMap<string, { key: string; dirty: boolean }>,
  pinnedKeys: ReadonlySet<string>,
): { keep: Set<string>; blockedPinnedKeys: Set<string> } {
  const keep = new Set<string>();
  const blockedPinnedKeys = new Set<string>();
  for (const key of cache) {
    const tab = open.get(key);
    const policyKeeps = Boolean(tab && isKeepAliveEligible(key, { dirty: tab.dirty }));
    if (key === activeKey || policyKeeps) {
      keep.add(key);
      continue;
    }
    if (tab && pinnedKeys.has(key)) {
      keep.add(key);
      blockedPinnedKeys.add(key);
    }
  }
  if (open.has(activeKey)) keep.add(activeKey);
  return { keep, blockedPinnedKeys };
}

function buildFailClosedKeepSet(
  cache: ReadonlySet<string>,
  activeKey: string,
  open: ReadonlyMap<string, { key: string; dirty: boolean }>,
  pinnedKeys: ReadonlySet<string>,
): { keep: Set<string>; blockedPinnedKeys: Set<string> } {
  const keep = new Set<string>();
  const blockedPinnedKeys = new Set<string>();
  for (const key of cache) {
    const tab = open.get(key);
    if (!tab) continue;
    if (
      key === activeKey
      || isHeavyOrderViewKey(key)
      || isKeepAliveEligible(key, { dirty: tab.dirty })
    ) {
      keep.add(key);
      continue;
    }
    if (pinnedKeys.has(key)) {
      keep.add(key);
      blockedPinnedKeys.add(key);
    }
  }
  if (open.has(activeKey)) keep.add(activeKey);
  return { keep, blockedPinnedKeys };
}

function buildPlan(
  cache: ReadonlySet<string>,
  keep: Set<string>,
  checkpointBeforeEviction: Set<string>,
  blockedPinnedKeys: Set<string>,
): KeepAlivePlan {
  return {
    keep,
    evict: new Set([...cache].filter((key) => !keep.has(key))),
    checkpointBeforeEviction,
    blockedPinnedKeys,
  };
}
