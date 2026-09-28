// Сопоставление строк файла остатков с плёнками (план §8): алиас → точное
// совпадение строгого ключа (с толщиной/размерами) среди плёнок поставщика по
// текущим, прежним названиям и названиям дублей с разрешением в канон →
// до 5 предложений. Нечёткое совпадение никогда не становится `exact`.

import {
  analyzeFilmName,
  classifyCandidates,
  type FilmNameAnalysis,
} from '../../films/domain/film-name-normalizer';
import type { LineMatchStatus } from './stock-posting';

export interface StockFilmCandidate {
  /** Каноническая плёнка, в которую разрешается совпадение. */
  canonicalFilmId: number;
  canonicalName: string;
  vendorId: number | null;
  /** Название, по которому ищем (текущее канона, дубля или прежнее). */
  matchName: string;
}

export interface StockMatchContext {
  aliases: ReadonlyMap<string, number>;
  /** Поставщик ERP по тексту поставщика из файла; null — не распознан. */
  vendorIdForSupplier: (supplier: string) => number | null;
  candidates: ReadonlyArray<StockFilmCandidate>;
}

export interface StockMatchResult {
  matchStatus: Extract<LineMatchStatus, 'alias' | 'exact' | 'suggested' | 'unmatched'>;
  filmId: number | null;
  suggestions: Array<{ filmId: number; filmName: string; score: number }>;
}

export function normalizeAliasPart(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

export function aliasKey(name: string, supplier: string): string {
  return `${normalizeAliasPart(name)}|${normalizeAliasPart(supplier)}`;
}

interface AnalyzedCandidate extends StockFilmCandidate {
  analysis: FilmNameAnalysis;
}

/** Подготовка кандидатов один раз на документ. */
export function prepareCandidates(candidates: ReadonlyArray<StockFilmCandidate>): AnalyzedCandidate[] {
  return candidates.map((candidate) => ({ ...candidate, analysis: analyzeFilmName(candidate.matchName) }));
}

export function matchStockRow(
  row: { name: string; supplier: string },
  context: Omit<StockMatchContext, 'candidates'> & { prepared: ReadonlyArray<AnalyzedCandidate> },
): StockMatchResult {
  const aliasFilmId = context.aliases.get(aliasKey(row.name, row.supplier));
  if (aliasFilmId !== undefined) return { matchStatus: 'alias', filmId: aliasFilmId, suggestions: [] };

  const vendorId = row.supplier.trim() ? context.vendorIdForSupplier(row.supplier) : null;
  const pool = vendorId === null
    ? context.prepared
    : context.prepared.filter((candidate) => candidate.vendorId === vendorId);
  const analysis = analyzeFilmName(row.name);
  if (vendorId !== null && analysis.strictKey) {
    const exact = new Set(pool.filter((candidate) => candidate.analysis.strictKey === analysis.strictKey)
      .map((candidate) => candidate.canonicalFilmId));
    if (exact.size === 1) return { matchStatus: 'exact', filmId: [...exact][0], suggestions: [] };
  }

  const ranked = classifyCandidates(analysis, pool.map((candidate) => ({ id: candidate, analysis: candidate.analysis })));
  const seen = new Set<number>();
  const suggestions: StockMatchResult['suggestions'] = [];
  for (const entry of ranked.ranked) {
    if (seen.has(entry.id.canonicalFilmId)) continue;
    seen.add(entry.id.canonicalFilmId);
    suggestions.push({ filmId: entry.id.canonicalFilmId, filmName: entry.id.canonicalName, score: entry.score });
  }
  return suggestions.length > 0
    ? { matchStatus: 'suggested', filmId: null, suggestions: suggestions.slice(0, 5) }
    : { matchStatus: 'unmatched', filmId: null, suggestions: [] };
}
