import { formatNumber } from './numberFormat';

// AntD stringifies numeric field values before calling formatter. Keep this
// adapter local to numeric-state inputs; parsing and persistence stay unchanged.
export function formatInputNumber(value: number | string | null | undefined, precision = 0): string {
  return formatNumber(typeof value === 'string' ? Number(value) : value, precision);
}

export function optionalInputNumberFormatter(value: number | string | null | undefined, precision = 0): string {
  // Preserve the legacy distinction: numeric 0 is empty, native string '0' is not.
  return value ? formatInputNumber(value, precision) : '';
}
