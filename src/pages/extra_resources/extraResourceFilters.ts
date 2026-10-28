import { boolFromFilter, filterValue, showsInactive, type RefineFilter, type ReferenceFilterConfig } from '../../components/referenceFilters/referenceFilterModel';

export const EXTRA_RESOURCE_KIND_OPTIONS = [
  { label: 'Листовой материал', value: 'sheet_material' },
  { label: 'Шпон', value: 'veneer' },
  { label: 'Краска', value: 'paint' },
  { label: 'Замазка', value: 'putty' },
  { label: 'Другое', value: 'other' },
];

/** The dictionary is loaded whole: the same filter panel as other references, applied to the loaded rows. */
export const EXTRA_RESOURCE_FILTERS: ReferenceFilterConfig = {
  search: { field: 'resourceName', placeholder: 'Поиск по названию' },
  activeField: true,
  fields: [
    { kind: 'select', field: 'resourceKind', label: 'Тип', options: EXTRA_RESOURCE_KIND_OPTIONS },
    { kind: 'boolean', field: 'hdfAutoDefault', label: 'Авто ХДФ', yes: 'Да', no: 'Нет' },
    { kind: 'text', field: 'comment', label: 'Комментарий' },
  ],
};

type Row = { id?: number; resourceName: string; resourceKind: string; hdfAutoDefault: boolean; comment: string; isActive: boolean };

/**
 * Unsaved new rows and rows with unsaved edits (`keepVisible`) always stay visible: a filter must not hide a row
 * together with its «Сохранить» (switching a resource off or renaming it would otherwise make it vanish).
 */
export function filterExtraResources<T extends Row>(
  rows: readonly T[],
  filters: readonly RefineFilter[],
  keepVisible: (row: T) => boolean = () => false,
): T[] {
  const search = String(filterValue(filters, 'resourceName', 'contains') ?? '').trim().toLowerCase();
  const kind = filterValue(filters, 'resourceKind', 'eq');
  const hdf = boolFromFilter(filterValue(filters, 'hdfAutoDefault', 'eq'));
  const comment = String(filterValue(filters, 'comment', 'contains') ?? '').trim().toLowerCase();
  const inactive = showsInactive(filters);
  return rows.filter((row) => {
    if (row.id === undefined || keepVisible(row)) return true;
    if (!inactive && !row.isActive) return false;
    if (search && !row.resourceName.toLowerCase().includes(search)) return false;
    if (kind !== undefined && kind !== '' && row.resourceKind !== kind) return false;
    if (hdf !== undefined && row.hdfAutoDefault !== hdf) return false;
    if (comment && !row.comment.toLowerCase().includes(comment)) return false;
    return true;
  });
}
