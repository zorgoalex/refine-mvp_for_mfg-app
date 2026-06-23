import type { OrderDetail } from '../types/orders';

export function groupDetailsBySheet(
  details: Array<Pick<OrderDetail, 'detail_id' | 'material_id' | 'sheet_material_type_id'>>,
): Map<number, typeof details> {
  const map = new Map<number, typeof details>();
  for (const detail of details) {
    const key = detail.sheet_material_type_id;
    if (key == null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(detail);
  }
  return map;
}
