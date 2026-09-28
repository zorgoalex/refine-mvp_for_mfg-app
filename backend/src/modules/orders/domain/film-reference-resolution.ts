// Разрешение ссылок на плёнку при записи заказа (план склада плёнки, §6.7):
// новые и изменённые ссылки на дубль заменяются каноном; неактивная итоговая
// запись отклоняется. Неизменённые (исторические) ссылки не трогаются.

export interface FilmReferenceWriteInput {
  headerFilmId: number | null;
  details: ReadonlyArray<{ detailId: number | null; filmId: number | null }>;
}

export interface StoredFilmReferences {
  headerFilmId: number | null;
  /** detail_id → сохранённый film_id (только детали этого заказа). */
  detailFilmIds: ReadonlyMap<number, number | null>;
}

export interface FilmRow {
  filmId: number;
  canonicalFilmId: number | null;
  isActive: boolean;
}

export interface FilmReferenceResolution {
  headerFilmId: number | null;
  /** В том же порядке, что `input.details`. */
  detailFilmIds: Array<number | null>;
  replacements: Array<{ from: number; to: number }>;
}

export type FilmReferenceProblem = { filmId: number; reason: 'not_found' | 'inactive' };

/** Ссылки, выбранные заново: новая деталь/заказ или значение, отличное от сохранённого. */
export function collectChangedFilmIds(input: FilmReferenceWriteInput, stored: StoredFilmReferences | null): number[] {
  const changed = new Set<number>();
  if (input.headerFilmId !== null && input.headerFilmId !== (stored?.headerFilmId ?? null)) {
    changed.add(input.headerFilmId);
  }
  for (const detail of input.details) {
    if (detail.filmId === null) continue;
    const storedValue = detail.detailId !== null && stored?.detailFilmIds.has(detail.detailId)
      ? stored.detailFilmIds.get(detail.detailId) ?? null
      : undefined;
    if (storedValue === undefined || storedValue !== detail.filmId) changed.add(detail.filmId);
  }
  return [...changed].sort((a, b) => a - b);
}

/** Все записи, которые нужно заблокировать: выбранные и их текущие каноны, по возрастанию. */
export function filmIdsToLock(changed: readonly number[], rows: ReadonlyArray<FilmRow>): number[] {
  const ids = new Set<number>(changed);
  for (const row of rows) if (row.canonicalFilmId !== null) ids.add(row.canonicalFilmId);
  return [...ids].sort((a, b) => a - b);
}

/**
 * Вычисление замены по состоянию под блокировкой. Возвращает проблемы, если
 * выбранная запись не найдена или итоговая (каноническая) запись неактивна.
 */
export function resolveFilmReferences(
  input: FilmReferenceWriteInput,
  stored: StoredFilmReferences | null,
  lockedRows: ReadonlyArray<FilmRow>,
): { resolution: FilmReferenceResolution; problems: FilmReferenceProblem[] } {
  const byId = new Map(lockedRows.map((row) => [row.filmId, row]));
  const changed = new Set(collectChangedFilmIds(input, stored));
  const problems = new Map<number, FilmReferenceProblem>();
  const replacements = new Map<number, number>();

  const resolveOne = (filmId: number | null): number | null => {
    if (filmId === null || !changed.has(filmId)) return filmId;
    const row = byId.get(filmId);
    if (!row) {
      problems.set(filmId, { filmId, reason: 'not_found' });
      return filmId;
    }
    const target = row.canonicalFilmId === null ? row : byId.get(row.canonicalFilmId);
    if (!target) {
      problems.set(filmId, { filmId, reason: 'not_found' });
      return filmId;
    }
    if (!target.isActive) {
      problems.set(filmId, { filmId, reason: 'inactive' });
      return filmId;
    }
    if (target.filmId !== filmId) replacements.set(filmId, target.filmId);
    return target.filmId;
  };

  const headerFilmId = input.headerFilmId !== null && input.headerFilmId !== (stored?.headerFilmId ?? null)
    ? resolveOne(input.headerFilmId)
    : input.headerFilmId;
  const detailFilmIds = input.details.map((detail) => {
    const storedValue = detail.detailId !== null && stored?.detailFilmIds.has(detail.detailId)
      ? stored.detailFilmIds.get(detail.detailId) ?? null
      : undefined;
    return storedValue !== undefined && storedValue === detail.filmId ? detail.filmId : resolveOne(detail.filmId);
  });
  return {
    resolution: {
      headerFilmId,
      detailFilmIds,
      replacements: [...replacements.entries()].sort((a, b) => a[0] - b[0]).map(([from, to]) => ({ from, to })),
    },
    problems: [...problems.values()].sort((a, b) => a.filmId - b.filmId),
  };
}
