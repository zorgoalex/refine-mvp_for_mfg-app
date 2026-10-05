/**
 * What the order detail table shows right now, for the customer screen: its visible columns, the
 * rows in the order on screen, the page, the groups and the row being edited. The table only
 * writes it here; nothing in this module can change the table or the order. One record per order
 * draft (the draft store object is the owner), kept in memory only.
 */
export interface OrderDetailTableMirror {
  /** Keys of the visible table columns, left to right. */
  columnKeys: readonly string[];
  /** Keys of the detail rows in the order on screen (all pages). */
  rowKeys: readonly string[];
  /** The page on screen; null while the table shows everything (grouping). */
  page: { current: number; size: number } | null;
  /** Grouping on screen: the grouping field of detailGrouping.ts and the groups top to bottom. */
  grouping: { field: string; groups: ReadonlyArray<{ key: string; label: string; rowKeys: readonly string[] }> } | null;
  /** The row whose editor is open and the cell the manager is in. */
  editing: { rowKey: string; field: string | null } | null;
  /** Current values of that editor, by table column key. */
  getEditingValues: () => Record<string, unknown>;
  /** The cell the keyboard is in right now (no editor needed); null when it is outside the table. */
  getActiveCell: () => { rowKey: string; columnKey: string } | null;
}

const records = new WeakMap<object, OrderDetailTableMirror>();
const listeners = new WeakMap<object, Set<() => void>>();

const notify = (owner: object): void => {
  for (const listener of [...(listeners.get(owner) ?? [])]) {
    try {
      listener();
    } catch {
      // A failing listener is the customer screen's problem, never the table's.
    }
  }
};

export function publishOrderDetailTableMirror(owner: object, mirror: OrderDetailTableMirror): void {
  records.set(owner, mirror);
  notify(owner);
}

export function clearOrderDetailTableMirror(owner: object): void {
  if (!records.delete(owner)) return;
  notify(owner);
}

export function readOrderDetailTableMirror(owner: object): OrderDetailTableMirror | null {
  return records.get(owner) ?? null;
}

export function subscribeOrderDetailTableMirror(owner: object, listener: () => void): () => void {
  const set = listeners.get(owner) ?? new Set<() => void>();
  listeners.set(owner, set);
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** A row of the table's data source: a plain detail, or the grouped form with separators. */
type MirrorSourceRow<D> =
  | { kind: 'detail'; detail: D; groupIndex: number }
  | { kind: 'separator'; groupIndex: number; key: string; label: string }
  | { kind: 'summary' }
  | D;

const kindOf = (row: unknown): string | null => {
  const kind = (row as { kind?: unknown } | null)?.kind;
  return kind === 'detail' || kind === 'separator' || kind === 'summary' ? kind : null;
};

/**
 * Row order and groups as the table draws them. The first group has no separator line on the
 * manager's screen when the table does not draw one; its title comes from `labelOf`.
 */
export function orderDetailMirrorRows<D>(
  rows: ReadonlyArray<MirrorSourceRow<D>>,
  options: { groupField: string | null; keyOf: (detail: D) => string | null; labelOf: (detail: D) => string },
): Pick<OrderDetailTableMirror, 'rowKeys' | 'grouping'> {
  const rowKeys: string[] = [];
  const groups = new Map<number, { key: string; label: string | null; rowKeys: string[] }>();
  for (const row of rows) {
    const kind = kindOf(row);
    if (kind === 'summary') continue;
    if (kind === 'separator') {
      const separator = row as { groupIndex: number; label: string };
      const group = groups.get(separator.groupIndex) ?? { key: String(separator.groupIndex), label: null, rowKeys: [] };
      group.label = separator.label;
      groups.set(separator.groupIndex, group);
      continue;
    }
    const detail = kind === 'detail' ? (row as { detail: D }).detail : row as D;
    const key = options.keyOf(detail);
    if (key === null) continue;
    rowKeys.push(key);
    if (kind !== 'detail') continue;
    const index = (row as { groupIndex: number }).groupIndex;
    const group = groups.get(index) ?? { key: String(index), label: null, rowKeys: [] };
    if (group.label === null && group.rowKeys.length === 0) group.label = options.labelOf(detail);
    group.rowKeys.push(key);
    groups.set(index, group);
  }
  if (!options.groupField || groups.size === 0) return { rowKeys, grouping: null };
  return {
    rowKeys,
    grouping: {
      field: options.groupField,
      groups: [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => ({ key: group.key, label: group.label ?? '', rowKeys: group.rowKeys })),
    },
  };
}

/** Changes of this part need a new snapshot; anything else is interface state only. */
export function orderDetailMirrorStructure(mirror: OrderDetailTableMirror | null): string {
  if (!mirror) return '';
  return JSON.stringify([mirror.columnKeys, mirror.rowKeys, mirror.grouping, mirror.editing?.rowKey ?? null]);
}
