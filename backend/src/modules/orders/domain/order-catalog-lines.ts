import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';

export interface SaveOrderCatalogLineDto {
  id?: number;
  clientKey?: string;
  catalogItemId: number;
  catalogVersion?: number;
  quantity: string;
  unitPrice: string;
  notes?: string;
}

export interface OrderCatalogLineDto extends SaveOrderCatalogLineDto {
  id: number;
  lineNumber: number;
  name: string;
  sku: string | null;
  kind: 'made_to_order' | 'stock_item' | 'service';
  unitId: number;
  unitName: string;
  refKey1c: string | null;
  amount: string;
  catalogActive: boolean;
}

export type EffectiveCatalogLine = Omit<OrderCatalogLineDto, 'id'> & { id?: number };
export interface OrderCatalogPlan {
  beforeAggregate?: Record<string, unknown> | null;
  before: OrderCatalogLineDto[];
  after: EffectiveCatalogLine[];
  writes: EffectiveCatalogLine[];
  deletedIds: number[];
}

export function catalogPlanInputs(plan: OrderCatalogPlan): SaveOrderCatalogLineDto[] {
  return plan.after.map(row => ({ id: row.id, clientKey: row.clientKey, catalogItemId: row.catalogItemId,
    catalogVersion: row.catalogVersion, quantity: row.quantity, unitPrice: row.unitPrice, notes: row.notes }));
}

const quantitySchema = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/).refine(v => Number(v) > 0);
const priceSchema = z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/);
const inputSchema = z.object({
  id: z.number().int().positive().safe().optional(),
  clientKey: z.string().trim().min(1).max(200).optional(),
  catalogItemId: z.number().int().positive().safe(),
  catalogVersion: z.number().int().positive().max(2147483646).optional(),
  quantity: quantitySchema,
  unitPrice: priceSchema,
  notes: z.string().max(2000).default(''),
}).strict().refine(row => row.id !== undefined || Boolean(row.clientKey), 'Укажите ID или ключ новой позиции');

function invalid(): never {
  throw new ApiError(422, 'ORDER_CATALOG_LINES_INVALID', 'Проверьте позиции товаров/услуг', { field: 'catalogLines' });
}

function scaled(value: string, digits: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0'));
}

export function catalogLineAmount(quantity: string, unitPrice: string): string {
  if (!quantitySchema.safeParse(quantity).success || !priceSchema.safeParse(unitPrice).success) invalid();
  const cents = (scaled(quantity, 3) * scaled(unitPrice, 2) + 500n) / 1000n;
  if (cents > 999999999999n) invalid();
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function normalizeCatalogLineInputs(value: unknown): SaveOrderCatalogLineDto[] | undefined {
  if (value === undefined) return undefined;
  const result = z.array(inputSchema).max(1000).safeParse(value);
  if (!result.success) invalid();
  const ids = new Set<number>();
  const keys = new Set<string>();
  return result.data.map(row => {
    if ((row.id !== undefined && ids.has(row.id)) || (row.clientKey && keys.has(row.clientKey))) invalid();
    if (row.id !== undefined) ids.add(row.id);
    if (row.clientKey) keys.add(row.clientKey);
    catalogLineAmount(row.quantity, row.unitPrice);
    const [whole, fraction = ''] = row.unitPrice.split('.');
    return { ...row, unitPrice: `${whole}.${fraction.padEnd(2, '0')}` };
  });
}

export function normalizeDeletedCatalogLineIds(value: unknown): number[] {
  if (value === undefined) return [];
  const result = z.array(z.number().int().positive().safe()).max(1000).safeParse(value);
  if (!result.success || new Set(result.data).size !== result.data.length) invalid();
  return result.data;
}

export function assertOrderHasPositions(detailCount: number, catalogLineCount: number): void {
  if (detailCount === 0 && catalogLineCount === 0) {
    throw new ApiError(422, 'ORDER_POSITIONS_REQUIRED', 'Добавьте хотя бы одну деталь или позицию товаров/услуг', { field: 'catalogLines' });
  }
}

export function catalogSubtotal(lines: ReadonlyArray<Pick<SaveOrderCatalogLineDto, 'quantity' | 'unitPrice'>>): number {
  const cents = lines.reduce((total, row) => total + scaled(catalogLineAmount(row.quantity, row.unitPrice), 2), 0n);
  if (cents > 999999999999n) invalid();
  return Number(cents) / 100;
}
