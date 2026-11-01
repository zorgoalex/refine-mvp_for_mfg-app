import { withRoundSuffix } from '../../../api/orderReworkApi';

export interface DetailCardLookups {
  millingNameOf: (row: Record<string, unknown>) => string;
  materialNameOf: (row: Record<string, unknown>) => string;
  /** Current stage name of the detail (empty — no stage line). */
  stageNameOf?: (row: Record<string, unknown>) => string;
}

export interface DetailCardModel {
  num: string;
  size: string;
  material: string;
  milling: string;
  /** Stage with the «Переделка» round suffix («Распилен ·2»); empty — no stage. */
  stage: string;
  note: string;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function stageOf(row: Record<string, unknown>, lookups: DetailCardLookups): string {
  const name = lookups.stageNameOf?.(row) ?? '';
  return name ? withRoundSuffix(name, Number(row.production_round)) : '';
}

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
    stage: stageOf(row, lookups),
    note: s(row.note),
  };
}
