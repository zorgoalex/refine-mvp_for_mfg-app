import type { CatalogKind } from '../api/catalogApi';

export interface OrderCatalogLine {
  id?: number;
  clientKey?: string;
  catalogItemId: number;
  catalogVersion?: number;
  lineNumber?: number;
  name: string;
  sku: string | null;
  kind: CatalogKind;
  unitId: number;
  unitName: string;
  refKey1c: string | null;
  quantity: string;
  unitPrice: string;
  amount?: string;
  notes?: string;
  catalogActive: boolean;
}

export const catalogKindLabels: Record<CatalogKind, string> = {
  made_to_order: 'Под заказ', stock_item: 'Складской товар', service: 'Услуга',
};

export function orderCatalogLineAmount(quantity: string, unitPrice: string): string | null {
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/.test(quantity) || Number(quantity) <= 0
    || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(unitPrice)) return null;
  const scaled = (value: string, precision: number) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0'));
  };
  const cents = (scaled(quantity, 3) * scaled(unitPrice, 2) + 500n) / 1000n;
  if (cents > 999999999999n) return null;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function orderCatalogSubtotal(lines: readonly OrderCatalogLine[] = []): number {
  return Number(lines.reduce((sum, row) => {
    const amount = orderCatalogLineAmount(row.quantity, row.unitPrice);
    return sum + (amount === null ? 0n : BigInt(amount.replace('.', '')));
  }, 0n)) / 100;
}

export function orderCatalogLineInput(row: OrderCatalogLine) {
  return { id: row.id, clientKey: row.clientKey, catalogItemId: row.catalogItemId, catalogVersion: row.catalogVersion,
    quantity: row.quantity, unitPrice: row.unitPrice, notes: row.notes ?? '' };
}
