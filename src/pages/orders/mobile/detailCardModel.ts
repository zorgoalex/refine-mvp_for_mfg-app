export interface DetailCardLookups {
  millingNameOf: (row: Record<string, unknown>) => string;
  materialNameOf: (row: Record<string, unknown>) => string;
}

export interface DetailCardModel {
  num: string;
  size: string;
  material: string;
  milling: string;
  note: string;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

export function buildDetailCardModel(row: Record<string, unknown>, lookups: DetailCardLookups): DetailCardModel {
  const w = Number(row.width);
  const h = Number(row.height);
  const q = Number(row.quantity);
  const size =
    Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
      ? `${w}×${h}${Number.isFinite(q) && q > 0 ? ` — ${q} шт` : ''}`
      : '—';
  return {
    num: `№${s(row.detail_number) || '—'}`,
    size,
    material: lookups.materialNameOf(row) || '—',
    milling: lookups.millingNameOf(row) || '—',
    note: s(row.note),
  };
}
