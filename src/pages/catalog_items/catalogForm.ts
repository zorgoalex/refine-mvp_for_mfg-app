import type { CatalogInput, CatalogItem, CatalogKind } from '../../api/catalogApi';
import { ApiError } from '../../api/apiError';

export const CATALOG_KIND_OPTIONS: { value: CatalogKind; label: string }[] = [
  { value: 'made_to_order', label: 'Товар под заказ' },
  { value: 'stock_item', label: 'Готовый товар' },
  { value: 'service', label: 'Услуга' },
];
export function catalogDraft(item?: CatalogItem): Partial<CatalogInput> {
  return item ? { name: item.name, sku: item.sku, kind: item.kind, unitId: item.unitId, basePrice: item.basePrice, description: item.description, isActive: item.isActive }
    : { name: '', sku: null, kind: 'service', basePrice: null, description: '', isActive: true };
}
export function catalogPayload(draft: CatalogInput): CatalogInput {
  const raw = draft.basePrice === null || draft.basePrice === undefined || draft.basePrice === '' ? null : String(draft.basePrice).replace(',', '.');
  if (raw !== null && !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(raw)) throw new Error('Цена: от 0 до 9999999999.99, максимум два знака после точки');
  const [whole, fraction = ''] = raw?.split('.') ?? [];
  return { name: draft.name.trim(), sku: draft.sku?.trim() || null, kind: draft.kind, unitId: draft.unitId,
    basePrice: raw === null ? null : `${whole}.${fraction.padEnd(2, '0')}`, description: (draft.description ?? '').trim(), isActive: draft.isActive };
}

export function catalogFailureState(error: unknown, submitted: boolean) {
  return {
    uncertain: submitted && (!(error instanceof ApiError) || !error.status || error.status >= 500 || error.status === 408),
    stale: error instanceof ApiError && error.code === 'CATALOG_VERSION_CONFLICT',
    message: error instanceof Error ? error.message : 'Не удалось сохранить',
  };
}

export function catalogCommandIdentity(previous: { fingerprint: string; key: string } | undefined, fingerprint: string) {
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: crypto.randomUUID() };
}
