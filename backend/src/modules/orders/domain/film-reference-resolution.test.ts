import { describe, expect, it } from 'vitest';
import {
  collectChangedFilmIds,
  filmIdsToLock,
  resolveFilmReferences,
  type FilmRow,
  type StoredFilmReferences,
} from './film-reference-resolution';

const stored = (header: number | null, details: Array<[number, number | null]>): StoredFilmReferences => ({
  headerFilmId: header,
  detailFilmIds: new Map(details),
});

const rows: FilmRow[] = [
  { filmId: 10, canonicalFilmId: null, isActive: true },   // канон
  { filmId: 11, canonicalFilmId: 10, isActive: false },    // дубль канона 10
  { filmId: 20, canonicalFilmId: null, isActive: false },  // неактивный канон (после отката)
  { filmId: 21, canonicalFilmId: 20, isActive: false },    // дубль неактивного канона
  { filmId: 30, canonicalFilmId: null, isActive: true },
];

describe('collectChangedFilmIds', () => {
  it('treats every reference of a new order as changed', () => {
    expect(collectChangedFilmIds({ headerFilmId: 11, details: [{ detailId: null, filmId: 30 }, { detailId: null, filmId: 11 }] }, null))
      .toEqual([11, 30]);
  });

  it('skips unchanged historical references and nulls', () => {
    const input = { headerFilmId: 11, details: [{ detailId: 1, filmId: 21 }, { detailId: 2, filmId: 30 }, { detailId: 3, filmId: null }] };
    expect(collectChangedFilmIds(input, stored(11, [[1, 21], [2, 10], [3, 10]]))).toEqual([30]);
  });

  it('treats a detail id unknown to the order as new', () => {
    expect(collectChangedFilmIds({ headerFilmId: null, details: [{ detailId: 99, filmId: 11 }] }, stored(null, []))).toEqual([11]);
  });
});

describe('filmIdsToLock', () => {
  it('adds current canonicals and sorts ascending', () => {
    expect(filmIdsToLock([30, 11], rows.filter((row) => [11, 30].includes(row.filmId)))).toEqual([10, 11, 30]);
  });
});

describe('resolveFilmReferences', () => {
  it('replaces newly chosen duplicates with their canonical', () => {
    const { resolution, problems } = resolveFilmReferences(
      { headerFilmId: 11, details: [{ detailId: null, filmId: 11 }, { detailId: null, filmId: 30 }] },
      null,
      rows,
    );
    expect(problems).toEqual([]);
    expect(resolution).toEqual({ headerFilmId: 10, detailFilmIds: [10, 30], replacements: [{ from: 11, to: 10 }] });
  });

  it('keeps an unchanged historical reference to a duplicate or inactive film', () => {
    const { resolution, problems } = resolveFilmReferences(
      { headerFilmId: 21, details: [{ detailId: 1, filmId: 11 }, { detailId: 2, filmId: 20 }] },
      stored(21, [[1, 11], [2, 20]]),
      rows,
    );
    expect(problems).toEqual([]);
    expect(resolution.detailFilmIds).toEqual([11, 20]);
    expect(resolution.headerFilmId).toBe(21);
    expect(resolution.replacements).toEqual([]);
  });

  it('rejects a new choice that resolves to an inactive record (stale form after revert)', () => {
    const { problems } = resolveFilmReferences({ headerFilmId: null, details: [{ detailId: 5, filmId: 21 }] }, stored(null, [[5, 30]]), rows);
    expect(problems).toEqual([{ filmId: 21, reason: 'inactive' }]);
    const direct = resolveFilmReferences({ headerFilmId: null, details: [{ detailId: null, filmId: 20 }] }, null, rows);
    expect(direct.problems).toEqual([{ filmId: 20, reason: 'inactive' }]);
  });

  it('reports films that are not found', () => {
    const { problems } = resolveFilmReferences({ headerFilmId: 404, details: [] }, null, rows);
    expect(problems).toEqual([{ filmId: 404, reason: 'not_found' }]);
  });
});
