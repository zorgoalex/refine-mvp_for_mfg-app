import { describe, expect, it } from 'vitest';
import {
  applyPatchActions,
  assignCanonicals,
  blockers,
  buildMatches,
  canAccessSourceKind,
  filmFingerprint,
  type FilmCandidate,
  type ImportRow,
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
