// Сопоставление строк файла остатков с плёнками (план §8): алиас → точное
// совпадение строгого ключа (с толщиной/размерами) среди плёнок поставщика по
// текущим, прежним названиям и названиям дублей с разрешением в канон →
// до 5 предложений. Нечёткое совпадение никогда не становится `exact`.
// Поставщик строки — из колонки поставщика (поставщик ERP по названию/алиасу и
// словарь поставщиков нормализатора); поставщик в названии строки учитывается,
// только если не противоречит колонке. Поставщик плёнки — из карточки, а у плёнок
// на поставщике-заглушке («нд»: до импорта каталога 1С почти все плёнки) — из её
// названия («… -АЙФ», «… алер»). Конфликт источников запрещает `exact`.
// Предложения ищутся по всему справочнику: сначала плёнки этого поставщика.

import {
  analyzeFilmName,
  classifyCandidates,
  codesMatch,
  DEFAULT_MATCH_THRESHOLDS,
  wordSimilarity,
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
  /** Поставщики-заглушки («нд»): у их плёнок поставщик определяется по названию. */
  placeholderVendorIds: ReadonlySet<number>;
  candidates: ReadonlyArray<StockFilmCandidate>;
}

export interface StockMatchResult {
  matchStatus: Extract<LineMatchStatus, 'alias' | 'exact' | 'suggested' | 'unmatched'>;
  filmId: number | null;
  suggestions: Array<{ filmId: number; filmName: string; score: number }>;
}

const MAX_SUGGESTIONS = 5;

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

// ---------------------------------------------------------------- индекс кандидатов
// Оценка ≥ порога предложения невозможна без хотя бы одной пары связанных слов
// (wordSimilarity > 0: равенство, префикс от 4 символов, Дамерау–Левенштейн ≤ 2 от
// 5 символов) либо, у кандидата без слов, без связанного кода. Индекс отбирает только
// таких кандидатов — результат совпадает с полным перебором, но без O(строки × справочник)
// оценок (синхронный расчёт внутри транзакции импорта).

interface CandidateIndex {
  byStrictKey: Map<string, AnalyzedCandidate[]>;
  byWord: Map<string, AnalyzedCandidate[]>;
  wordsByLength: Map<number, string[]>;
  wordsByPrefix: Map<string, string[]>;
  byCode: Map<string, AnalyzedCandidate[]>;
  codes: string[];
  similarWords: Map<string, string[]>;
  relatedCodes: Map<string, string[]>;
  position: Map<AnalyzedCandidate, number>;
}

const indexes = new WeakMap<ReadonlyArray<AnalyzedCandidate>, CandidateIndex>();

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function candidateIndex(prepared: ReadonlyArray<AnalyzedCandidate>): CandidateIndex {
  const cached = indexes.get(prepared);
  if (cached) return cached;
  const index: CandidateIndex = {
    byStrictKey: new Map(), byWord: new Map(), wordsByLength: new Map(), wordsByPrefix: new Map(),
    byCode: new Map(), codes: [], similarWords: new Map(), relatedCodes: new Map(), position: new Map(),
  };
  for (const candidate of prepared) {
    index.position.set(candidate, index.position.size);
    if (candidate.analysis.strictKey) push(index.byStrictKey, candidate.analysis.strictKey, candidate);
    for (const word of new Set(candidate.analysis.words)) {
      if (!index.byWord.has(word)) {
        push(index.wordsByLength, word.length, word);
        if (word.length >= 4) push(index.wordsByPrefix, word.slice(0, 4), word);
      }
      push(index.byWord, word, candidate);
    }
    for (const code of new Set(candidate.analysis.codes)) {
      if (!index.byCode.has(code)) index.codes.push(code);
      push(index.byCode, code, candidate);
    }
  }
  indexes.set(prepared, index);
  return index;
}

function similarWords(index: CandidateIndex, word: string): string[] {
  const cached = index.similarWords.get(word);
  if (cached) return cached;
  const found = new Set<string>();
  if (index.byWord.has(word)) found.add(word);
  if (word.length >= 4) {
    for (const other of index.wordsByPrefix.get(word.slice(0, 4)) ?? []) {
      if (wordSimilarity(word, other) > 0) found.add(other);
    }
  }
  if (word.length >= 5) {
    for (let length = Math.max(5, word.length - 2); length <= word.length + 2; length += 1) {
      for (const other of index.wordsByLength.get(length) ?? []) {
        if (!found.has(other) && wordSimilarity(word, other) > 0) found.add(other);
      }
    }
  }
  const result = [...found];
  index.similarWords.set(word, result);
  return result;
}

function relatedCodes(index: CandidateIndex, code: string): string[] {
  const cached = index.relatedCodes.get(code);
  if (cached) return cached;
  const result = index.codes.filter((other) => codesMatch(code, other));
  index.relatedCodes.set(code, result);
  return result;
}

/** Кандидаты, которые могут набрать порог предложения (надмножество, без потерь). */
export function relatedCandidates(analysis: FilmNameAnalysis, prepared: ReadonlyArray<AnalyzedCandidate>): AnalyzedCandidate[] {
  const index = candidateIndex(prepared);
  const result = new Set<AnalyzedCandidate>();
  for (const word of new Set(analysis.words)) {
    for (const other of similarWords(index, word)) {
      for (const candidate of index.byWord.get(other) ?? []) result.add(candidate);
    }
  }
  for (const code of new Set(analysis.codes)) {
    for (const other of relatedCodes(index, code)) {
      for (const candidate of index.byCode.get(other) ?? []) result.add(candidate);
    }
  }
  // Исходный порядок справочника: при равных оценках ранжирование как при полном переборе.
  return [...result].sort((left, right) => index.position.get(left)! - index.position.get(right)!);
}

const sameVendorKey = (left: string | null, right: string | null): boolean =>
  left !== null && right !== null && left.toLowerCase() === right.toLowerCase();

/** Поставщик строки файла: ERP-поставщик и ключ словаря; conflict — источники расходятся. */
function rowSupplier(
  row: { name: string; supplier: string },
  nameAnalysis: FilmNameAnalysis,
  vendorIdForSupplier: (supplier: string) => number | null,
): { vendorId: number | null; vendorKey: string | null; conflict: boolean } {
  const supplier = row.supplier.trim();
  const vendorId = supplier ? vendorIdForSupplier(supplier) : null;
  const columnKey = supplier ? analyzeFilmName(supplier).vendorKey : null;
  const nameKey = nameAnalysis.vendorKey;
  // Поставщик назван и в колонке, и в названии: они должны совпасть по ключу словаря
  // или по поставщику ERP, в которого разрешается каждый (включая алиасы колонки).
  // Недоказанное совпадение — конфликт: exact запрещён.
  const nameVendorId = nameKey !== null ? vendorIdForSupplier(nameKey) : null;
  const conflict = supplier !== '' && nameKey !== null
    && !sameVendorKey(columnKey, nameKey)
    && !(vendorId !== null && nameVendorId !== null && vendorId === nameVendorId);
  return { vendorId, vendorKey: columnKey ?? (supplier ? null : nameKey), conflict };
}

export function matchStockRow(
  row: { name: string; supplier: string },
  context: Omit<StockMatchContext, 'candidates'> & { prepared: ReadonlyArray<AnalyzedCandidate> },
): StockMatchResult {
  const aliasFilmId = context.aliases.get(aliasKey(row.name, row.supplier));
  if (aliasFilmId !== undefined) return { matchStatus: 'alias', filmId: aliasFilmId, suggestions: [] };

  // Ключи и оценка — только по названию строки; поставщик — отдельно.
  const analysis = analyzeFilmName(row.name);
  const supplier = rowSupplier(row, analysis, context.vendorIdForSupplier);
  const sameSupplier = (candidate: AnalyzedCandidate): boolean => {
    const placeholder = candidate.vendorId === null || context.placeholderVendorIds.has(candidate.vendorId);
    if (!placeholder) return supplier.vendorId !== null && candidate.vendorId === supplier.vendorId;
    return sameVendorKey(supplier.vendorKey, candidate.analysis.vendorKey);
  };
  const supplierKnown = supplier.vendorId !== null || supplier.vendorKey !== null;

  if (supplierKnown && !supplier.conflict && analysis.strictKey) {
    const exact = new Set((candidateIndex(context.prepared).byStrictKey.get(analysis.strictKey) ?? [])
      .filter((candidate) => sameSupplier(candidate))
      .map((candidate) => candidate.canonicalFilmId));
    if (exact.size === 1) return { matchStatus: 'exact', filmId: [...exact][0], suggestions: [] };
  }

  const ranked = classifyCandidates(
    analysis,
    relatedCandidates(analysis, context.prepared).map((candidate) => ({ id: candidate, analysis: candidate.analysis })),
    { ...DEFAULT_MATCH_THRESHOLDS, maxSuggestions: Number.MAX_SAFE_INTEGER },
  ).ranked;
  // Сначала плёнки того же поставщика, затем остальные; внутри — по убыванию сходства.
  const ordered = supplierKnown
    ? [...ranked.filter((entry) => sameSupplier(entry.id)), ...ranked.filter((entry) => !sameSupplier(entry.id))]
    : ranked;
  const seen = new Set<number>();
  const suggestions: StockMatchResult['suggestions'] = [];
  for (const entry of ordered) {
    if (seen.has(entry.id.canonicalFilmId)) continue;
    seen.add(entry.id.canonicalFilmId);
    suggestions.push({ filmId: entry.id.canonicalFilmId, filmName: entry.id.canonicalName, score: entry.score });
    if (suggestions.length === MAX_SUGGESTIONS) break;
  }
  return suggestions.length > 0
    ? { matchStatus: 'suggested', filmId: null, suggestions }
    : { matchStatus: 'unmatched', filmId: null, suggestions: [] };
}
