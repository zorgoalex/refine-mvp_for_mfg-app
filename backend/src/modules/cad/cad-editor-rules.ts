import { createHash } from 'node:crypto';
import { recipesEqual, type CadGroup, type CadVariant, type CadSourceSnapshot } from '../../shared/cad-workspace';

export function canonicalCad(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCad).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalCad(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const cadDigest = (value: unknown): string => createHash('sha256').update(canonicalCad(value)).digest('hex');

/** Only persisted same-source settings can be carried without new authority. */
export function manufacturingChanges(before: CadVariant, groups: CadGroup[]): CadGroup[] {
  return groups.filter(group => {
    const trusted = before.groups.find(g => g.id === group.id && g.sourceSnapshotId === group.sourceSnapshotId && g.orderId === group.orderId && g.detailId === group.detailId);
    if (trusted && recipesEqual(trusted.recipe, group.recipe)) return false;
    // Splitting an existing part preserves its settings, but not scoped approvals.
    return !before.groups.some(g => g.sourceSnapshotId === group.sourceSnapshotId && g.orderId === group.orderId && g.detailId === group.detailId && recipesEqual(g.recipe, group.recipe));
  });
}

export function cadRenderPart(variant: CadVariant, group: CadGroup) {
  const source = variant.sources.find(s => s.id === group.sourceSnapshotId);
  const part = source?.parts.find(p => p.detailId === group.detailId);
  return { part_id: group.id, side: 'front', width_mm: part?.widthMm, height_mm: part?.heightMm,
    quantity: group.quantity, material: part?.material, thickness_mm: part?.thicknessMm, recipe: group.recipe,
    metadata: { workspaceId: variant.workspaceId, variantId: variant.id, revision: variant.version,
      orderId: group.orderId, detailId: group.detailId, sourceSnapshotId: group.sourceSnapshotId,
      originalRecipe: part?.recipe ?? null, edgeType: part?.edgeName ?? '', excludedOperations: ['obkat'] } };
}

export function compareCadSource(old: CadSourceSnapshot, fresh: CadSourceSnapshot) {
  const oldParts = new Map(old.parts.map(p => [p.detailId, p]));
  const newParts = new Map(fresh.parts.map(p => [p.detailId, p]));
  const changedDetailIds = [...new Set([...oldParts.keys(), ...newParts.keys()])]
    .filter(id => canonicalCad(oldParts.get(id)) !== canonicalCad(newParts.get(id))).sort((a, b) => a - b);
  return { orderId: old.orderId, orderName: old.orderName,
    stale: changedDetailIds.length > 0 || old.orderName !== fresh.orderName, changedDetailIds };
}

export function sourceComparisonHash(sources: CadSourceSnapshot[]): string {
  return cadDigest(sources.map(s => ({ orderId: s.orderId, orderName: s.orderName, parts: [...s.parts].sort((a, b) => a.detailId - b.detailId) })).sort((a, b) => a.orderId - b.orderId));
}
