import { describe, expect, it } from 'vitest';
import { analyzeFilmName, classifyCandidates } from '../../films/domain/film-name-normalizer';
import { aliasKey, matchStockRow, prepareCandidates, relatedCandidates, type StockFilmCandidate } from './stock-import-matching';

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
  placeholderVendorIds: new Set<number>(),
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

  it('keeps suppliers apart for exact matches but still suggests other suppliers last', () => {
    const result = matchStockRow({ name: 'Брауни', supplier: 'Кира' }, context());
    expect(result.matchStatus).toBe('suggested');
    expect(result.suggestions.map((s) => s.filmId)).toEqual([1]);
  });

  it('returns unmatched when nothing is similar', () => {
    expect(matchStockRow({ name: 'Шымбулак', supplier: 'Кира' }, context())).toEqual({ matchStatus: 'unmatched', filmId: null, suggestions: [] });
  });
});

describe('matchStockRow — supplier written in the film name (dictionary before the 1C catalog import)', () => {
  // До импорта каталога почти все плёнки заведены на «нд», поставщик — в названии.
  const ND = 5;
  const AIF = 7;
  const ALER = 15;
  const dirty: StockFilmCandidate[] = [
    { canonicalFilmId: 4999, canonicalName: 'Дуб Тансберг натуральный -АЙФ', vendorId: ND, matchName: 'Дуб Тансберг натуральный -АЙФ' },
    { canonicalFilmId: 2593, canonicalName: 'айвори алер', vendorId: ND, matchName: 'айвори алер' },
    { canonicalFilmId: 4897, canonicalName: 'Айвори софт AL17-Алер', vendorId: ND, matchName: 'Айвори софт AL17-Алер' },
    { canonicalFilmId: 1996, canonicalName: 'айвори гульсум', vendorId: ND, matchName: 'айвори гульсум' },
    { canonicalFilmId: 3001, canonicalName: 'белый мат алер', vendorId: ND, matchName: 'белый мат алер' },
    { canonicalFilmId: 3002, canonicalName: 'белый глянец алер', vendorId: ND, matchName: 'белый глянец алер' },
    { canonicalFilmId: 7001, canonicalName: 'Шампань Аиф', vendorId: AIF, matchName: 'Шампань Аиф' },
  ];
  // «АИФ» и «Алер» есть в справочнике поставщиков, но их плёнки почти все на «нд».
  const byName: Record<string, number> = { аиф: AIF, алер: ALER };
  const dirtyContext = {
    aliases: new Map<string, number>(),
    vendorIdForSupplier: (supplier: string) => byName[supplier.trim().toLowerCase()] ?? null,
    placeholderVendorIds: new Set([ND]),
    prepared: prepareCandidates(dirty),
  };

  it('matches exactly when the supplier is only in the film name', () => {
    expect(matchStockRow({ name: 'Дуб тансберг натуральный', supplier: 'АИФ' }, dirtyContext))
      .toEqual({ matchStatus: 'exact', filmId: 4999, suggestions: [] });
    expect(matchStockRow({ name: 'Айвори', supplier: 'Алер' }, dirtyContext)).toMatchObject({ matchStatus: 'exact', filmId: 2593 });
  });

  it('suggests close variants of the same supplier first, then others', () => {
    const result = matchStockRow({ name: 'Айвори нубук', supplier: 'Алер' }, dirtyContext);
    expect(result.matchStatus).toBe('suggested');
    const ids = result.suggestions.map((s) => s.filmId);
    expect(ids.slice(0, 2).sort()).toEqual([2593, 4897]);
    expect(ids).toContain(1996);
    expect(ids.indexOf(1996)).toBeGreaterThan(1);
  });

  it('treats word forms as the same name («Белая мат» → «белый мат алер»)', () => {
    expect(matchStockRow({ name: 'Белая мат', supplier: 'Алер' }, dirtyContext)).toMatchObject({ matchStatus: 'exact', filmId: 3001 });
  });

  it('offers partial matches instead of nothing («Белый зефир» → белые плёнки Алер)', () => {
    const result = matchStockRow({ name: 'Белый зефир', supplier: 'Алер' }, dirtyContext);
    expect(result.matchStatus).toBe('suggested');
    expect(result.suggestions.map((s) => s.filmId).sort()).toEqual([3001, 3002]);
    expect(result.suggestions.length).toBeLessThanOrEqual(5);
  });

  it('does not let a supplier written in the name override a real vendor (review: vendor conflict)', () => {
    // «айвори алер» заведена на реального поставщика Аиф — для строки «Айвори / Алер» это не exact.
    const conflicting = {
      ...dirtyContext,
      prepared: prepareCandidates([
        { canonicalFilmId: 8001, canonicalName: 'айвори алер', vendorId: AIF, matchName: 'айвори алер' },
        { canonicalFilmId: 8002, canonicalName: 'Шампань; Аиф', vendorId: AIF, matchName: 'айвори алер' },
      ]),
    };
    const result = matchStockRow({ name: 'Айвори', supplier: 'Алер' }, conflicting);
    expect(result.matchStatus).toBe('suggested');
    expect(result.suggestions.map((s) => s.filmId)).toContain(8001);
  });

  it('refuses exact when the name and the supplier column name different suppliers', () => {
    const result = matchStockRow({ name: 'Айвори Аиф', supplier: 'Алер' }, dirtyContext);
    expect(result.matchStatus).toBe('suggested');
    expect(result.suggestions[0].filmId).toBe(2593);
  });

  it('keeps name keys independent of the supplier text (review: «EMC (Euro Market)»)', () => {
    const EMC = 12;
    const emc = {
      aliases: new Map<string, number>(),
      vendorIdForSupplier: (supplier: string) => (supplier.includes('EMC') ? EMC : null),
      placeholderVendorIds: new Set([ND]),
      prepared: prepareCandidates([{ canonicalFilmId: 9001, canonicalName: 'Айвори', vendorId: EMC, matchName: 'Айвори' }]),
    };
    expect(matchStockRow({ name: 'Айвори', supplier: 'EMC (Euro Market)' }, emc)).toMatchObject({ matchStatus: 'exact', filmId: 9001 });
  });
});

describe('candidate index is lossless', () => {
  it('ranks exactly like the full scan on varied names (typos, prefixes, codes, short words)', () => {
    const names = [
      'Айвори софт AL17-Алер', 'айвори алер', 'Айворинубук', 'Дуб Тансберг натуральный -АЙФ', 'Дуб тансбрг натур',
      'Брауни DW085-6T; ADILET', 'DW085', 'Чага SM-06', 'Санд сноу CRM 100-SD-L_0.18*1400', 'бел мат', 'Белый глянец',
      'Орех Милано', 'Орех миланоо', 'Графит', 'Графитовый', 'ZB852-2 айвори', '852', 'Кашемир серый', 'Кашимир',
      'Сосна', 'Сосна Лоредо', 'Лоредо', 'Тёмный лён', 'Лён', 'Акация', 'Акаиця',
    ];
    const prepared = prepareCandidates(names.map((name, i) => ({ canonicalFilmId: i + 1, canonicalName: name, vendorId: null, matchName: name })));
    const queries = ['айвори', 'Айвори нубук', 'Дуб тансберг', 'DW085-6T', 'dw85', 'Чага', 'Санд сноу', 'белая мат', 'Орех милано',
      'графит', 'ZB852', 'Кашемир', 'сосна лоредо', 'Темный лен', 'акация', 'Шымбулак', '852-2', 'лен', 'бел'];
    for (const query of queries) {
      const analysis = analyzeFilmName(query);
      const full = classifyCandidates(analysis, prepared.map((c) => ({ id: c.canonicalFilmId, analysis: c.analysis })), { autoScore: 0.95, autoMargin: 0.15, suggestScore: 0.5, maxSuggestions: 1000 }).ranked;
      const fast = classifyCandidates(analysis, relatedCandidates(analysis, prepared).map((c) => ({ id: c.canonicalFilmId, analysis: c.analysis })), { autoScore: 0.95, autoMargin: 0.15, suggestScore: 0.5, maxSuggestions: 1000 }).ranked;
      expect(fast, query).toEqual(full);
    }
  });
});

describe('matchStockRow — supplier identity through vendor aliases (review R2)', () => {
  const ALER = 15;
  const AIF = 7;
  // Подтверждённый алиас колонки «Поставщик Север» → Алер; словарь: «аиф» → Аиф, «алер» → Алер.
  const resolver = (supplier: string) => ({ 'поставщик север': ALER, аиф: AIF, алер: ALER } as Record<string, number>)[supplier.trim().toLowerCase()] ?? null;
  const ctx = {
    aliases: new Map<string, number>(),
    vendorIdForSupplier: resolver,
    placeholderVendorIds: new Set<number>(),
    prepared: prepareCandidates([{ canonicalFilmId: 501, canonicalName: 'Айвори', vendorId: ALER, matchName: 'Айвори' }]),
  };

  it('refuses exact when an alias-resolved column vendor differs from the vendor in the name', () => {
    const result = matchStockRow({ name: 'Айвори Аиф', supplier: 'Поставщик Север' }, ctx);
    expect(result.matchStatus).toBe('suggested');
    expect(result.suggestions[0].filmId).toBe(501);
  });

  it('allows exact when the alias-resolved column vendor and the vendor in the name are the same ERP vendor', () => {
    expect(matchStockRow({ name: 'Айвори алер', supplier: 'Поставщик Север' }, ctx)).toMatchObject({ matchStatus: 'exact', filmId: 501 });
  });

  it('treats an unresolvable vendor in the name next to a supplier column as a conflict', () => {
    expect(matchStockRow({ name: 'Айвори гульсум', supplier: 'Поставщик Север' }, ctx).matchStatus).toBe('suggested');
  });
});
