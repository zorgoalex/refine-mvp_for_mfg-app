import { describe, expect, it } from 'vitest';
import { aliasKey, matchStockRow, prepareCandidates, type StockFilmCandidate } from './stock-import-matching';

const ADILET = 16;
const KIRA = 6;
const candidates: StockFilmCandidate[] = [
  { canonicalFilmId: 1, canonicalName: 'Брауни DW085-6T; ADILET', vendorId: ADILET, matchName: 'Брауни DW085-6T; ADILET' },
  { canonicalFilmId: 1, canonicalName: 'Брауни DW085-6T; ADILET', vendorId: ADILET, matchName: 'Брауни' },
  { canonicalFilmId: 2, canonicalName: 'Чага SM-06; ADILET', vendorId: ADILET, matchName: 'Чага SM-06; ADILET' },
  { canonicalFilmId: 3, canonicalName: 'Крем-брюле мат. JS 9052-28; kira', vendorId: KIRA, matchName: 'Крем-брюле мат. JS 9052-28; kira' },
  { canonicalFilmId: 4, canonicalName: 'Санд сноу CRM 100-SD-L_0.18*1400; Евразия Декор', vendorId: 10, matchName: 'Санд сноу CRM 100-SD-L_0.18*1400; Евразия Декор' },
  { canonicalFilmId: 5, canonicalName: 'Санд сноу CRM 100-SD-L_0.35*1400; Евразия Декор', vendorId: 10, matchName: 'Санд сноу CRM 100-SD-L_0.35*1400; Евразия Декор' },
];
const vendors: Record<string, number> = { адилет: ADILET, кира: KIRA, 'евразия декор': 10 };
const context = (aliases: Array<[string, number]> = []) => ({
  aliases: new Map(aliases),
  vendorIdForSupplier: (supplier: string) => vendors[supplier.trim().toLowerCase()] ?? null,
  prepared: prepareCandidates(candidates),
});

describe('matchStockRow', () => {
  it('uses a confirmed alias first', () => {
    expect(matchStockRow({ name: 'Брачино', supplier: 'Адилет ' }, context([[aliasKey('брачино', 'адилет'), 2]])))
      .toEqual({ matchStatus: 'alias', filmId: 2, suggestions: [] });
  });

  it('matches exactly by a previous name of the canonical film', () => {
    expect(matchStockRow({ name: 'Брауни', supplier: 'Адилет' }, context())).toMatchObject({ matchStatus: 'exact', filmId: 1 });
  });

  it('only suggests fuzzy matches', () => {
    const result = matchStockRow({ name: 'Чага', supplier: 'Адилет' }, context());
    expect(result.matchStatus).toBe('suggested');
    expect(result.suggestions[0].filmId).toBe(2);
  });

  it('never picks a thickness variant as exact', () => {
    const result = matchStockRow({ name: 'Санд сноу', supplier: 'Евразия декор' }, context());
    expect(result.matchStatus).toBe('suggested');
    expect(result.suggestions.map((s) => s.filmId).sort()).toEqual([4, 5]);
  });

  it('keeps suppliers apart', () => {
    const result = matchStockRow({ name: 'Брауни', supplier: 'Кира' }, context());
    expect(result.matchStatus).not.toBe('exact');
    expect(result.suggestions.every((s) => s.filmId !== 1)).toBe(true);
  });

  it('returns unmatched when nothing is similar', () => {
    expect(matchStockRow({ name: 'Шымбулак', supplier: 'Кира' }, context())).toEqual({ matchStatus: 'unmatched', filmId: null, suggestions: [] });
  });
});
