import { CAD_MAX_GROUPS, createGroups, type CadGroup, type CadSourcePart, type CadSourceSnapshot } from '@shared/cad-workspace';
import { placedBounds } from './cadCanvasGeometry';

export const POSITION_GAP_MM = 150;
export const INSTANCE_GAP_MM = 50;

/** Conservative legacy auto-layout detection. Never infer pristine from version alone. */
export function isInitialPositionLayout(groups: CadGroup[], sources: CadSourceSnapshot[], version: number): boolean {
  if (version !== 1 || !groups.length) return false;
  const expected = createGroups(sources, () => '');
  return groups.length === expected.length && groups.every((g, i) => {
    const e = expected[i];
    return g.sourceSnapshotId === e.sourceSnapshotId && g.orderId === e.orderId && g.detailId === e.detailId &&
      g.quantity === e.quantity && g.xMm === e.xMm && g.yMm === e.yMm && g.rotationDeg === 0 && !g.placementGroupId;
  });
}

/** Presentation only, not nesting/CAM. Stable source order, right-to-left, top-to-bottom. */
export function layoutPositionBlocks(groups: CadGroup[], sources: CadSourceSnapshot[], aspect: number): CadGroup[] {
  if (groups.length > CAD_MAX_GROUPS || groups.some(g => g.quantity !== 1)) throw new Error('Сначала разверните количество в отдельные экземпляры');
  if (!groups.length) return groups;
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.6;
  const parts = new Map<string, CadSourcePart>(sources.flatMap(s => s.parts.map(p => [`${s.id}:${p.detailId}`, p] as const)));
  const byPosition = new Map<string, Array<{ group: CadGroup; bounds: ReturnType<typeof placedBounds> }>>();
  for (const group of groups) {
    const key = `${group.sourceSnapshotId}:${group.detailId}`, part = parts.get(key);
    if (!part || ![part.widthMm, part.heightMm].every(n => Number.isFinite(n) && n > 0) || !Number.isFinite(group.rotationDeg)) {
      throw new Error('Для раскладки нужны корректные размеры и источник каждой детали');
    }
    const members = byPosition.get(key) ?? [];
    members.push({ group, bounds: placedBounds({ ...group, xMm: 0, yMm: 0 }, part) });
    byPosition.set(key, members);
  }
  // Source position order, independent of current spatial order or interleaved instances.
  const blocks = [...parts.keys()].flatMap(key => {
    const members = byPosition.get(key); if (!members) return [];
    const cellWidth = Math.max(...members.map(m => m.bounds.maxX - m.bounds.minX));
    const cellHeight = Math.max(...members.map(m => m.bounds.maxY - m.bounds.minY));
    const columns = Math.min(members.length, Math.max(1, Math.round(Math.sqrt(members.length * ratio * cellHeight / cellWidth))));
    const rows = Math.ceil(members.length / columns);
    return [{ members, cellWidth, cellHeight, columns,
      width: columns * cellWidth + (columns - 1) * INSTANCE_GAP_MM,
      height: rows * cellHeight + (rows - 1) * INSTANCE_GAP_MM }];
  });
  const pack = (limit: number) => {
    let x = 0, top = 0, rowHeight = 0, width = 0;
    const placements = blocks.map(block => {
      if (x > 0 && x + block.width > limit) { top += rowHeight + POSITION_GAP_MM; x = 0; rowHeight = 0; }
      const p = { x, top }; width = Math.max(width, x + block.width);
      x += block.width + POSITION_GAP_MM; rowHeight = Math.max(rowHeight, block.height);
      return p;
    });
    const height = top + rowHeight;
    return { placements, width, height, score: Math.max(width / ratio, height) };
  };
  const area = blocks.reduce((n, b) => n + (b.width + POSITION_GAP_MM) * (b.height + POSITION_GAP_MM), 0);
  const widest = Math.max(...blocks.map(b => b.width)), ideal = Math.sqrt(area * ratio);
  let best = pack(widest);
  // Fixed bounded search: <=50 linear passes even for5000 different positions.
  for (let i = 0; i < 48; i++) {
    const candidate = pack(Math.max(widest, ideal * (.4 + i * .05)));
    if (candidate.score < best.score) best = candidate;
  }
  const positioned = new Map<string, CadGroup>();
  blocks.forEach((block, index) => {
    const p = best.placements[index];
    block.members.forEach(({ group, bounds }, n) => {
      const col = n % block.columns, row = Math.floor(n / block.columns);
      positioned.set(group.id, { ...group,
        xMm: best.width - p.x - col * (block.cellWidth + INSTANCE_GAP_MM) - bounds.maxX,
        yMm: best.height - p.top - row * (block.cellHeight + INSTANCE_GAP_MM) - bounds.maxY });
    });
  });
  return groups.map(g => positioned.get(g.id)!);
}
