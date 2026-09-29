// Файл решений импорта каталога 1С: строгий повтор решений stage на проде (план
// 2026-09-29-film-catalog-prod-transfer-plan.md, §C). Прод применяет РОВНО решения,
// применённые на stage, к плёнкам с неизменным отпечатком; остальное не трогает.
import { createHash } from 'node:crypto';

export const DECISIONS_FORMAT = 'erp.film-catalog-decisions';
export const DECISIONS_VERSION = 1;
/** Версия набора BUSINESS_FIELDS, из которого считается отпечаток плёнки. */
export const FINGERPRINT_VERSION = 1;
export const DECISIONS_MAX_ROWS = 5000;

export interface DecisionFilm {
  filmId: number;
  /** Отпечаток бизнес-полей на момент черновика stage (catalog_import_matches.fingerprint). */
  fingerprint: string;
  role: 'canonical' | 'duplicate';
}

export interface DecisionRow {
  catalogKey: string;
  onecRefKey: string | null;
  rowNo: number;
  nameOriginal: string;
  nameFull: string;
  supplier: string;
  nomenclatureType: string | null;
  unit: string | null;
  nomenclatureCategory: string | null;
  targetName: string;
  supplierNorm: string;
  canonicalFilmTexture: boolean | null;
  canonicalFilmTypeId: number | null;
  outcome: 'existing' | 'create';
  films: DecisionFilm[];
}

export interface DecisionVendor {
  supplierNorm: string;
  vendorId: number;
  vendorName: string;
  materialTypeId: number | null;
  created: boolean;
}

export interface DecisionsPayload {
  format: typeof DECISIONS_FORMAT;
  version: number;
  fingerprintVersion: number;
  sourceBatchId: number;
  exportedAt: string;
  rows: DecisionRow[];
  vendors: DecisionVendor[];
}

export interface DecisionsFile extends DecisionsPayload {
  sha256: string;
}

/** Сериализация с сортировкой ключей объектов: хеш не зависит от порядка полей. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

export function decisionsSha256(payload: DecisionsPayload): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function withSha(payload: DecisionsPayload): DecisionsFile {
  return { ...payload, sha256: decisionsSha256(payload) };
}

/** Проверка целостности файла: sha256 пересчитывается по содержимому без поля sha256. */
export function verifyDecisionsFile(file: DecisionsFile): void {
  if (file.format !== DECISIONS_FORMAT) throw new Error('Неизвестный формат файла решений');
  if (file.version !== DECISIONS_VERSION) throw new Error(`Версия файла решений ${file.version} не поддерживается`);
  if (file.fingerprintVersion !== FINGERPRINT_VERSION) {
    throw new Error(`Версия отпечатков ${file.fingerprintVersion} не поддерживается — выгрузите файл заново`);
  }
  const { sha256, ...payload } = file;
  if (decisionsSha256(payload) !== sha256) throw new Error('Файл решений повреждён или изменён (sha256 не совпадает)');
  const keys = new Set<string>();
  const films = new Set<number>();
  for (const row of file.rows) {
    if (keys.has(row.catalogKey)) throw new Error(`Строка каталога ${row.catalogKey} встречается дважды`);
    keys.add(row.catalogKey);
    if (row.outcome === 'create' && row.films.length > 0) throw new Error(`Строка ${row.catalogKey}: create без плёнок`);
    if (row.outcome === 'existing') {
      if (row.films.filter((film) => film.role === 'canonical').length !== 1) {
        throw new Error(`Строка ${row.catalogKey}: ровно одна основная плёнка`);
      }
    }
    for (const film of row.films) {
      if (films.has(film.filmId)) throw new Error(`Плёнка ${film.filmId} указана в нескольких строках`);
      films.add(film.filmId);
    }
  }
}

export type ReplayRowStatus = 'apply' | 'create' | 'skipped';
export type ReplaySkipReason = 'changed' | 'missing' | 'canonical_skipped' | 'no_films' | 'exists';

export interface ReplayRowPlan {
  catalogKey: string;
  status: ReplayRowStatus;
  issue: string | null;
  canonicalFilmId: number | null;
  films: Array<{ filmId: number; role: 'canonical' | 'duplicate' }>;
}

export interface ReplayPlan {
  rows: ReplayRowPlan[];
  skipped: Array<{ filmId: number | null; catalogKey: string; reason: ReplaySkipReason }>;
}

/**
 * План повтора: решение по плёнке применяется, только если её текущий отпечаток равен
 * отпечатку из файла. Строка с пропущенной основной плёнкой или без применимых плёнок не
 * применяется и не создаётся; `create` — только если такой позиции (ключ каталога/1С) ещё нет.
 */
export function planReplay(
  file: Pick<DecisionsPayload, 'rows'>,
  currentFingerprints: ReadonlyMap<number, string>,
  existingCatalogKeys: ReadonlySet<string>,
  existingRefKeys: ReadonlySet<string>,
): ReplayPlan {
  const plan: ReplayPlan = { rows: [], skipped: [] };
  for (const row of file.rows) {
    if (row.outcome === 'create') {
      const exists = existingCatalogKeys.has(row.catalogKey)
        || (row.onecRefKey !== null && existingRefKeys.has(row.onecRefKey.toLowerCase()));
      if (exists) {
        plan.rows.push({ catalogKey: row.catalogKey, status: 'skipped', issue: 'Позиция уже есть в справочнике', canonicalFilmId: null, films: [] });
        plan.skipped.push({ filmId: null, catalogKey: row.catalogKey, reason: 'exists' });
      } else {
        plan.rows.push({ catalogKey: row.catalogKey, status: 'create', issue: null, canonicalFilmId: null, films: [] });
      }
      continue;
    }
    const applied: Array<{ filmId: number; role: 'canonical' | 'duplicate' }> = [];
    for (const film of row.films) {
      const current = currentFingerprints.get(film.filmId);
      if (current === undefined) {
        plan.skipped.push({ filmId: film.filmId, catalogKey: row.catalogKey, reason: 'missing' });
      } else if (current !== film.fingerprint) {
        plan.skipped.push({ filmId: film.filmId, catalogKey: row.catalogKey, reason: 'changed' });
      } else {
        applied.push({ filmId: film.filmId, role: film.role });
      }
    }
    const canonical = applied.find((film) => film.role === 'canonical');
    if (!canonical) {
      const reason: ReplaySkipReason = applied.length === 0 ? 'no_films' : 'canonical_skipped';
      plan.rows.push({
        catalogKey: row.catalogKey,
        status: 'skipped',
        issue: reason === 'no_films'
          ? 'Решение stage не применено: плёнки на проде изменены или отсутствуют'
          : 'Решение stage не применено: основная плёнка изменена или отсутствует',
        canonicalFilmId: null,
        films: [],
      });
      plan.skipped.push({ filmId: null, catalogKey: row.catalogKey, reason });
      continue;
    }
    plan.rows.push({ catalogKey: row.catalogKey, status: 'apply', issue: null, canonicalFilmId: canonical.filmId, films: applied });
  }
  return plan;
}
