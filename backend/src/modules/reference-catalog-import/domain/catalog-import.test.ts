import { describe, expect, it } from 'vitest';
import {
  noteWithPreviousName,
  FILM_NOTE_MAX,
  applyPatchActions,
  assignCanonicals,
  blockers,
  buildMatches,
  canAccessSourceKind,
  filmFingerprint,
  type FilmCandidate,
  type ImportRow,
  vendorMatchMap,
  refreshMatches,
  isRejectedByUser,
} from './catalog-import';

const film = (
  filmId: number,
  details: number,
  overrides: Partial<FilmCandidate> = {}
): FilmCandidate => ({
  filmId,
  filmName: 'Белый снег; Аиф',
  vendorId: 1,
  vendorName: 'Аиф',
  isActive: true,
  canonicalFilmId: null,
  filmTexture: false,
  filmTypeId: 1,
  filmTypeName: 'Плёнка',
  sortOrder: 100,
  catalogKey: null,
  refKey1c: null,
  details,
  lastUsedAt: null,
  previousNames: [],
  nomenclatureType: null,
  nomenclatureCategory: null,
  ...overrides,
});
const row = (rowId: number, overrides: Partial<ImportRow> = {}): ImportRow => ({
  rowId,
  rowNo: rowId,
  nameOriginal: 'Белый снег',
  nameFull: 'Белый снег; Аиф',
  supplier: 'Аиф',
  nomenclatureType: null,
  unit: 'пог. м',
  nomenclatureCategory: 'ПЛЕНКА ПВХ ДЛЯ МДФ',
  targetName: 'Белый снег; Аиф',
  catalogKey: 'белый снег; аиф',
  rowStatus: 'ok',
  issue: null,
  vendorId: 1,
  refKey1c: null,
  canonicalFilmId: null,
  canonicalFilmTexture: null,
  canonicalFilmTypeId: null,
  propertyConflict: null,
  ...overrides,
});

describe('film catalog matching domain', () => {
  it('normalizes PostgreSQL bigint strings and preserves null, booleans, and strings', () => {
    const base = {
      film_name: 'name', vendor_id: '12', film_type_id: '3', film_texture: false,
      is_active: true, sort_order: '100', canonical_film_id: '77', catalog_key: null,
      ref_key_1c: null, nomenclature_type: 'film', nomenclature_category: null,
    };
    expect(filmFingerprint(base)).toBe(filmFingerprint({
      ...base, vendor_id: 12, film_type_id: 3, sort_order: 100, canonical_film_id: 77,
    }));
    expect(filmFingerprint({ ...base, canonical_film_id: null })).not.toBe(
      filmFingerprint(base)
    );
  });
  it('hides mirror batches unless onec.view is present', () => {
    expect(canAccessSourceKind('file', ['references.manage'])).toBe(true);
    expect(canAccessSourceKind('onec_mirror', ['references.manage'])).toBe(
      false
    );
    expect(
      canAccessSourceKind('onec_mirror', ['references.manage', 'onec.view'])
    ).toBe(true);
  });
  it('links by catalog key and selects most used candidate as canonical', () => {
    const rows = [row(1, { catalogKey: 'белый снег; аиф' })];
    const films = [film(10, 3, { catalogKey: 'белый снег; аиф' }), film(11, 8)];
    const matches = buildMatches(rows, films, new Map([['аиф', 1]]));
    expect(matches.find((m) => m.filmId === 10)?.matchStatus).toBe('linked');
    expect(matches.find((m) => m.filmId === 11)?.rowId).toBe(1);
    assignCanonicals(rows, matches, films);
    expect(rows[0]?.canonicalFilmId).toBe(10);
  });
  it('marks texture and type disagreements as a property conflict', () => {
    const rows = [row(1)];
    const films = [
      film(10, 2, { filmTexture: false, filmTypeId: 1 }),
      film(11, 1, { filmTexture: true, filmTypeId: 2 }),
    ];
    const matches = films.map((f) => ({
      filmId: f.filmId,
      rowId: 1,
      matchStatus: 'manual' as const,
      score: 1,
      candidates: [],
      fingerprint: 'a'.repeat(64),
    }));
    assignCanonicals(rows, matches, films);
    expect(rows[0]?.propertyConflict).toEqual({
      filmTexture: [false, true],
      filmTypeIds: [1, 2],
    });
    expect(blockers(rows, matches, [], true)).toContain(
      'Не разрешены конфликты свойств'
    );
  });
  it('blocks suggested matches and unresolved suppliers', () => {
    expect(
      blockers(
        [row(1)],
        [
          {
            filmId: 1,
            rowId: null,
            matchStatus: 'suggested',
            score: 0.7,
            candidates: [],
            fingerprint: 'a'.repeat(64),
          },
        ],
        [{ supplierNorm: 'x', vendorId: null, createVendor: false }],
        true
      )
    ).toEqual([
      'Есть неподтверждённые предположения',
      'Не сопоставлены поставщики',
    ]);
  });
  it('rejects patch actions pointing outside batch', () => {
    const rows = [row(1)],
      films = [film(10, 0)],
      matches = [
        {
          filmId: 10,
          rowId: null,
          matchStatus: 'none' as const,
          score: null,
          candidates: [],
          fingerprint: 'a'.repeat(64),
        },
      ];
    expect(() =>
      applyPatchActions(
        rows,
        matches,
        films,
        [],
        [{ type: 'setMatch', filmId: 10, rowId: 99 }],
        { createMissing: true }
      )
    ).toThrow('FOREIGN_ROW');
  });
  it('accepts auto matches and assigns explicit canonical properties', () => {
    const rows = [row(1)],
      films = [film(10, 0)],
      matches = [
        {
          filmId: 10,
          rowId: 1,
          matchStatus: 'auto' as const,
          score: 1,
          candidates: [],
          fingerprint: 'a'.repeat(64),
        },
      ];
    applyPatchActions(
      rows,
      matches,
      films,
      [],
      [
        { type: 'acceptAllAuto' },
        {
          type: 'setCanonicalProperties',
          rowId: 1,
          filmTexture: true,
          filmTypeId: 2,
        },
      ],
      { createMissing: true }
    );
    expect(matches[0]?.matchStatus).toBe('confirmed');
    expect(rows[0]?.canonicalFilmTexture).toBe(true);
  });
  it('confirms the best suggested row and preserves explicit match changes on refresh', async () => {
    const rows = [row(1), row(2, { targetName: 'Белый снег матовый; Аиф' })];
    const films = [film(10, 0)];
    const suggested = {
      filmId: 10,
      rowId: null,
      matchStatus: 'suggested' as const,
      score: 0.8,
      candidates: [
        { rowId: 2, targetName: rows[1]!.targetName, score: 0.8, dimensionConflict: false },
        { rowId: 1, targetName: rows[0]!.targetName, score: 0.8, dimensionConflict: false },
      ],
      fingerprint: 'a'.repeat(64),
    };
    const matches = [suggested];
    applyPatchActions(
      rows,
      matches,
      films,
      [],
      [{ type: 'confirmMatch', filmId: 10 }],
      { createMissing: true }
    );
    expect(matches[0]).toMatchObject({ rowId: 1, matchStatus: 'confirmed' });
  });
});

describe('film note after a catalog rename', () => {
  it('adds the previous name, keeps user text, and does not repeat the same line', () => {
    expect(noteWithPreviousName(null, 'айвори алер')).toBe('Прежнее название: айвори алер');
    expect(noteWithPreviousName('  ', 'айвори алер')).toBe('Прежнее название: айвори алер');
    expect(noteWithPreviousName('Заказывать у Алер', 'айвори алер')).toBe('Заказывать у Алер\nПрежнее название: айвори алер');
    const once = noteWithPreviousName('Заказывать у Алер', 'айвори алер');
    expect(noteWithPreviousName(once, 'айвори алер')).toBe(once);
    expect(noteWithPreviousName(once, 'Айвори Алер')).toBe(`${once}\nПрежнее название: Айвори Алер`);
  });

  it('never exceeds the limit and never cuts the user text', () => {
    const long = 'x'.repeat(FILM_NOTE_MAX - 30);
    const result = noteWithPreviousName(long, 'очень длинное прежнее название плёнки '.repeat(3))!;
    expect(result.length).toBeLessThanOrEqual(FILM_NOTE_MAX);
    expect(result.startsWith(long)).toBe(true);
    const full = 'y'.repeat(FILM_NOTE_MAX - 5);
    expect(noteWithPreviousName(full, 'старое')).toBe(full);
  });
});

describe('vendorMatchMap', () => {
  it('maps the catalog supplier and the ERP vendor name (film-name vendor key) to the vendor; skips unresolved', () => {
    const map = vendorMatchMap([
      { supplierNorm: 'decor 777', vendorId: 14, vendorName: 'Decor777' },
      { supplierNorm: 'новый', vendorId: null, vendorName: null },
      { supplierNorm: 'алер', vendorId: 15, vendorName: undefined },
    ]);
    expect([...map.entries()]).toEqual([['decor 777', 14], ['decor777', 14], ['алер', 15]]);
  });
});

describe('refreshMatches keeps user decisions', () => {
  const rows = [row(1, { targetName: 'Белый снег; Аиф', catalogKey: 'k1' }), row(2, { targetName: 'Серый туман; Аиф', catalogKey: 'k2', nameOriginal: 'Серый туман', nameFull: 'Серый туман; Аиф' })];
  const films = [film(10, 1, { filmName: 'Белый снег Аиф' }), film(11, 1, { filmName: 'Совсем другое название Аиф' })];

  it('buildMatches never returns «none» with candidates (so candidates mark a user rejection)', () => {
    for (const match of buildMatches(rows, films, new Map([['аиф', 1]]))) {
      if (match.matchStatus === 'none') expect(match.candidates).toEqual([]);
      expect(isRejectedByUser(match)).toBe(false);
    }
  });

  it('a user «no pair» over a suggestion survives a recalculation; an algorithmic «none» is recalculated', () => {
    const built = buildMatches(rows, films, new Map([['аиф', 1]]));
    const target = built.find((match) => match.filmId === 10)!;
    expect(target.candidates.length).toBeGreaterThan(0);
    const rejected = { ...target, rowId: null, matchStatus: 'none' as const };
    const algorithmicNone = { ...built.find((match) => match.filmId === 11)!, matchStatus: 'none' as const, rowId: null, candidates: [] };
    const refreshed = refreshMatches(rows, films, new Map([['аиф', 1]]), [rejected, algorithmicNone], new Set());
    expect(refreshed.find((match) => match.filmId === 10)).toEqual(rejected);
    expect(refreshed.find((match) => match.filmId === 11)).toEqual(built.find((match) => match.filmId === 11));
  });
});
