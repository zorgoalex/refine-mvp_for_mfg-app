/** «NewLine», список пользователей: разбор фильтров таблицы для поиска и отбора по активности. */
export type UserActiveChoice = 'all' | 'active' | 'inactive';

type AnyFilter = { field?: string; value?: unknown };

const fieldValue = (filters: readonly unknown[] | undefined, field: string): unknown =>
  (filters ?? []).find((filter): filter is AnyFilter => !!filter && (filter as AnyFilter).field === field)?.value;

/** Значение фильтра активности из адреса бывает строкой или массивом из колоночного фильтра. */
export function userActiveFilterChoice(filters: readonly unknown[] | undefined): UserActiveChoice {
  let value = fieldValue(filters, 'is_active');
  if (Array.isArray(value)) value = value.length === 1 ? value[0] : undefined;
  if (value === true || value === 'true') return 'active';
  if (value === false || value === 'false') return 'inactive';
  return 'all';
}

export function userSearchText(filters: readonly unknown[] | undefined): string {
  const value = fieldValue(filters, 'username');
  return typeof value === 'string' ? value.trim() : '';
}

export const userInitials = (name: string): string => name
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0]?.toUpperCase() ?? '')
  .join('');
