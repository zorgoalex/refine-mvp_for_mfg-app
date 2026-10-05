import { useList } from '@refinedev/core';
import { useMemo } from 'react';
import { missingFilmIds } from './filmNameMap';

interface FilmNameRow {
  film_id: number;
  film_name: string;
}

/**
 * Карта названий плёнок, дополненная записями, которых нет среди активных
 * (например, дубли, объединённые импортом каталога, — они неактивны, но старые
 * заказы продолжают на них ссылаться). Догружаются только недостающие ID.
 */
export function useFilmNamesWithInactive(
  baseNames: Map<number, string>,
  filmIds: ReadonlyArray<number | null | undefined>,
  enabled = true,
): Map<number, string> {
  const missing = useMemo(() => missingFilmIds(baseNames, filmIds), [baseNames, filmIds]);
  const { data } = useList<FilmNameRow>({
    resource: 'films',
    filters: [{ field: 'film_id', operator: 'in', value: missing }],
    pagination: { mode: 'off' },
    meta: { fields: ['film_id', 'film_name'] },
    queryOptions: { enabled: enabled && missing.length > 0 },
  });
  return useMemo(() => {
    const rows = data?.data ?? [];
    if (rows.length === 0) return baseNames;
    const merged = new Map(baseNames);
    for (const row of rows) {
      if (!merged.has(Number(row.film_id))) merged.set(Number(row.film_id), row.film_name);
    }
    return merged;
  }, [baseNames, data?.data]);
}
