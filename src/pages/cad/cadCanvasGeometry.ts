import type { CadGroup, CadSourcePart } from '@shared/cad-workspace';
import type { CadVisualization } from '@shared/cad-api';
export function placedBounds(group: CadGroup, part: CadSourcePart, copies = 1) {
  const angle = group.rotationDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const width = part.widthMm + (copies - 1) * (part.widthMm + 50);
  const points = [[0, 0], [width, 0], [width, part.heightMm], [0, part.heightMm]].map(([x, y]) => ({ x: group.xMm + x * c - y * s, y: group.yMm + x * s + y * c }));
  return { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) };
}
export function regionPath(polygons: CadVisualization['regions'][number]['polygons']) {
  return polygons.flatMap(p => [p.outer, ...p.holes]).map(ring => ring.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + ' Z').join(' ');
}
