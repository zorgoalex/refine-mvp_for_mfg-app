import type { OrderResourceDemandResponse } from '../../api/types/orderApi.types';

export type OrderResourceDemandRow = OrderResourceDemandResponse['data'][number];

export type ResourceKind = 'sheet_material' | 'film';
export type ResourceUnit = 'm2' | 'lm';
/** Откуда взято количество: готовый раскрой, площадь деталей или данных нет. */
export type ResourceSource = 'cut' | 'area' | 'none';

export interface ResourceDemandLine {
  resourceKey: string;
  kind: ResourceKind;
  refId: number;
  name: string;
  supplierLabel: string | null;
  /** null — количество не посчитано (например, нет готового раскроя). */
  quantity: number | null;
  unit: ResourceUnit;
  secondaryText: string | null;
  detailsCount: number;
  source: ResourceSource;
}

export interface ResourceKindMeta {
  kind: ResourceKind;
  label: string;
  shortLabel: string;
  letter: string;
  unit: ResourceUnit;
  color: { light: string; dark: string };
}

/**
 * Реестр типов ресурсов. Новый тип (кромка, фурнитура) добавляется записью здесь
 * и веткой адаптера `resourceDemandLines`; виды списка и карточки строятся по реестру.
 */
export const RESOURCE_KINDS: readonly ResourceKindMeta[] = [
  {
    kind: 'sheet_material',
    label: 'Листовые материалы',
    shortLabel: 'Листовые',
    letter: 'Л',
    unit: 'm2',
    color: { light: '#a0661c', dark: '#e0a45a' },
  },
  {
    kind: 'film',
    label: 'Плёнка',
    shortLabel: 'Плёнка',
    letter: 'П',
    unit: 'lm',
    color: { light: '#0e8f84', dark: '#4fd1c2' },
  },
];

export const RESOURCE_KIND_BY_KEY: Record<ResourceKind, ResourceKindMeta> = Object.fromEntries(
  RESOURCE_KINDS.map((meta) => [meta.kind, meta]),
) as Record<ResourceKind, ResourceKindMeta>;

export const SOURCE_LABELS: Record<ResourceSource, string> = {
  cut: 'по раскрою',
  area: 'по площади',
  none: 'нет раскроя',
};

const areaFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const meterFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const UNIT_LABELS: Record<ResourceUnit, string> = {
  m2: 'м²',
  lm: 'пог. м',
};

export function formatResourceQuantity(value: number, unit: ResourceUnit): string {
  const formatter = unit === 'lm' ? meterFormatter : areaFormatter;
  return `${formatter.format(value)} ${UNIT_LABELS[unit]}`;
}

export function formatArea(value: number): string {
  return `${areaFormatter.format(value)} м²`;
}

/** Адаптер текущего ответа API (`sheetMaterials`/`films`) в единые строки потребности. */
export function resourceDemandLines(row: OrderResourceDemandRow): ResourceDemandLine[] {
  const sheetLines = row.sheetMaterials.map<ResourceDemandLine>((material) => ({
    resourceKey: `sheet_material:${material.sheetMaterialTypeId}`,
    kind: 'sheet_material',
    refId: material.sheetMaterialTypeId,
    name: material.name,
    supplierLabel: material.supplierName ? `Поставщик: ${material.supplierName}` : null,
    quantity: material.totalArea,
    unit: 'm2',
    secondaryText: null,
    detailsCount: material.detailsCount,
    source: 'area',
  }));
  const filmLines = row.films.map<ResourceDemandLine>((film) => ({
    resourceKey: `film:${film.filmId}`,
    kind: 'film',
    refId: film.filmId,
    name: film.name,
    supplierLabel: film.vendorName ? `Производитель: ${film.vendorName}` : null,
    quantity: film.hasCutData ? film.linearMeters : null,
    unit: 'lm',
    secondaryText: formatArea(film.totalArea),
    detailsCount: film.detailsCount,
    source: film.hasCutData ? 'cut' : 'none',
  }));
  return [...sheetLines, ...filmLines];
}

export function linesOfKind(lines: ResourceDemandLine[], kind: ResourceKind): ResourceDemandLine[] {
  return lines.filter((line) => line.kind === kind);
}

export interface ResourceKindTotal {
  count: number;
  total: number;
  /** Строки без посчитанного количества; в сумму не входят. */
  missingCount: number;
}

export function resourceKindTotal(lines: ResourceDemandLine[], kind: ResourceKind): ResourceKindTotal {
  const kindLines = linesOfKind(lines, kind);
  return kindLines.reduce<ResourceKindTotal>(
    (acc, line) => (line.quantity == null
      ? { ...acc, missingCount: acc.missingCount + 1 }
      : { ...acc, total: acc.total + line.quantity }),
    { count: kindLines.length, total: 0, missingCount: 0 },
  );
}

export function formatKindTotal(total: ResourceKindTotal, kind: ResourceKind): string {
  if (total.count === 0) return '—';
  if (total.count === total.missingCount) return '—';
  return formatResourceQuantity(total.total, RESOURCE_KIND_BY_KEY[kind].unit);
}

export function formatLineQuantity(line: ResourceDemandLine): string {
  if (line.quantity == null) return line.kind === 'film' ? 'Нет готового раскроя' : '—';
  return formatResourceQuantity(line.quantity, line.unit);
}

export function positionsLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} позиция`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${count} позиции`;
  return `${count} позиций`;
}

export function orderDisplayName(row: OrderResourceDemandRow): string {
  return row.orderName?.trim() || `#${row.orderId}`;
}
