import type { Key } from 'react';
import type { OrderResourceDemandFilters, OrderResourceDemandLineDto } from '../../api/types/orderApi.types';

/** Значение «(без …)» в фильтре заголовка. */
export const RESOURCE_FILTER_EMPTY = '__order_resource_requirement_filter_empty__';
/** «Отключить все»: ничего не выбрано. */
export const RESOURCE_FILTER_NONE = '__order_resource_requirement_filter_none__';
/** Ключ «без поставщика» (тот же, что у backend). */
export const SUPPLIER_NONE_KEY = 'none';

export type HeaderFilterField = 'order' | 'date' | 'sheetMaterials' | 'films' | 'suppliers';
export type HeaderFilterState = Record<HeaderFilterField, Key[] | null>;

/** Лимит значений в одном фильтре (тот же у backend). */
export const HEADER_FILTER_VALUES_LIMIT = 500;

const FIELD_TITLES: Record<HeaderFilterField, string> = {
  order: 'Заказ',
  date: 'Дата заказа',
  sheetMaterials: 'Листовые материалы',
  films: 'Плёнка',
  suppliers: 'Поставщик',
};

/** Значения фильтра заголовка, известные интерфейсу (варианты по всей выборке ТЕКУЩИХ фильтров панели). */
export type HeaderFilterValues = Record<HeaderFilterField, { values: string[]; complete: boolean }>;

/**
 * Фильтры заголовков → параметры запроса. Выбранное «(без …)» — `none`; «Отключить все» (или снятые все
 * галочки) — `nothingSelected`: заказов нет, запрос не нужен. До лимита выбор передаётся явным списком;
 * выбор длиннее лимита — дополнение «все, кроме» (`usesExclusion`, может быть пустым), но только по вариантам текущей выборки
 * (`known` передаётся, лишь пока варианты загружены для тех же фильтров панели). Ни выбор, ни дополнение не
 * укладываются в лимит — `tooMany`: фильтр не применяется, запроса нет.
 */
export function resourceDemandHeaderQuery(filters: HeaderFilterState, known?: HeaderFilterValues): {
  filters: Pick<OrderResourceDemandFilters, 'orderIds' | 'orderDates' | 'sheetMaterialTypeIds' | 'filmIds' | 'supplierKeys'>;
  nothingSelected: boolean;
  usesExclusion: boolean;
  /** Причина, по которой выбор нельзя передать (слишком много значений), иначе null. */
  tooMany: string | null;
} {
  const selected = (field: HeaderFilterField): string[] | null => {
    const keys = filters[field];
    return keys && keys.length > 0 ? keys.map(String) : null;
  };
  const fields: HeaderFilterField[] = ['order', 'date', 'sheetMaterials', 'films', 'suppliers'];
  const nothingSelected = fields.some((field) => {
    const keys = selected(field);
    return keys !== null && keys.every((key) => key === RESOURCE_FILTER_NONE);
  });
  const values = (field: HeaderFilterField) => (selected(field) ?? []).filter((key) => key !== RESOURCE_FILTER_NONE);
  const token = (key: string) => (key === RESOURCE_FILTER_EMPTY ? 'none' : key);
  let usesExclusion = false;
  let tooMany: string | null = null;
  const list = (field: HeaderFilterField): string | undefined => {
    const chosen = values(field);
    if (chosen.length === 0) return undefined;
    // До лимита выбор всегда передаётся явно — даже если сейчас он покрывает все варианты: позже в выборке могут
    // появиться значения, которые пользователь не отмечал. Снять фильтр можно только «Сбросить».
    if (chosen.length <= HEADER_FILTER_VALUES_LIMIT) return chosen.map(token).join(',');
    const universe = known?.[field];
    if (universe?.complete) {
      const chosenSet = new Set(chosen);
      const rest = universe.values.filter((value) => !chosenSet.has(value));
      if (rest.length <= HEADER_FILTER_VALUES_LIMIT) {
        usesExclusion = true;
        return `!${rest.map(token).join(',')}`;
      }
    }
    tooMany ??= `В фильтре «${FIELD_TITLES[field]}» выбрано ${chosen.length} значений — фильтр не применён. `
      + `Отметьте не больше ${HEADER_FILTER_VALUES_LIMIT} или снимите не больше ${HEADER_FILTER_VALUES_LIMIT}.`;
    return undefined;
  };
  const orderIds = values('order').map(Number);
  if (orderIds.length > HEADER_FILTER_VALUES_LIMIT) {
    tooMany ??= `В фильтре «${FIELD_TITLES.order}» выбрано ${orderIds.length} заказов — фильтр не применён. Отметьте не больше ${HEADER_FILTER_VALUES_LIMIT}.`;
  }
  const orderDates = list('date');
  const sheetMaterialTypeIds = list('sheetMaterials');
  const filmIds = list('films');
  const supplierKeys = list('suppliers');
  return {
    filters: {
      ...(orderIds.length > 0 ? { orderIds } : {}),
      ...(orderDates ? { orderDates } : {}),
      ...(sheetMaterialTypeIds ? { sheetMaterialTypeIds } : {}),
      ...(filmIds ? { filmIds } : {}),
      ...(supplierKeys ? { supplierKeys } : {}),
    },
    nothingSelected,
    usesExclusion,
    tooMany,
  };
}

/** Поставщики материалов заказа (основные): по одному разу, без «не указан». */
export function rowSupplierNames(row: { lines?: OrderResourceDemandLineDto[] }): string[] {
  const names = new Map<string, string>();
  for (const line of row.lines ?? []) {
    if (line.orphan || !line.supplierName || line.supplierKey === SUPPLIER_NONE_KEY) continue;
    // Прежний backend без supplierKey у плёнки клал производителя — такие строки не считаем поставщиком.
    if (line.supplierKey === undefined && line.kind === 'film' && line.supplierRole !== 'supplier') continue;
    names.set(line.supplierKey ?? line.supplierName, line.supplierName);
  }
  return [...names.values()].sort(compareNames);
}


function compareNames(left: string, right: string): number {
  return left.localeCompare(right, 'ru', { numeric: true, sensitivity: 'base' });
}
