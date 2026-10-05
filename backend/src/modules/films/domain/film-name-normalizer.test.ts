import { describe, expect, it } from 'vitest';
import {
  analyzeFilmName,
  classifyCandidates,
  levenshteinWithin,
  normalizeFilmText,
  scoreCandidate,
} from './film-name-normalizer';

const catalog = (names: string[]) => names.map((name, id) => ({ id, analysis: analyzeFilmName(name) }));

describe('normalizeFilmText', () => {
  it('lowercases, folds ё and replaces latin look-alikes inside cyrillic words', () => {
    expect(normalizeFilmText('Белый Sоft')).toBe('белый soft');
    expect(normalizeFilmText('Мoлочный  Ёж')).toBe('молочный еж');
    expect(normalizeFilmText('Кварц – грей')).toBe('кварц - грей');
  });
});

describe('analyzeFilmName', () => {
  it('extracts vendor tokens from legacy ERP names', () => {
    expect(analyzeFilmName('Дуб Тансберг натуральный -АЙФ').vendorKey).toBe('Аиф');
    expect(analyzeFilmName('софт грей АИФ').vendorKey).toBe('Аиф');
    expect(analyzeFilmName('голубой пар алимжан').vendorKey).toBe('Аиф');
    expect(analyzeFilmName('Алатау матовая KZ03-Кира').vendorKey).toBe('Kira');
    expect(analyzeFilmName('Серая галька FRS 1810-2-L - Евразия Декор').vendorKey).toBe('Евразия Декор');
    expect(analyzeFilmName('лайт хаки frs845-2-l ед').vendorKey).toBe('Евразия Декор');
    expect(analyzeFilmName('темный изумруд софт fd3098 декор777').vendorKey).toBe('Decor777');
    expect(analyzeFilmName('Белый матовый -Декор+').vendorKey).toBe('Decor+');
    expect(analyzeFilmName('Белый снег  Декор 779').vendorKey).toBe('Decor777');
    expect(analyzeFilmName('белый мат декор').vendorKey).toBe('Decor+');
    expect(analyzeFilmName('Сиена лен - МС Групп').vendorKey).toBe('МС груп');
    expect(analyzeFilmName('айвори алия').vendorKey).toBe('@Алия');
    expect(analyzeFilmName('Брауни').vendorKey).toBeNull();
  });

  it('joins latin code prefixes with numbers and separates glued code+word', () => {
    expect(analyzeFilmName('Батыс KZ 18').codes).toContain('kz18');
    expect(analyzeFilmName('батыс kz18 кира').codes).toContain('kz18');
    expect(analyzeFilmName('AL-11  Небесно-синий').codes).toContain('al11');
    expect(analyzeFilmName('Небесно синий софт AL11-Алер').codes).toContain('al11');
    expect(analyzeFilmName('Крем-брюле мат. JS 9052-28').codes).toContain('js9052-28');
    const glued = analyzeFilmName('4997Космея 028-Декор777');
    expect(glued.codes).toContain('4997');
    expect(glued.words).toContain('космея');
    expect(analyzeFilmName('113/3  Дуб вотан').codes).toContain('113/3');
  });

  it('moves thickness and sizes out of words into dimensions', () => {
    const a = analyzeFilmName('Дуб патина грэй ARC 722-2-L_0.25*1400, пог. м');
    expect(a.dimensions).toEqual(['0.25', '1400']);
    expect(a.words).toEqual(expect.arrayContaining(['дуб', 'патина', 'грэй']));
    expect(analyzeFilmName('Шторм софт RM (0,26) пленка 439-S1PR').dimensions).toEqual(['0.26']);
    expect(analyzeFilmName('5184 Ясень белый 0,25').dimensions).toEqual(['0.25']);
    expect(analyzeFilmName('Васильковский глянец 0,31').dimensions).toEqual(['0.31']);
  });

  it('folds texture synonyms, adjective endings and catalog prefixes', () => {
    expect(analyzeFilmName('Белая матовая').looseKey).toBe(analyzeFilmName('белый мат').looseKey);
    expect(analyzeFilmName('Белый Sоft').words).toEqual(['бел', 'софт']);
    expect(analyzeFilmName('Плёнка мат. Ваниль BS 2582G-03').words).toEqual(['мат', 'ваниль']);
    expect(analyzeFilmName('Плёнка мат. Ваниль BS 2582G-03').codes).toEqual(['bs2582g-03']);
    expect(analyzeFilmName('ваниль bs2582g-03мат кира').codes).toContain('bs2582g-03');
    expect(analyzeFilmName('Плёнка глянц. Кофе с молоком DM501-6T').words).toContain('глянец');
  });

  it('strict key keeps dimensions, loose key drops them', () => {
    const thin = analyzeFilmName('Санд сноу CRM 100-SD-L_0.18*1400');
    const thick = analyzeFilmName('Санд сноу CRM 100-SD-L_0.35*1400');
    expect(thin.looseKey).toBe(thick.looseKey);
    expect(thin.strictKey).not.toBe(thick.strictKey);
  });
});

describe('levenshteinWithin', () => {
  it('handles substitutions and transpositions', () => {
    expect(levenshteinWithin('брачино', 'брачанно', 2)).toBe(true);
    expect(levenshteinWithin('силвер', 'сильвер', 2)).toBe(true);
    expect(levenshteinWithin('джелато', 'джелатто', 2)).toBe(true);
    expect(levenshteinWithin('абвгд', 'бавгд', 1)).toBe(true);
    expect(levenshteinWithin('кашемир', 'капучино', 2)).toBe(false);
  });
});

describe('classifyCandidates', () => {
  it('auto-matches an unambiguous name with the same code', () => {
    const result = classifyCandidates(analyzeFilmName('дуб вотан 113/3 алер'), catalog(['113/3  Дуб вотан', 'AL 27  Дуб винченца']));
    expect(result.status).toBe('auto');
    expect(result.ranked[0].id).toBe(0);
  });

  it('auto-matches plain names without codes', () => {
    const result = classifyCandidates(analyzeFilmName('софт грей АИФ'), catalog(['Софт Грей', 'Софт Белый', 'Софт Сантьяго']));
    expect(result.status).toBe('auto');
    expect(result.ranked[0].id).toBe(0);
  });

  it('never auto-matches when the catalog has thickness variants and the ERP name has none', () => {
    const result = classifyCandidates(
      analyzeFilmName('санд сноу ед'),
      catalog(['Санд сноу CRM 100-SD-L_0.18*1400, пог. м', 'Санд сноу CRM 100-SD-L_0.35*1400, пог. м']),
    );
    expect(result.status).toBe('suggested');
    expect(result.ranked).toHaveLength(2);
  });

  it('never auto-matches a single candidate with a conflicting thickness', () => {
    const result = classifyCandidates(analyzeFilmName('Космея 0,26 декор777'), catalog(['4997 Космея 0,25']));
    expect(result.status).toBe('suggested');
    expect(result.ranked[0].dimensionConflict).toBe(true);
  });

  it('auto-matches a single catalog variant when the ERP name omits thickness', () => {
    const result = classifyCandidates(analyzeFilmName('5184 ясень белый декор777'), catalog(['5184 Ясень белый 0,25', '3789 Лофт белый 0,25']));
    expect(result.status).toBe('auto');
    expect(result.ranked[0].id).toBe(0);
  });

  it('suggests when two candidates are equally close', () => {
    const result = classifyCandidates(analyzeFilmName('софт камень аиф'), catalog(['Софт Белый', 'Софт Сантьяго']));
    expect(result.status).not.toBe('auto');
  });

  it('returns none when nothing is similar', () => {
    const result = classifyCandidates(analyzeFilmName('шагрень какао кира'), catalog(['Дуб крафт Табачный']));
    expect(result.status).toBe('none');
  });

  it('penalises conflicting texture words', () => {
    const glossy = scoreCandidate(analyzeFilmName('белый глянец'), analyzeFilmName('белый мат'));
    const same = scoreCandidate(analyzeFilmName('белый глянец'), analyzeFilmName('белый глянец'));
    expect(glossy.score).toBeLessThan(same.score);
  });
});
