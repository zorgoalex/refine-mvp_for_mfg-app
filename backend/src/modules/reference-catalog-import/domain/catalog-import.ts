import { createHash } from 'node:crypto';
import {
  analyzeFilmName,
  classifyCandidates,
  DEFAULT_MATCH_THRESHOLDS,
} from '../../films/domain/film-name-normalizer';
import type {
  CatalogRow,
  CatalogRowStatus,
} from '../../../shared/film-catalog';

export type MatchStatus =
  | 'linked'
  | 'auto'
  | 'suggested'
  | 'confirmed'
  | 'manual'
  | 'none'
  | 'unchanged';
export interface FilmCandidate {
  filmId: number;
  filmName: string;
  vendorId: number | null;
  vendorName: string | null;
  isActive: boolean;
  canonicalFilmId: number | null;
  filmTexture: boolean;
  filmTypeId: number;
  filmTypeName: string;
  sortOrder: number;
  catalogKey: string | null;
  refKey1c: string | null;
  details: number;
  lastUsedAt: string | null;
  previousNames: string[];
  nomenclatureType: string | null;
  nomenclatureCategory: string | null;
  canonicalCatalogKey?: string | null;
  canonicalRefKey1c?: string | null;
}
export interface MatchResult {
  filmId: number;
  rowId: number | null;
  matchStatus: MatchStatus;
  score: number | null;
  candidates: Array<{
    rowId: number;
    targetName: string;
    score: number;
    dimensionConflict: boolean;
  }>;
  fingerprint: string;
}
export interface ImportRow extends Omit<CatalogRow, 'rowStatus'> {
  rowStatus: CatalogRowStatus | 'skipped';
  rowId: number;
  vendorId: number | null;
  refKey1c: string | null;
  canonicalFilmId: number | null;
  canonicalFilmTexture: boolean | null;
  canonicalFilmTypeId: number | null;
  propertyConflict: null | { filmTexture: boolean[]; filmTypeIds: number[] };
}
export interface CatalogAction {
  type:
    | 'setVendor'
    | 'createVendor'
    | 'setOption'
    | 'acceptAllAuto'
    | 'setMatch'
    | 'confirmMatch'
    | 'setCanonical'
    | 'setCanonicalProperties';
  supplierNorm?: string;
  vendorId?: number;
  createMissing?: boolean;
  filmId?: number;
  rowId?: number | null;
  filmTexture?: boolean;
  filmTypeId?: number;
}

export const supplierNorm = (value: string): string =>
  value.trim().toLowerCase();
export function canAccessSourceKind(
  sourceKind: string,
  permissions: readonly string[]
): boolean {
  return sourceKind !== 'onec_mirror' || permissions.includes('onec.view');
}
export const BUSINESS_FIELDS = [
  'film_name',
  'vendor_id',
  'film_type_id',
  'film_texture',
  'is_active',
  'sort_order',
  'canonical_film_id',
  'catalog_key',
  'ref_key_1c',
  'nomenclature_type',
  'nomenclature_category',
] as const;
// Примечание (films.note) — свободный текст, НЕ бизнес-поле: не входит в отпечаток (старые
// черновики и применённые пакеты сохраняют прежние отпечатки; ручная правка примечания не
// конфликт). Импорт дописывает прежнее название, откат возвращает примечание только если
// после применения его не правили.

export const FILM_NOTE_MAX = 2000;
export const PREVIOUS_NAME_PREFIX = 'Прежнее название: ';

/**
 * Примечание после переименования импортом каталога: строка «Прежнее название: …» дописывается
 * в конец (пользовательский текст сохраняется), повтор той же строки не добавляется; при
 * превышении лимита укорачивается дописанная строка, а не начало примечания.
 */
export function noteWithPreviousName(note: string | null, previousName: string): string | null {
  const line = `${PREVIOUS_NAME_PREFIX}${previousName.trim()}`;
  const current = note ?? '';
  if (current.split('\n').some((existing) => existing.trim() === line)) return note;
  const prefix = current.trim() ? `${current.replace(/\s+$/, '')}\n` : '';
  const room = FILM_NOTE_MAX - prefix.length;
  if (room <= PREVIOUS_NAME_PREFIX.length) return note;
  return prefix + line.slice(0, room);
}
export function normalizeFilmBusinessFields(
  film: Record<string, unknown>
): Record<(typeof BUSINESS_FIELDS)[number], unknown> {
  const normalized = Object.fromEntries(BUSINESS_FIELDS.map((field) => {
    const value = film[field];
    if (value === null || value === undefined) return [field, null];
    if (field === 'film_texture' || field === 'is_active') return [field, Boolean(value)];
    if (
      field === 'vendor_id' ||
      field === 'film_type_id' ||
      field === 'sort_order' ||
      field === 'canonical_film_id'
    ) {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new TypeError(`Invalid ${field}`);
      return [field, number];
    }
    return [field, value];
  })) as Record<(typeof BUSINESS_FIELDS)[number], unknown>;
  return normalized;
}

export function filmFingerprint(film: Record<string, unknown>): string {
  const normalized = normalizeFilmBusinessFields(film);
  return createHash('sha256')
    .update(JSON.stringify(BUSINESS_FIELDS.map((field) => normalized[field])))
    .digest('hex');
}

export function buildMatches(
  rows: ImportRow[],
  films: FilmCandidate[],
  vendorBySupplier: Map<string, number>
): MatchResult[] {
  const valid = rows.filter(
    (row) => row.rowStatus === 'ok' && row.vendorId !== null
  );
  const byId = new Map(valid.map((row) => [row.rowId, row]));
  return films.map((film) => {
    const fingerprint = filmFingerprint({
      film_name: film.filmName,
      vendor_id: film.vendorId,
      film_type_id: film.filmTypeId,
      film_texture: film.filmTexture,
      is_active: film.isActive,
      sort_order: film.sortOrder,
      canonical_film_id: film.canonicalFilmId,
      catalog_key: film.catalogKey,
      ref_key_1c: film.refKey1c,
      nomenclature_type: film.nomenclatureType,
      nomenclature_category: film.nomenclatureCategory,
    });
    if (
      film.catalogKey ||
      film.refKey1c ||
      film.canonicalCatalogKey ||
      film.canonicalRefKey1c
    ) {
      const linked = valid.find(
        (row) =>
          ((film.catalogKey ?? film.canonicalCatalogKey) &&
            row.catalogKey === (film.catalogKey ?? film.canonicalCatalogKey)) ||
          ((film.refKey1c ?? film.canonicalRefKey1c) &&
            row.refKey1c === (film.refKey1c ?? film.canonicalRefKey1c))
      );
      if (linked)
        return {
          filmId: film.filmId,
          rowId: linked.rowId,
          matchStatus: 'linked',
          score: 1,
          candidates: [],
          fingerprint,
        };
    }
    if (film.canonicalFilmId !== null)
      return {
        filmId: film.filmId,
        rowId: null,
        matchStatus: 'unchanged',
        score: null,
        candidates: [],
        fingerprint,
      };
    const recordVendor =
      film.vendorName && film.vendorName.toLowerCase() !== 'нд'
        ? film.vendorId
        : analyzeFilmName(film.filmName).vendorKey
        ? vendorBySupplier.get(
            supplierNorm(analyzeFilmName(film.filmName).vendorKey!)
          ) ?? null
        : null;
    if (recordVendor === null)
      return {
        filmId: film.filmId,
        rowId: null,
        matchStatus: 'unchanged',
        score: null,
        candidates: [],
        fingerprint,
      };
    const pool = valid
      .filter((row) => row.vendorId === recordVendor)
      .map((row) => ({ id: row.rowId, name: row.targetName }));
    if (!pool.length)
      return {
        filmId: film.filmId,
        rowId: null,
        matchStatus: 'unchanged',
        score: null,
        candidates: [],
        fingerprint,
      };
    const names = [film.filmName, ...film.previousNames];
    const erpAnalyses = names.map((name) => analyzeFilmName(name));
    const analyzedPool = pool.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      analysis: analyzeFilmName(candidate.name),
    }));
    const results = erpAnalyses.map((analysis) =>
      classifyCandidates(analysis, analyzedPool, DEFAULT_MATCH_THRESHOLDS)
    );
    const best = results
      .flatMap((result) =>
        result.ranked.map((ranked) => ({ status: result.status, ...ranked }))
      )
      .sort((a, b) => b.score - a.score)[0];
    if (!best)
      return {
        filmId: film.filmId,
        rowId: null,
        matchStatus: 'none',
        score: null,
        candidates: [],
        fingerprint,
      };
    const ranked = [
      ...new Map(
        results
          .flatMap((result) => result.ranked)
          .map((candidate) => [candidate.id, candidate])
      ).values(),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const candidates = ranked.map((candidate) => ({
      rowId: Number(candidate.id),
      targetName: pool.find((item) => item.id === candidate.id)?.name ?? '',
      score: candidate.score,
      dimensionConflict: candidate.dimensionConflict,
    }));
    return {
      filmId: film.filmId,
      rowId: best.status === 'auto' ? Number(best.id) : null,
      matchStatus: best.status as 'auto' | 'suggested',
      score: best.score,
      candidates,
      fingerprint,
    };
  });
}

export function refreshMatches(
  rows: ImportRow[],
  films: FilmCandidate[],
  vendorBySupplier: Map<string, number>,
  previous: MatchResult[],
  preserveFilmIds: ReadonlySet<number>
): MatchResult[] {
  const oldByFilmId = new Map(previous.map((match) => [match.filmId, match]));
  return buildMatches(rows, films, vendorBySupplier).map((match) => {
    const old = oldByFilmId.get(match.filmId);
    if (
      old &&
      (preserveFilmIds.has(match.filmId) ||
        ['linked', 'manual', 'confirmed'].includes(old.matchStatus))
    )
      return old;
    return match;
  });
}

export function assignCanonicals(
  rows: ImportRow[],
  matches: MatchResult[],
  films: FilmCandidate[]
): ImportRow[] {
  const filmMap = new Map(films.map((film) => [film.filmId, film]));
  for (const row of rows) {
    const group = matches.filter(
      (match) =>
        match.rowId === row.rowId &&
        ['linked', 'auto', 'confirmed', 'manual'].includes(match.matchStatus)
    );
    const linked = group.find((match) => match.matchStatus === 'linked');
    const existingCanonicalId = linked
      ? filmMap.get(linked.filmId)?.canonicalFilmId ?? linked.filmId
      : null;
    const linkedCanonical =
      existingCanonicalId === null
        ? undefined
        : group.find((match) => match.filmId === existingCanonicalId);
    const selected =
      linkedCanonical ??
      linked ??
      [...group].sort(
        (a, b) =>
          (filmMap.get(b.filmId)?.details ?? 0) -
            (filmMap.get(a.filmId)?.details ?? 0) || a.filmId - b.filmId
      )[0];
    row.canonicalFilmId =
      row.canonicalFilmId !== null &&
      group.some((match) => match.filmId === row.canonicalFilmId)
        ? row.canonicalFilmId
        : selected?.filmId ?? null;
    if (group.length) {
      const texture = new Set(
        group.map((match) => filmMap.get(match.filmId)?.filmTexture)
      );
      const types = new Set(
        group
          .map((match) => filmMap.get(match.filmId)?.filmTypeId)
          .filter((id) => id !== undefined)
      );
      if (types.size > 1) {
        const noTypeIds = new Set(
          films
            .filter((film) => film.filmTypeName.toLowerCase() === 'нд')
            .map((film) => film.filmTypeId)
        );
        for (const id of [...types]) if (noTypeIds.has(id)) types.delete(id);
      }
      row.propertyConflict =
        texture.size > 1 || types.size > 1
          ? {
              filmTexture: [...texture].filter(
                (x): x is boolean => x !== undefined
              ),
              filmTypeIds: [...types],
            }
          : null;
    } else row.propertyConflict = null;
  }
  return rows;
}

export function blockers(
  rows: ImportRow[],
  matches: MatchResult[],
  vendors: Array<{
    supplierNorm: string;
    vendorId: number | null;
    createVendor: boolean;
  }>,
  _createMissing: boolean
): string[] {
  const result: string[] = [];
  if (matches.some((match) => match.matchStatus === 'suggested'))
    result.push('Есть неподтверждённые предположения');
  if (
    rows.some(
      (row) =>
        row.rowStatus === 'ok' &&
        row.propertyConflict &&
        row.canonicalFilmTexture === null
    )
  )
    result.push('Не разрешены конфликты свойств');
  if (
    vendors.some((vendor) => vendor.vendorId === null && !vendor.createVendor)
  )
    result.push('Не сопоставлены поставщики');
  return result;
}

export function applyPatchActions(
  rows: ImportRow[],
  matches: MatchResult[],
  films: FilmCandidate[],
  vendors: Array<{
    supplierNorm: string;
    vendorId: number | null;
    createVendor: boolean;
  }>,
  actions: CatalogAction[],
  options: { createMissing: boolean }
): void {
  const filmIds = new Set(films.map((film) => film.filmId));
  const rowIds = new Set(rows.map((row) => row.rowId));
  for (const action of actions) {
    if (action.type === 'setOption') {
      options.createMissing = action.createMissing === true;
      continue;
    }
    if (action.type === 'setVendor' || action.type === 'createVendor') {
      const vendor = vendors.find(
        (item) => item.supplierNorm === action.supplierNorm
      );
      if (!vendor) throw new Error('FOREIGN_SUPPLIER');
      vendor.vendorId = action.type === 'setVendor' ? action.vendorId! : null;
      vendor.createVendor = action.type === 'createVendor';
      for (const row of rows)
        if (supplierNorm(row.supplier) === action.supplierNorm)
          row.vendorId = vendor.vendorId;
      continue;
    }
    if (action.type === 'acceptAllAuto') {
      for (const match of matches)
        if (match.matchStatus === 'auto') match.matchStatus = 'confirmed';
      continue;
    }
    if (action.type === 'setMatch' || action.type === 'confirmMatch') {
      if (!action.filmId || !filmIds.has(action.filmId))
        throw new Error('FOREIGN_FILM');
      const match = matches.find((item) => item.filmId === action.filmId)!;
      if (action.type === 'confirmMatch') {
        if (match.matchStatus !== 'auto' && match.matchStatus !== 'suggested')
          throw new Error('INVALID_MATCH_STATE');
        if (match.matchStatus === 'suggested') {
          const candidate = [...match.candidates].sort(
            (a, b) => b.score - a.score || a.rowId - b.rowId
          )[0];
          if (!candidate) throw new Error('MISSING_CANDIDATE');
          match.rowId = candidate.rowId;
        }
        match.matchStatus = 'confirmed';
      } else {
        if (action.rowId !== null && !rowIds.has(action.rowId!))
          throw new Error('FOREIGN_ROW');
        match.rowId = action.rowId ?? null;
        match.matchStatus = action.rowId === null ? 'none' : 'manual';
      }
      continue;
    }
    const row = rows.find((item) => item.rowId === action.rowId);
    if (!row) throw new Error('FOREIGN_ROW');
    if (action.type === 'setCanonical') {
      if (
        !filmIds.has(action.filmId!) ||
        !matches.some(
          (item) =>
            item.rowId === row.rowId &&
            item.filmId === action.filmId &&
            ['linked', 'auto', 'confirmed', 'manual'].includes(item.matchStatus)
        )
      )
        throw new Error('FILM_NOT_MATCHED');
      row.canonicalFilmId = action.filmId!;
    }
    if (action.type === 'setCanonicalProperties') {
      if (typeof action.filmTexture !== 'boolean' || !action.filmTypeId)
        throw new Error('INVALID_PROPERTIES');
      row.canonicalFilmTexture = action.filmTexture!;
      row.canonicalFilmTypeId = action.filmTypeId!;
    }
  }
  assignCanonicals(rows, matches, films);
}
