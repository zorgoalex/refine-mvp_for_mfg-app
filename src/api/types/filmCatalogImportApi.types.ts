export type CatalogImportStatus = 'draft' | 'applied' | 'cancelled' | 'reverted';
export type CatalogSourceKind = 'file' | 'onec_mirror';
export type CatalogRowStatus = 'ok' | 'invalid' | 'skipped';
export type MatchStatus = 'linked' | 'auto' | 'suggested' | 'confirmed' | 'manual' | 'none' | 'unchanged';

export interface CatalogRowInput {
  rowNo: number;
  nameOriginal: string;
  nameFull: string;
  supplier: string;
  nomenclatureType: string | null;
  unit: string | null;
  nomenclatureCategory: string | null;
}

export interface CatalogImportCounters {
  rows: number; rowsOk: number; rowsInvalid: number; rowsSkipped: number;
  films: number; linked: number; auto: number; suggested: number; confirmed: number;
  manual: number; none: number; unchanged: number; toRename: number; toMerge: number;
  toCreate: number; unresolvedGroups: number;
}

export interface VendorMappingDto {
  supplier: string; supplierNorm: string; rowsCount: number; vendorId: number | null;
  vendorName: string | null; createVendor: boolean; suggestedVendorId: number | null;
}

export interface CatalogImportBatchDto {
  id: number; kind: 'films'; sourceKind: CatalogSourceKind; status: CatalogImportStatus; version: number;
  fileName: string | null; fileSha256: string | null; sheetName: string | null;
  onecSourceId: number | null; onecCategoryKey: string | null; onecCategoryName: string | null;
  options: { createMissing: boolean; decisions?: CatalogDecisionsOptions }; counters: CatalogImportCounters; vendorMappings: VendorMappingDto[];
  canApply: boolean; blockers: string[]; createdAt: string; createdByName: string | null;
  appliedAt: string | null; appliedByName: string | null; revertedAt: string | null; revertedByName: string | null;
}

export interface CatalogImportRowDto extends CatalogRowInput {
  rowId: number; targetName: string; rowStatus: CatalogRowStatus; issue: string | null;
  vendorId: number | null; refKey1c: string | null; canonicalFilmId: number | null;
  matchedFilmIds: number[]; propertyConflict: null | { filmTexture: boolean[]; filmTypeIds: number[] };
  canonicalFilmTexture: boolean | null; canonicalFilmTypeId: number | null;
}

export interface CatalogImportMatchDto {
  filmId: number; filmName: string; vendorName: string | null; isActive: boolean;
  canonicalFilmId: number | null; usage: { details: number; lastUsedAt: string | null };
  matchStatus: MatchStatus; rowId: number | null; rowTargetName: string | null; score: number | null;
  candidates: Array<{ rowId: number; targetName: string; score: number; dimensionConflict: boolean }>;
}

export interface CatalogPage<T> { total: number; items: T[] }
export type CatalogImportAction =
  | { type: 'setVendor'; supplierNorm: string; vendorId: number }
  | { type: 'createVendor'; supplierNorm: string }
  | { type: 'setOption'; createMissing: boolean }
  | { type: 'acceptAllAuto' }
  | { type: 'setMatch'; filmId: number; rowId: number | null }
  | { type: 'confirmMatch'; filmId: number }
  | { type: 'setCanonical'; rowId: number; filmId: number }
  | { type: 'setCanonicalProperties'; rowId: number; filmTexture: boolean; filmTypeId: number };

export interface CatalogImportErrorDto { statusCode?: number; code?: string; message?: string; details?: unknown }
export interface CatalogNameHistoryDto {
  historyId: number; oldName: string; newName: string; oldVendorName: string | null;
  newVendorName: string | null; changedAt: string; changedByName: string | null; source: string; batchId: number | null;
}
export interface SimilarFilmDto {
  filmId: number; filmName: string; vendorName: string | null; isActive: boolean;
  canonicalFilmId: number | null; score: number;
}

export type DecisionSkipReason = 'changed' | 'missing' | 'canonical_skipped' | 'no_films' | 'exists';
/** Пакет строгого повтора из файла решений (только для чтения). */
export interface CatalogDecisionsOptions {
  sourceBatchId: number;
  sha256: string;
  createKeys: string[];
  skipped: Array<{ filmId: number | null; catalogKey: string; reason: DecisionSkipReason }>;
}
/** Файл решений (формат erp.film-catalog-decisions) — передаётся backend как есть. */
export interface CatalogDecisionsFile {
  format: 'erp.film-catalog-decisions';
  version: number;
  fingerprintVersion: number;
  sourceBatchId: number;
  exportedAt: string;
  sha256: string;
  rows: unknown[];
  vendors: unknown[];
}
