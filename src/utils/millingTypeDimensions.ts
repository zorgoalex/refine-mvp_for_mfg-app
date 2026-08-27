export interface MillingTypeDimensionOption {
  value: string | number;
  label?: unknown;
  minWidthMm?: number | null;
  minHeightMm?: number | null;
  disabled?: boolean;
  title?: string;
  [key: string]: unknown;
}

const positiveDimension = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export function millingTypeFitsDetail(
  option: MillingTypeDimensionOption,
  detailWidthMm: unknown,
  detailHeightMm: unknown,
): boolean {
  const minWidthMm = positiveDimension(option.minWidthMm);
  const minHeightMm = positiveDimension(option.minHeightMm);
  const widthMm = positiveDimension(detailWidthMm);
  const heightMm = positiveDimension(detailHeightMm);

  if (minWidthMm !== null && (widthMm === null || widthMm < minWidthMm)) return false;
  if (minHeightMm !== null && (heightMm === null || heightMm < minHeightMm)) return false;
  return true;
}

export function millingTypeDimensionWarning(
  option: MillingTypeDimensionOption | undefined,
  detailWidthMm: unknown,
  detailHeightMm: unknown,
): string | null {
  if (!option || millingTypeFitsDetail(option, detailWidthMm, detailHeightMm)) return null;

  const minWidthMm = positiveDimension(option.minWidthMm);
  const minHeightMm = positiveDimension(option.minHeightMm);
  const minimum = `${minWidthMm ?? '—'} × ${minHeightMm ?? '—'} мм`;
  const actualWidthMm = positiveDimension(detailWidthMm);
  const actualHeightMm = positiveDimension(detailHeightMm);
  const actual = actualWidthMm === null || actualHeightMm === null
    ? 'размеры детали заполнены не полностью'
    : `размер детали ${actualWidthMm} × ${actualHeightMm} мм`;

  return `Возможна проблема с фрезеровкой: минимум ${minimum}, ${actual}.`;
}
