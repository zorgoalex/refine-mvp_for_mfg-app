// Нормализатор названий плёнок: общий для импорта каталога 1С, импорта остатков
// и поиска похожих плёнок. Чистые функции без доступа к БД.
//
// Два ключа сравнения:
// - strictKey — слова + коды + толщина/размеры: для точных совпадений (`auto`/`exact`);
// - looseKey — слова + коды без толщины/размеров: только для предложений.

/** Ключ поставщика ERP: имя записи `vendors` (как в справочнике) или `@имя` для поставщика без записи. */
export type VendorKey = string;

export interface FilmNameAnalysis {
  /** Очищенный текст в нижнем регистре. */
  normalized: string;
  /** Слова названия (синонимы фактуры, свёрнутые окончания), без поставщика, кодов, размеров. */
  words: string[];
  /** Коды артикулов в нормализованном виде (`al40`, `kz18`, `js9052-28`, `113/3`). */
  codes: string[];
  /** Толщина и размеры (`0.25`, `1400`). */
  dimensions: string[];
  /** Поставщик, распознанный по токенам названия. */
  vendorKey: VendorKey | null;
  strictKey: string;
  looseKey: string;
}

/**
 * Словарь «токен названия → поставщик ERP». Имена поставщиков — как в справочнике
 * `vendors` stage/prod. `@`-ключи — поставщики без записи в справочнике: такие
 * записи не сопоставляются с каталогом (остаются как есть).
 */
export const DEFAULT_VENDOR_TOKENS: ReadonlyArray<readonly [RegExp, VendorKey]> = [
  [/^(аиф|айф|aif|алимжан)$/, 'Аиф'],
  [/^(кира|kira)$/, 'Kira'],
  [/^(ед|ed|евразия)$/, 'Евразия Декор'],
  [/^(декорсемьсот)$/, 'Decor777'],
  [/^(декор|decor|декорплюс)$/, 'Decor+'],
  [/^(алер|aler)$/, 'Алер'],
  [/^(адилет|адлет|adilet)$/, 'ADILET'],
  [/^(сафа|safa)$/, 'SAFA'],
  [/^(прайм|prime|фокус|focus|focusprime)$/, 'Focus Prime'],
  [/^(мс|ms|групп|груп|гркпп|грп)$/, 'МС груп'],
  [/^(фарн|farn)$/, 'Farn'],
  [/^(емс|emc|евромаркет)$/, 'EMC (Euro Market)'],
  [/^(алия)$/, '@Алия'],
  [/^(гульсум)$/, '@Гульсум'],
  [/^(неля)$/, '@Неля'],
  [/^(gamma|гамма)$/, '@Gamma'],
  [/^(өзінен)$/, '@Өзінен'],
];

const LATIN_TO_CYRILLIC: Record<string, string> = {
  a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в',
};
const CYRILLIC_TO_LATIN: Record<string, string> = Object.fromEntries(
  Object.entries(LATIN_TO_CYRILLIC).map(([latin, cyrillic]) => [cyrillic, latin]),
);

/** Слово из смешанных алфавитов приводится к алфавиту большинства букв (`Sоft` → `soft`, `Мoлоко` → `молоко`). */
function unifyScript(word: string): string {
  const cyrillic = (word.match(/[а-я]/g) ?? []).length;
  const latin = (word.match(/[a-z]/g) ?? []).length;
  if (cyrillic === 0 || latin === 0) return word;
  return cyrillic >= latin
    ? word.replace(/[a-z]/g, (ch) => LATIN_TO_CYRILLIC[ch] ?? ch)
    : word.replace(/[а-я]/g, (ch) => CYRILLIC_TO_LATIN[ch] ?? ch);
}

const TEXTURE_SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(супермат\S*)$/, 'супермат'],
  [/^(матов\S*|мат|mat|matt)$/, 'мат'],
  [/^(софт|soft|sft)$/, 'софт'],
  [/^(глянц\S*|глянец|gloss|glossy)$/, 'глянец'],
];

const STOP_WORDS = new Set(['пленка', 'плёнка', 'пленки', 'пог', 'м', 'мм', 'фантаз', 'мет', 'л', 'max', 'мах']);

const ADJECTIVE_ENDINGS = /(ая|яя|ый|ий|ой|ое|ее|ые|ие)$/;

/** Нормализация текста до разбора: регистр, ё, тире, смешанные алфавиты внутри слов. */
export function normalizeFilmText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[‐-―−]/g, '-')
    .replace(/[a-zа-я]+/g, unifyScript)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDecimal(value: string): string {
  return value.replace(',', '.');
}

function extractDimensions(text: string): { rest: string; dimensions: string[] } {
  const dimensions: string[] = [];
  let rest = text;
  // `_0.25*1400`, `0,18*1260`
  rest = rest.replace(/(\d+[.,]\d+)\s*\*\s*(\d{3,4})/g, (_m, thickness: string, width: string) => {
    dimensions.push(normalizeDecimal(thickness), width);
    return ' ';
  });
  // `(0,26)`, `( 0,27 )`, `(0,25мм)`
  rest = rest.replace(/\(\s*(\d+[.,]\d+)\s*(мм)?\s*\)/g, (_m, thickness: string) => {
    dimensions.push(normalizeDecimal(thickness));
    return ' ';
  });
  // отдельная толщина `0,25` / `0.30` / `0,3`
  rest = rest.replace(/(^|[^\d.,])(0[.,]\d{1,2})(?![\d.,])/g, (_m, lead: string, thickness: string) => {
    dimensions.push(normalizeDecimal(thickness).replace(/^0\.(\d)$/, '0.$10'));
    return `${lead} `;
  });
  // `, пог. м` и одиночное `пог м`
  rest = rest.replace(/пог\.?\s*м\.?/g, ' ');
  return { rest, dimensions: dimensions.map((d) => d.replace(/^0\.(\d)$/, '0.$10')) };
}

function extractCodes(text: string): { rest: string; codes: string[] } {
  const codes: string[] = [];
  let rest = text;
  // слипшийся код и слово: `4997космея` → `4997 космея`
  rest = rest.replace(/(\d)([а-я]{3,})/g, '$1 $2');
  // `113/3`, `036/336`
  rest = rest.replace(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/g, (_m, a: string, b: string) => {
    codes.push(`${a}/${b}`);
    return ' ';
  });
  // латинский префикс + число через пробел/дефис: `kz 18`, `al-11`, `js 9052-28`, `frs 828-2-l`
  rest = rest.replace(/\b([a-z]{1,5})[\s-]?(\d{1,6}[a-z]{0,2}(?:-[0-9a-z]{1,4})*)(?![0-9a-z])/g, (_m, prefix: string, rest2: string) => {
    codes.push(`${prefix}${rest2}`);
    return ' ';
  });
  // кириллический префикс + число: `кз14`, `мвр 1421-28`
  rest = rest.replace(/(^|\s)([а-я]{1,3})[\s-]?(\d{2,6}(?:-[0-9a-z]{1,4})*)(?=\s|$)/g, (_m, lead: string, prefix: string, num: string) => {
    codes.push(`${prefix}${num}`);
    return `${lead} `;
  });
  // голые числа из 2+ цифр (с суффиксами): `5184`, `90368-3`, `1224-65p`
  rest = rest.replace(/(^|[^0-9a-zа-я])(\d{2,6}(?:-[0-9a-z]{1,4})*[a-z]?)(?=[^0-9a-zа-я]|$)/g, (_m, lead: string, num: string) => {
    codes.push(num);
    return `${lead} `;
  });
  return { rest, codes };
}

function foldWord(word: string): string {
  for (const [pattern, replacement] of TEXTURE_SYNONYMS) {
    if (pattern.test(word)) return replacement;
  }
  return word.length > 4 ? word.replace(ADJECTIVE_ENDINGS, '') : word;
}

export function analyzeFilmName(
  name: string,
  vendorTokens: ReadonlyArray<readonly [RegExp, VendorKey]> = DEFAULT_VENDOR_TOKENS,
): FilmNameAnalysis {
  const normalized = normalizeFilmText(name);
  // служебные приписки каталога: «плёнка мат.», «плёнка глянц.», «плёнка фантаз. мет.»
  const withoutPrefix = normalized
    .replace(/(^|[^a-zа-я])пл[её]нка\s+(мат|глянц|фантаз|мет)\.?/g, (_m, lead: string, kind: string) => (kind === 'мат' ? `${lead} мат ` : kind === 'глянц' ? `${lead} глянец ` : `${lead} `))
    // поставщики с цифрами/знаками: «Декор 777», «декор778», «Декор+» — до разбора кодов
    .replace(/(декор|decor)\s*-?\s*7[78]\d(?!\d)/g, ' декорсемьсот ')
    .replace(/(декор|decor)\s*\+/g, ' декорплюс ');
  const { rest: afterDims, dimensions } = extractDimensions(withoutPrefix);
  const { rest: afterCodes, codes } = extractCodes(afterDims);
  const tokens = afterCodes.split(/[^a-zа-яәіңғүұқөһ]+/).filter(Boolean);
  let vendorKey: VendorKey | null = null;
  const words: string[] = [];
  for (const token of tokens) {
    const vendor = vendorTokens.find(([pattern]) => pattern.test(token));
    if (vendor) {
      vendorKey ??= vendor[1];
      continue;
    }
    if (STOP_WORDS.has(token)) continue;
    const folded = foldWord(token);
    if (folded.length >= 2) words.push(folded);
  }
  const cleanedCodes = codes;
  const sortedWords = [...words].sort();
  const sortedCodes = [...new Set(cleanedCodes)].sort();
  const sortedDims = [...new Set(dimensions)].sort();
  return {
    normalized,
    words,
    codes: sortedCodes,
    dimensions: sortedDims,
    vendorKey,
    strictKey: [...sortedWords, ...sortedCodes, ...sortedDims.map((d) => `#${d}`)].join(' '),
    looseKey: [...sortedWords, ...sortedCodes].join(' '),
  };
}

/** Расстояние Дамерау–Левенштейна (оптимальное выравнивание строк) не больше `limit`. */
export function levenshteinWithin(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_v, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length] <= limit;
}

/** Сходство слов (0 — не связаны). Экспорт — для индекса кандидатов. */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 5 && b.length >= 5 && levenshteinWithin(a, b, 2)) return 0.8;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.7;
  return 0;
}

export function codesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 3 && /\d{2,}/.test(short) && long.includes(short);
}

const TEXTURE_WORDS = new Set(['мат', 'софт', 'глянец', 'супермат']);

export interface CandidateScore {
  score: number;
  codeMatch: boolean;
  codeConflict: boolean;
  dimensionConflict: boolean;
}

/** Оценка сходства записи ERP с позицией каталога (0…~1.3). */
export function scoreCandidate(erp: FilmNameAnalysis, candidate: FilmNameAnalysis): CandidateScore {
  const a = erp.words;
  const b = candidate.words;
  const codeMatch = erp.codes.some((x) => candidate.codes.some((y) => codesMatch(x, y)));
  const codeConflict = erp.codes.length > 0 && candidate.codes.length > 0 && !codeMatch;
  const dimensionConflict = erp.dimensions.length > 0 && candidate.dimensions.length > 0
    && !erp.dimensions.every((d) => candidate.dimensions.includes(d));
  if (a.length === 0 || b.length === 0) {
    return { score: codeMatch && a.length === 0 && b.length === 0 ? 1 : codeMatch ? 0.6 : 0, codeMatch, codeConflict, dimensionConflict };
  }
  const used = new Set<number>();
  let sum = 0;
  for (const word of a) {
    let best = 0;
    let bestIndex = -1;
    b.forEach((other, index) => {
      if (used.has(index)) return;
      const value = wordSimilarity(word, other);
      if (value > best) {
        best = value;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      used.add(bestIndex);
      sum += best;
    }
  }
  let score = sum / Math.max(a.length, b.length);
  if (codeMatch) score += 0.3;
  if (codeConflict) score -= 0.15;
  const textureA = a.filter((w) => TEXTURE_WORDS.has(w));
  const textureB = b.filter((w) => TEXTURE_WORDS.has(w));
  if (textureA.length > 0 && textureB.length > 0 && !textureA.some((w) => textureB.includes(w))) score -= 0.2;
  return { score: Math.round(score * 1000) / 1000, codeMatch, codeConflict, dimensionConflict };
}

export interface MatchCandidateInput<T> {
  id: T;
  analysis: FilmNameAnalysis;
}

export interface RankedCandidate<T> extends CandidateScore {
  id: T;
}

export type MatchClassification = 'auto' | 'suggested' | 'none';

export interface MatchResult<T> {
  status: MatchClassification;
  ranked: RankedCandidate<T>[];
}

export interface MatchThresholds {
  /** Минимальная оценка лучшего кандидата для `auto`. */
  autoScore: number;
  /** Минимальный отрыв лучшего кандидата от второго для `auto`. */
  autoMargin: number;
  /** Минимальная оценка кандидата для предложения. */
  suggestScore: number;
  /** Сколько кандидатов предлагать. */
  maxSuggestions: number;
}

export const DEFAULT_MATCH_THRESHOLDS: MatchThresholds = {
  autoScore: 0.95,
  autoMargin: 0.15,
  suggestScore: 0.5,
  maxSuggestions: 5,
};

/**
 * Классификация сопоставления записи ERP с кандидатами одного поставщика.
 * `auto` — только без конфликта толщины/размеров: либо обе стороны указывают
 * одинаковые значения, либо у записи их нет и у каталога ровно один вариант с
 * тем же упрощённым ключом. Любой конфликт толщины — не более чем `suggested`.
 */
export function classifyCandidates<T>(
  erp: FilmNameAnalysis,
  candidates: ReadonlyArray<MatchCandidateInput<T>>,
  thresholds: MatchThresholds = DEFAULT_MATCH_THRESHOLDS,
): MatchResult<T> {
  const ranked = candidates
    .map((candidate) => ({ id: candidate.id, looseKey: candidate.analysis.looseKey, ...scoreCandidate(erp, candidate.analysis) }))
    .filter((candidate) => candidate.score >= thresholds.suggestScore)
    .sort((x, y) => y.score - x.score);
  const best = ranked[0];
  if (!best) return { status: 'none', ranked: [] };
  const second = ranked[1];
  const margin = best.score - (second?.score ?? 0);
  const variantsOfBest = candidates.filter((c) => c.analysis.looseKey === best.looseKey).length;
  const dimensionsSafe = !best.dimensionConflict
    && (erp.dimensions.length > 0 || variantsOfBest <= 1);
  const status: MatchClassification = best.score >= thresholds.autoScore && margin >= thresholds.autoMargin && dimensionsSafe
    ? 'auto'
    : 'suggested';
  return {
    status,
    ranked: ranked.slice(0, thresholds.maxSuggestions).map(({ looseKey: _looseKey, ...rest }) => rest),
  };
}
