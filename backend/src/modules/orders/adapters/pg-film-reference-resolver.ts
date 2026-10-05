import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import {
  collectChangedFilmIds,
  filmIdsToLock,
  resolveFilmReferences,
  type FilmReferenceResolution,
  type FilmReferenceWriteInput,
  type FilmRow,
  type StoredFilmReferences,
} from '../domain/film-reference-resolution';

let canonicalColumnPresent: boolean | null = null;

/** Для тестов: сброс кэша наличия колонки films.canonical_film_id. */
export function resetFilmCanonicalColumnCache(): void {
  canonicalColumnPresent = null;
}

async function hasCanonicalColumn(tx: TransactionClient): Promise<boolean> {
  if (canonicalColumnPresent === true) return true;
  const result = await tx.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'films' AND column_name = 'canonical_film_id'
     ) AS present`,
  );
  // Положительный результат кэшируется навсегда (миграция не откатывается во время
  // работы процесса); отрицательный — перепроверяется, пока миграция не применена.
  canonicalColumnPresent = result.rows[0]?.present === true ? true : null;
  return canonicalColumnPresent === true;
}

async function loadStored(tx: TransactionClient, orderId: number, detailIds: number[]): Promise<StoredFilmReferences> {
  const header = await tx.query<{ film_id: string | number | null }>(
    'SELECT film_id FROM orders WHERE order_id = $1',
    [orderId],
  );
  const details = detailIds.length === 0
    ? { rows: [] as Array<{ detail_id: string | number; film_id: string | number | null }> }
    : await tx.query<{ detail_id: string | number; film_id: string | number | null }>(
      'SELECT detail_id, film_id FROM order_details WHERE order_id = $1 AND detail_id = ANY($2::bigint[])',
      [orderId, detailIds],
    );
  return {
    headerFilmId: header.rows[0]?.film_id == null ? null : Number(header.rows[0].film_id),
    detailFilmIds: new Map(details.rows.map((row) => [Number(row.detail_id), row.film_id == null ? null : Number(row.film_id)])),
  };
}

async function readFilms(tx: TransactionClient, ids: number[], lock: boolean): Promise<FilmRow[]> {
  if (ids.length === 0) return [];
  const result = await tx.query<{ film_id: string | number; canonical_film_id: string | number | null; is_active: boolean }>(
    `SELECT film_id, canonical_film_id, is_active FROM films
      WHERE film_id = ANY($1::bigint[])
      ORDER BY film_id${lock ? ' FOR SHARE' : ''}`,
    [ids],
  );
  return result.rows.map((row) => ({
    filmId: Number(row.film_id),
    canonicalFilmId: row.canonical_film_id == null ? null : Number(row.canonical_film_id),
    isActive: row.is_active === true,
  }));
}

/**
 * Разрешает новые и изменённые ссылки заказа на плёнку в канон под `FOR SHARE`
 * (после блокировок проекта/заказа, по возрастанию `film_id`). Неизменённые
 * ссылки и ссылки при отсутствии миграции 202 возвращаются как есть.
 */
export async function resolveFilmReferencesForWrite(
  tx: TransactionClient,
  orderId: number | null,
  input: FilmReferenceWriteInput,
): Promise<FilmReferenceResolution> {
  const unchanged: FilmReferenceResolution = {
    headerFilmId: input.headerFilmId,
    detailFilmIds: input.details.map((detail) => detail.filmId),
    replacements: [],
  };
  const stored = orderId === null
    ? null
    : await loadStored(tx, orderId, input.details.flatMap((detail) => (detail.detailId === null ? [] : [detail.detailId])));
  const changed = collectChangedFilmIds(input, stored);
  if (changed.length === 0) return unchanged;
  if (!(await hasCanonicalColumn(tx))) return unchanged;

  // Чтение без блокировки только чтобы узнать каноны; решение — по состоянию под блокировкой.
  const preview = await readFilms(tx, changed, false);
  const toLock = filmIdsToLock(changed, preview);
  const locked = await readFilms(tx, toLock, true);
  const lockedIds = new Set(locked.map((row) => row.filmId));
  const canonicalsCovered = locked.every((row) => row.canonicalFilmId === null || lockedIds.has(row.canonicalFilmId));
  // Канон сменился между чтением и блокировкой. Повтор в этой же транзакции держал бы
  // уже взятые блокировки и брал новые не по возрастанию film_id (deadlock с откатом
  // каталога), поэтому команда отклоняется целиком — клиент повторяет её заново.
  if (!canonicalsCovered) {
    throw new ApiError(409, 'FILM_REFERENCE_CONFLICT', 'Справочник плёнок изменён параллельной операцией, повторите');
  }
  const { resolution, problems } = resolveFilmReferences(input, stored, locked);
  if (problems.length > 0) {
    const inactive = problems.filter((problem) => problem.reason === 'inactive').map((problem) => problem.filmId);
    const missing = problems.filter((problem) => problem.reason === 'not_found').map((problem) => problem.filmId);
    throw new ApiError(
      422,
      inactive.length > 0 ? 'FILM_INACTIVE' : 'FILM_NOT_FOUND',
      inactive.length > 0
        ? 'Выбранная плёнка неактивна — выберите плёнку заново'
        : 'Выбранная плёнка не найдена',
      { inactiveFilmIds: inactive, missingFilmIds: missing },
    );
  }
  return resolution;
}
