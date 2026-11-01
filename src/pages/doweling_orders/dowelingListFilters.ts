// Filters and search of «Базис-проекты». The list is loaded whole (a few hundred rows, see list.tsx), so the filters
// of the shared «Фильтры» bar are applied here, on the loaded rows: the search looks in the Bazis project, the order
// and the client at once (one text, several columns), and the select options are the values present in the list.
import type { ReferenceFilterConfig, RefineFilter } from '../../components/referenceFilters/referenceFilterModel';
import { ACTIVE_FIELD } from '../../components/referenceFilters/referenceFilterModel';
import { compareNatural } from '../../utils/naturalSort';

export type DowelingRow = Record<string, unknown>;

/** Pseudo-field of the search: the Bazis project, the order and the client. */
export const SEARCH_FIELD = 'q';
const SEARCH_COLUMNS = ['doweling_order_name', 'order_name', 'client_name'] as const;
/** Pseudo-field «XML Базиса есть / нет» (bazis_xml_count > 0). */
export const HAS_XML_FIELD = 'has_xml';

const SELECT_FIELDS: ReadonlyArray<{ field: string; label: string; financial?: boolean }> = [
  { field: 'design_engineer', label: 'Конструктор' },
  { field: 'operator', label: 'Оператор' },
  { field: 'production_status_name', label: 'Статус производства' },
  { field: 'payment_status_name', label: 'Статус оплаты', financial: true },
  { field: 'material_name', label: 'Материал' },
  { field: 'milling_type_name', label: 'Фрезеровка' },
  { field: 'edge_type_name', label: 'Обкат' },
];

const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
const lower = (value: unknown) => text(value).toLocaleLowerCase('ru');

/** The values present in the rows, in the natural order (the options of a select). */
function presentValues(rows: readonly DowelingRow[], field: string) {
  const values = [...new Set(rows.map((row) => text(row[field]).trim()).filter(Boolean))].sort(compareNatural);
  return values.map((value) => ({ value, label: value }));
}

export function dowelingFilterConfig(rows: readonly DowelingRow[], canViewFinancials: boolean): ReferenceFilterConfig {
  return {
    search: { field: SEARCH_FIELD, placeholder: 'Поиск: Базис-проект, заказ, клиент' },
    activeField: true,
    fields: [
      { kind: 'text', field: 'client_name', label: 'Клиент' },
      { kind: 'text', field: 'order_name', label: 'Заказ' },
      ...SELECT_FIELDS.filter((item) => canViewFinancials || !item.financial).map((item) => ({
        kind: 'select' as const, field: item.field, label: item.label, options: presentValues(rows, item.field),
      })),
      { kind: 'boolean', field: HAS_XML_FIELD, label: 'XML Базиса', yes: 'есть', no: 'нет' },
      { kind: 'range', field: 'parts_count', label: 'Кол-во деталей' },
    ],
  };
}

const asBoolean = (value: unknown) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined);
const asNumber = (value: unknown) => (value === null || value === undefined || value === '' ? undefined : Number(value));

function matches(row: DowelingRow, filter: RefineFilter): boolean {
  const field = String(filter.field ?? '');
  const { operator, value } = filter;
  if (value === undefined || value === null || value === '') return true;
  if (field === SEARCH_FIELD) {
    const needle = lower(value).trim();
    return !needle || SEARCH_COLUMNS.some((column) => lower(row[column]).includes(needle));
  }
  if (field === HAS_XML_FIELD) {
    const wanted = asBoolean(value);
    return wanted === undefined || (Number(row.bazis_xml_count ?? 0) > 0) === wanted;
  }
  if (operator === 'contains') return lower(row[field]).includes(lower(value).trim());
  if (operator === 'eq') return text(row[field]) === text(value);
  if (operator === 'gte' || operator === 'lte') {
    const bound = asNumber(value);
    if (bound === undefined || !Number.isFinite(bound)) return true;
    const cell = asNumber(row[field]);
    if (cell === undefined || !Number.isFinite(cell)) return false;
    return operator === 'gte' ? cell >= bound : cell <= bound;
  }
  return true;
}

/**
 * The rows the filters let through. «Показывать неактивные» is the shared `is_active` filter: without it only active
 * cards (delete_flag false) are shown.
 */
export function applyDowelingFilters(rows: readonly DowelingRow[], filters: readonly RefineFilter[] | undefined): DowelingRow[] {
  const list = filters ?? [];
  const showInactive = list.some((filter) => filter.field === ACTIVE_FIELD
    && (Array.isArray(filter.value) ? filter.value : [filter.value]).some((value) => value === false || value === 'false'));
  const own = list.filter((filter) => filter.field !== ACTIVE_FIELD);
  return rows.filter((row) => (showInactive || row.delete_flag !== true) && own.every((filter) => matches(row, filter)));
}
