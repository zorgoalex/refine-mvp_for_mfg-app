import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OrderFormData, OrderFormDetail } from './order-form-data';

/** Layout shared by the PDF and the image forms: the same rows, numbers and texts as the print form. */
// Column widths follow the print form (orderProductionPdf.ts colgroup, % of the table width).
export const COLUMN_PERCENTS = [3.06, 6.48, 6.36, 5.53, 4.36, 15.79, 4.36, 18.73, 6.83, 10.96, 18.54];
export const HEADERS = ['№', 'Высота', 'Ширина', 'Кол-во', 'Площадь', 'Тип детали', 'Обкат', 'Примечание', 'Цена за кв.м.', 'Сумма', 'Пленка'];
export const NUMERIC = new Set([0, 1, 2, 3, 4, 8, 9]);

export type Row = { kind: 'detail'; ordinal: number; detail: OrderFormDetail } | { kind: 'blank' };

/** Production layout groups details by film with a blank row between groups (as the print form). */
export function rows(data: OrderFormData, financial: boolean): Row[] {
  const list = data.details;
  if (financial) return list.map((detail, index) => ({ kind: 'detail', ordinal: index + 1, detail }));
  const groups = new Map<string, OrderFormDetail[]>();
  for (const detail of list) {
    const key = detail.film?.trim() || '';
    groups.set(key, [...(groups.get(key) ?? []), detail]);
  }
  const ordered = [...[...groups.entries()].filter(([key]) => key !== ''), ...[...groups.entries()].filter(([key]) => key === '')];
  const result: Row[] = [];
  let ordinal = 0;
  ordered.forEach(([, group], index) => {
    if (index > 0) result.push({ kind: 'blank' });
    for (const detail of group) result.push({ kind: 'detail', ordinal: (ordinal += 1), detail });
  });
  return result;
}

export function area(detail: OrderFormDetail): number | null {
  if (detail.height === null || detail.width === null) return null;
  return Math.round((detail.height / 1000) * (detail.width / 1000) * detail.quantity * 100) / 100;
}

/** As the order calculation: the stored detail cost wins, otherwise area × rate. */
export function detailSum(detail: OrderFormDetail): number | null {
  if (detail.detailCost !== null) return Math.round(detail.detailCost * 100) / 100;
  const value = area(detail);
  if (detail.millingCostPerSqm === null || value === null) return null;
  return Math.round(value * detail.millingCostPerSqm * 100) / 100;
}

export const money = (value: number | null) => value === null ? '' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
export const decimal = (value: number | null) => value === null ? '' : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
export const date = (value: Date | null) => value ? `${String(value.getDate()).padStart(2, '0')}.${String(value.getMonth() + 1).padStart(2, '0')}.${value.getFullYear()}` : '';

export function common(details: OrderFormDetail[], pick: (detail: OrderFormDetail) => string | null): string {
  const values = details.map(pick).filter((value): value is string => Boolean(value));
  return values.length && values.every((value) => value === values[0]) ? values[0] : '';
}

export function note(detail: OrderFormDetail): string {
  const original = (detail.note ?? '').replace(/\r\n?/g, '\n').trim();
  if (!detail.doweling) return original;
  if (original.toLocaleLowerCase('ru-RU').includes('присадка')) return original;
  return original ? `Присадка\n${original}` : 'Присадка';
}

/** A bundled backend font (assets/fonts), from dist, the backend dir or the repo root. */
export function fontPath(file: string): string | null {
  const candidates = [
    resolve(__dirname, '../../../../../assets/fonts', file),
    join(process.cwd(), 'assets/fonts', file),
    join(process.cwd(), 'backend/assets/fonts', file),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}
