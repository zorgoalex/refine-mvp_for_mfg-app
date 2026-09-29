import type { CatalogDecisionsFile } from '../../../api/types/filmCatalogImportApi.types';
import { detectCatalogHeader, extractCatalogRows, validateCatalogRows } from '@shared/film-catalog';
import type { CatalogImportAction, CatalogImportErrorDto, CatalogRowInput } from '../../../api/types/filmCatalogImportApi.types';

export interface CatalogSheetPreview {
  name: string; rows: CatalogRowInput[]; validCount: number; errorCount: number;
}

/** Select matching worksheets in browser; no workbook bytes or derived fields go to API. */
export function inspectCatalogSheets(sheets: Array<{ name: string; rows: ReadonlyArray<ReadonlyArray<unknown>> }>): CatalogSheetPreview[] {
  return sheets.flatMap(({ name, rows }) => {
    const header = detectCatalogHeader(rows);
    if (!header) return [];
    const input = extractCatalogRows(rows, header);
    const validated = validateCatalogRows(input);
    return [{ name, rows: input, validCount: validated.filter((row) => row.rowStatus === 'ok').length,
      errorCount: validated.filter((row) => row.rowStatus === 'invalid').length }];
  });
}

export interface CatalogMatchFilters { status?: string; vendorId?: number; search?: string; rowId?: number; offset: number; limit: number }
export function catalogMatchQuery(filters: CatalogMatchFilters): Record<string, string | number | undefined> {
  return { status: filters.status || undefined, vendorId: filters.vendorId, search: filters.search?.trim() || undefined,
    rowId: filters.rowId, offset: Math.max(0, filters.offset), limit: Math.min(500, Math.max(1, filters.limit)) };
}

export function catalogRowsQuery(input: { status?: string; conflict?: boolean; search?: string; offset: number; limit: number }) {
  return { status: input.status || undefined, conflict: input.conflict || undefined, search: input.search?.trim() || undefined,
    offset: Math.max(0, input.offset), limit: Math.min(500, Math.max(1, input.limit)) };
}

export function vendorMappingAction(supplierNorm: string, vendorId: number | null): CatalogImportAction {
  return vendorId === null ? { type: 'createVendor', supplierNorm } : { type: 'setVendor', supplierNorm, vendorId };
}

export const catalogImportActions = {
  acceptAllAuto: (): CatalogImportAction => ({ type: 'acceptAllAuto' }),
  setMatch: (filmId: number, rowId: number | null): CatalogImportAction => ({ type: 'setMatch', filmId, rowId }),
  confirmMatch: (filmId: number): CatalogImportAction => ({ type: 'confirmMatch', filmId }),
  setCanonical: (rowId: number, filmId: number): CatalogImportAction => ({ type: 'setCanonical', rowId, filmId }),
  setCanonicalProperties: (rowId: number, filmTexture: boolean, filmTypeId: number): CatalogImportAction => ({ type: 'setCanonicalProperties', rowId, filmTexture, filmTypeId }),
  setCreateMissing: (createMissing: boolean): CatalogImportAction => ({ type: 'setOption', createMissing }),
};

export interface PendingIdempotencyKey { signature: string; key: string }
export function resolveIdempotencyKey(
  pending: PendingIdempotencyKey | null,
  signature: string,
  createKey: () => string,
): PendingIdempotencyKey {
  return pending?.signature === signature ? pending : { signature, key: createKey() };
}

export function importManageAllowed(permissions: readonly string[] | undefined): boolean {
  return (permissions ?? []).includes('references.manage');
}
export function onecMirrorAllowed(permissions: readonly string[] | undefined): boolean {
  return (permissions ?? []).includes('onec.view');
}
export function filmReferenceViewAllowed(permissions: readonly string[] | undefined): boolean {
  return (permissions ?? []).includes('references.view');
}

export function catalogImportErrorMessage(error: unknown): { message: string; details: string[]; reload: boolean } {
  const value = (error ?? {}) as CatalogImportErrorDto;
  const details = value.details && typeof value.details === 'object'
    ? Object.values(value.details as Record<string, unknown>).flatMap((entry) =>
      Array.isArray(entry) ? entry.map(formatDetail) : typeof entry === 'string' ? [entry] : [],
    ) : [];
  if (value.code === 'CATALOG_IMPORT_STALE') return { message: 'Пакет изменён другим пользователем. Данные обновлены.', details, reload: true };
  if (['CATALOG_IMPORT_CONFLICT', 'CATALOG_IMPORT_REVERT_BLOCKED', 'CATALOG_IMPORT_UNRESOLVED'].includes(value.code ?? '')) {
    return { message: value.message ?? 'Операция требует внимания.', details, reload: false };
  }
  return { message: value.message ?? 'Не удалось выполнить операцию.', details, reload: false };
}

function formatDetail(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value);
  const item = value as Record<string, unknown>;
  return [item.reason, item.message, item.filmId && `Плёнка ${item.filmId}`, item.rowId && `Строка ${item.rowId}`].filter(Boolean).join(' — ');
}

export async function sha256File(file: Pick<File, 'arrayBuffer'>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const PAGE_SIZE_OPTIONS = [20, 50, 100, 200];

/** Серверная пагинация по offset: смена размера страницы возвращает на первую страницу. */
export function serverPagination(
  offset: number,
  pageSize: number,
  total: number,
  setOffset: (offset: number) => void,
  setPageSize: (pageSize: number) => void,
) {
  return {
    current: Math.floor(offset / pageSize) + 1,
    pageSize,
    total,
    showSizeChanger: true,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    onChange: (page: number, size: number) => {
      if (size !== pageSize) {
        setPageSize(size);
        setOffset(0);
        return;
      }
      setOffset((page - 1) * size);
    },
  };
}

export const DECISIONS_SKIP_LABELS: Record<string, string> = {
  changed: 'плёнка изменена после выгрузки',
  missing: 'плёнки нет в этой базе',
  canonical_skipped: 'основная плёнка изменена — позиция не применяется',
  no_films: 'плёнки позиции изменены или отсутствуют — позиция не применяется',
  exists: 'позиция уже есть в справочнике — не создаётся',
};

/** Разбор файла решений из JSON-текста; ошибка — понятное сообщение. */
export function readDecisionsFile(text: string): CatalogDecisionsFile {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Файл не является JSON'); }
  const file = parsed as Partial<CatalogDecisionsFile> | null;
  if (!file || typeof file !== 'object' || file.format !== 'erp.film-catalog-decisions') {
    throw new Error('Это не файл решений импорта каталога 1С');
  }
  // Поля предпросмотра и отправки — с проверкой типов (полная проверка — на backend).
  const valid = typeof file.version === 'number' && typeof file.fingerprintVersion === 'number'
    && typeof file.sourceBatchId === 'number' && typeof file.exportedAt === 'string'
    && typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256)
    && Array.isArray(file.rows) && Array.isArray(file.vendors);
  if (!valid) throw new Error('Файл решений повреждён: не хватает обязательных полей');
  return file as CatalogDecisionsFile;
}

export function decisionsDownloadName(batchId: number): string {
  return `решения-каталога-1С-пакет-${batchId}.json`;
}

export function isDecisionsBatch(batch: { options: { decisions?: unknown } } | null | undefined): boolean {
  return Boolean(batch?.options?.decisions);
}

export function sourceLabel(batch: { sourceKind: string; fileName: string | null }): string {
  if (batch.sourceKind === 'file' && batch.fileName?.startsWith('decisions:')) return 'Файл решений';
  return batch.sourceKind === 'file' ? 'Файл' : 'Зеркало 1С';
}
