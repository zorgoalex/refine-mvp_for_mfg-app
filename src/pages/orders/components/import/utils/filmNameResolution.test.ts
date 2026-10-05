import { describe, expect, it } from 'vitest';
import { filmNameIndexState, resolveFilmName } from './filmNameResolution';

const canonical = [{ id: 42, name: 'Дуб Тансберг Натуральный; Алимжан AIF' }];

describe('resolveFilmName', () => {
  it('resolves a previous film name to active canonical film', () => {
    const result = resolveFilmName('Дуб Тансберг натуральный -АЙФ', canonical, [{
      name: 'Дуб Тансберг натуральный -АЙФ', filmId: 13, canonicalFilmId: 42,
      vendorId: 7, active: false, source: 'history',
    }]);
    expect(result).toEqual({ status: 'matched', filmId: 42, source: 'history' });
  });

  it('normalizes ё and repeated whitespace for current active exact names', () => {
    expect(resolveFilmName('Ель  Белая', [{ id: 9, name: 'Ёль Белая' }], [])).toEqual({
      status: 'matched', filmId: 9, source: 'current',
    });
  });

  it('leaves multiple canonical matches for manual selection', () => {
    const result = resolveFilmName('Старое имя', [
      { id: 42, name: 'Канон A' }, { id: 84, name: 'Канон B' },
    ], [
      { name: 'Старое имя', filmId: 13, canonicalFilmId: 42, vendorId: 1, active: false, source: 'history' },
      { name: 'Старое имя', filmId: 14, canonicalFilmId: 84, vendorId: 2, active: false, source: 'history' },
    ]);
    expect(result).toEqual({ status: 'ambiguous', filmIds: [42, 84] });
  });

  it('asks the user when a current name of one film equals a previous name of another', () => {
    // Плёнка 42 переименована из «Орех» в «Орех Милано»; плёнка 77 сейчас называется «Орех».
    const result = resolveFilmName('Орех', [
      { id: 42, name: 'Орех Милано; Гульсум' }, { id: 77, name: 'Орех' },
    ], [
      { name: 'Орех', filmId: 42, canonicalFilmId: null, vendorId: 1, active: true, source: 'history' },
      { name: 'Орех', filmId: 77, canonicalFilmId: null, vendorId: 2, active: true, source: 'current' },
    ]);
    expect(result).toEqual({ status: 'ambiguous', filmIds: [77, 42] });
  });

  it('keeps a single match when the current and previous names point to the same canonical film', () => {
    const result = resolveFilmName('Белый глянец', [{ id: 5, name: 'Белый глянец' }], [
      { name: 'Белый глянец', filmId: 5, canonicalFilmId: null, vendorId: 1, active: true, source: 'current' },
      { name: 'Белый  глянец', filmId: 6, canonicalFilmId: 5, vendorId: 1, active: false, source: 'current' },
    ]);
    expect(result).toEqual({ status: 'matched', filmId: 5, source: 'current' });
  });
});

describe('resolveFilmName with a page-limited film lookup (code review R5-1)', () => {
  it('sees an active canonical film from the full index even when the lookup page does not contain it', () => {
    // 42 переименована из «Орех»; в справочнике модалки (первая страница) есть только 77 «Орех».
    const result = resolveFilmName('Орех', [{ id: 77, name: 'Орех' }], [
      { name: 'Орех Милано; Гульсум', filmId: 42, canonicalFilmId: 42, vendorId: 1, active: true, source: 'current' },
      { name: 'Орех', filmId: 42, canonicalFilmId: 42, vendorId: 1, active: true, source: 'history' },
      { name: 'Орех', filmId: 77, canonicalFilmId: 77, vendorId: 2, active: true, source: 'current' },
    ]);
    expect(result).toEqual({ status: 'ambiguous', filmIds: [77, 42] });
  });

  it('does not treat inactive duplicates or inactive films from the index as active canonicals', () => {
    const result = resolveFilmName('Старое', [], [
      { name: 'Старое', filmId: 13, canonicalFilmId: 13, vendorId: 1, active: false, source: 'history' },
      { name: 'Дубль', filmId: 14, canonicalFilmId: 99, vendorId: 1, active: false, source: 'current' },
      { name: 'Старое', filmId: 14, canonicalFilmId: 99, vendorId: 1, active: false, source: 'history' },
    ]);
    expect(result).toEqual({ status: 'unmatched' });
  });
});

describe('filmNameIndexState', () => {
  const items = [{ name: 'Орех', filmId: 1, canonicalFilmId: 1, vendorId: null, active: true, source: 'current' as const }];

  it('is ready only for a complete successful response', () => {
    expect(filmNameIndexState({ isSuccess: true, isError: false, data: { items, truncated: false } }))
      .toEqual({ items, status: 'ready' });
  });

  it('treats a truncated index and a failed request as unavailable', () => {
    expect(filmNameIndexState({ isSuccess: true, isError: false, data: { items, truncated: true } }))
      .toEqual({ items: [], status: 'unavailable' });
    expect(filmNameIndexState({ isSuccess: false, isError: true })).toEqual({ items: [], status: 'unavailable' });
  });

  it('is loading until the request settles', () => {
    expect(filmNameIndexState({ isSuccess: false, isError: false })).toEqual({ items: [], status: 'loading' });
  });
});
