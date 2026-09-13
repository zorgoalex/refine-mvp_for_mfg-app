import { CAD_MAX_GROUPS, recipesEqual, type CadGroup, type CadRecipeRef, type CadSourceSnapshot, type JsonValue } from '@shared/cad-workspace';
import { placedBounds } from './cadCanvasGeometry';

/** View expansion only. The existing audited save persists it on a deliberate edit. */
export function expandInstances(groups: CadGroup[], sources: CadSourceSnapshot[], idFor: (group: string, copy: number) => string): CadGroup[] {
  const total = groups.reduce((n, g) => n + g.quantity, 0);
  if (groups.some(g => !Number.isSafeInteger(g.quantity) || g.quantity < 1) || !Number.isSafeInteger(total) || total > CAD_MAX_GROUPS) {
    throw new Error(`Редактор поддерживает до ${CAD_MAX_GROUPS} экземпляров в варианте. Состав не был усечён или изменён.`);
  }
  if (groups.every(g => g.quantity === 1)) return groups;
  const parts = new Map(sources.flatMap(s => s.parts.map(p => [`${s.id}:${p.detailId}`, p] as const)));
  // Display packing only, not CNC nesting. Grow row width with the added area
  // so large orders do not become a several-hundred-row vertical strip.
  const extraArea = groups.reduce((area, group) => {
    const part = parts.get(`${group.sourceSnapshotId}:${group.detailId}`);
    if (!part) return area;
    const b = placedBounds(group, part);
    return area + (group.quantity - 1) * (b.maxX - b.minX + 50) * (b.maxY - b.minY + 50);
  }, 0);
  const rowWidth = Math.sqrt(extraArea * 1.6);
  let y = 0;
  for (const group of groups) {
    const part = parts.get(`${group.sourceSnapshotId}:${group.detailId}`);
    if (part) y = Math.max(y, placedBounds(group, part).maxY);
  }
  y += 50;
  let x = 0, rowHeight = 0;
  return groups.flatMap(group => Array.from({ length: group.quantity }, (_, index) => {
    if (group.quantity === 1) return group;
    const copy = { ...structuredClone(group), quantity: 1, placementGroupId: undefined };
    if (!index) return copy;
    copy.id = idFor(group.id, index);
    const part = parts.get(`${group.sourceSnapshotId}:${group.detailId}`);
    // Missing source remains an explicit composition issue; never invent dimensions.
    if (!part) return copy;
    const bounds = placedBounds({ ...copy, xMm: 0, yMm: 0 }, part);
    const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
    if (x && x + width > rowWidth) { x = 0; y += rowHeight + 50; rowHeight = 0; }
    copy.xMm = x - bounds.minX; copy.yMm = y - bounds.minY;
    x += width + 50; rowHeight = Math.max(rowHeight, height);
    return copy;
  }));
}

export function differsFromPosition(recipe: CadRecipeRef | null, source: CadRecipeRef | null, defaults: Record<string, JsonValue> = {}): boolean {
  if (!recipe || !source || recipe.code !== source.code || recipe.version !== source.version) return !recipesEqual(recipe, source);
  return !recipesEqual({ ...recipe, parameters: { ...defaults, ...recipe.parameters } }, { ...source, parameters: { ...defaults, ...source.parameters } });
}
