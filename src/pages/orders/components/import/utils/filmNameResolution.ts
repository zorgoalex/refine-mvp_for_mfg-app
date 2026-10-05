import type { FilmNameIndexItem, FilmNameIndexResponse } from '../../../../../api/filmNameIndexApi';
import type { FilmNameIndexStatus, ReferenceItem } from '../types/importTypes';

const EMPTY_INDEX: FilmNameIndexItem[] = [];

export interface FilmNameIndexState {
  items: FilmNameIndexItem[];
  status: FilmNameIndexStatus;
}

/**
 * Состояние индекса по результату запроса. Ошибка и обрезанный индекс — `unavailable`:
 * без полного индекса текущее имя одной плёнки нельзя отличить от прежнего имени другой.
 */
export function filmNameIndexState(query: {
  isSuccess: boolean;
  isError: boolean;
  data?: FilmNameIndexResponse;
}): FilmNameIndexState {
  if (query.isSuccess && query.data) {
    return query.data.truncated === true
      ? { items: EMPTY_INDEX, status: 'unavailable' }
      : { items: query.data.items, status: 'ready' };
  }
  if (query.isError) return { items: EMPTY_INDEX, status: 'unavailable' };
  return { items: EMPTY_INDEX, status: 'loading' };
}

export const normalizeFilmName = (name: string): string => name
  .toLocaleLowerCase('ru-RU')
  .replace(/ё/g, 'е')
  .replace(/\s+/g, ' ')
  .trim();

export type FilmNameResolution =
  | { status: 'matched'; filmId: number; source: 'current' | 'history' }
  | { status: 'ambiguous'; filmIds: number[] }
  | { status: 'unmatched' };

export function resolveFilmName(
  name: string | null | undefined,
  activeFilms: ReferenceItem[],
  nameIndex: FilmNameIndexItem[],
): FilmNameResolution {
  if (!name) return { status: 'unmatched' };
  const normalized = normalizeFilmName(name);
  if (!normalized) return { status: 'unmatched' };

  // Текущие и прежние точные совпадения рассматриваются вместе: текущее имя одной
  // плёнки может совпадать с прежним именем другой — тогда выбирает пользователь.
  // Активные основные плёнки — по справочнику и по полному индексу: справочник модалок
  // ограничен страницей, и плёнка за её пределами иначе выпала бы из кандидатов.
  const activeIds = new Set(activeFilms.map(({ id }) => id));
  for (const item of nameIndex) {
    if (item.source === 'current' && item.active && (item.canonicalFilmId ?? item.filmId) === item.filmId) {
      activeIds.add(item.filmId);
    }
  }
  const candidates = new Map<number, 'current' | 'history'>();
  for (const film of activeFilms) {
    if (normalizeFilmName(film.name) === normalized) candidates.set(film.id, 'current');
  }
  for (const item of nameIndex) {
    if (normalizeFilmName(item.name) !== normalized) continue;
    const canonicalId = item.canonicalFilmId ?? item.filmId;
    // Прежние названия и дубли неактивны; активной должна быть основная плёнка.
    if (activeIds.has(canonicalId) && !candidates.has(canonicalId)) candidates.set(canonicalId, 'history');
  }
  if (candidates.size === 1) {
    const [[filmId, source]] = [...candidates];
    return { status: 'matched', filmId, source };
  }
  if (candidates.size > 1) return { status: 'ambiguous', filmIds: [...candidates.keys()] };
  return { status: 'unmatched' };
}
