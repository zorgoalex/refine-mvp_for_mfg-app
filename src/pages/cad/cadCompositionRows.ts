import type { CadGroup, CadSourcePart, CadSourceSnapshot } from '@shared/cad-workspace';

export type CadTreeFilter = 'all' | 'issues' | 'changed' | 'unassigned';
export type CadTreeRow =
  | { kind: 'position'; key: string; part: CadSourcePart | undefined; orderName: string; ids: string[]; total: number; collapsed: boolean }
  | { kind: 'instance'; key: string; group: CadGroup; part: CadSourcePart | undefined };

export interface CadTreeInput {
  groups: CadGroup[]; sources: CadSourceSnapshot[]; search: string; filter: CadTreeFilter; collapsed: ReadonlySet<string>;
  issueIds: ReadonlySet<string>; changedIds: ReadonlySet<string>; recipeName: (g: CadGroup) => string;
}

export const positionKey = (g: Pick<CadGroup, 'sourceSnapshotId' | 'detailId'>) => `${g.sourceSnapshotId}:${g.detailId}`;

/** Position headers in first-appearance order, each followed by its matching instances unless collapsed. */
export function buildCompositionRows({ groups, sources, search, filter, collapsed, issueIds, changedIds, recipeName }: CadTreeInput): CadTreeRow[] {
  const parts = new Map<string, { part: CadSourcePart; orderName: string }>(sources.flatMap(s => s.parts.map(p => [`${s.id}:${p.detailId}`, { part: p, orderName: s.orderName }] as const)));
  const needle = search.trim().toLowerCase();
  const passes = (g: CadGroup) => {
    if (filter === 'issues' && !issueIds.has(g.id)) return false;
    if (filter === 'changed' && !changedIds.has(g.id)) return false;
    if (filter === 'unassigned' && g.recipe) return false;
    const p = parts.get(positionKey(g))?.part;
    return !needle || `${p?.detailNumber} ${g.orderId} ${recipeName(g)}`.toLowerCase().includes(needle);
  };
  const positions = new Map<string, { all: number; matched: CadGroup[] }>();
  for (const g of groups) {
    const key = positionKey(g), entry = positions.get(key) ?? { all: 0, matched: [] };
    entry.all += 1; if (passes(g)) entry.matched.push(g);
    positions.set(key, entry);
  }
  const rows: CadTreeRow[] = [];
  for (const [key, { all, matched }] of positions) {
    if (!matched.length) continue;
    const source = parts.get(key), isCollapsed = collapsed.has(key);
    rows.push({ kind: 'position', key, part: source?.part, orderName: source?.orderName ?? '', ids: matched.map(g => g.id), total: all, collapsed: isCollapsed });
    if (!isCollapsed) for (const g of matched) rows.push({ kind: 'instance', key: g.id, group: g, part: source?.part });
  }
  return rows;
}
