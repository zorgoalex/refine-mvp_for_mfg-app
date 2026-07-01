/** Pure helpers for the /cut page (unit-tested under vitest env=node, no jsdom). */

import { parseCutPieceDetailId } from './cutPreviewHelpers';

/**
 * Builds a filmTexture lookup map for SheetEditor.
 * For each piece in the working sheets, resolves the detail via job.items
 * to decide whether it has a textured film (grain-locked → no rotation).
 * Keyed by piece.item_id.
 */
export function buildFilmTextureMap(
  sheets: ReadonlyArray<{ placements: { pieces: ReadonlyArray<{ item_id: string }> } }>,
  items: ReadonlyArray<{ orderDetailId: number; detail: { filmTexture: boolean | null } | null }>,
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const sheet of sheets) {
    for (const piece of sheet.placements.pieces) {
      if (map.has(piece.item_id)) continue;
      const detailId = parseCutPieceDetailId(piece.item_id);
      if (detailId === null) {
        map.set(piece.item_id, false);
        continue;
      }
      const item = items.find((it) => it.orderDetailId === detailId);
      map.set(piece.item_id, Boolean(item?.detail?.filmTexture));
    }
  }
  return map;
}

/**
 * Drops sheets left empty after a cross-sheet move — empty sheets are not wanted
 * in a cut group. Preserves the real sheetIndex of surviving sheets (NO renumber,
 * so the moves still validate against the auto stock on save); mirrors the backend
 * reconstructManualSheets. Never returns an empty array: if every sheet is empty
 * (should not happen — a move always lands a piece somewhere) the input is returned
 * unchanged as a defensive fallback.
 */
export function pruneEmptySheets<T extends { placements: { pieces: ReadonlyArray<unknown> } }>(
  sheets: ReadonlyArray<T>,
): T[] {
  const pruned = sheets.filter((s) => s.placements.pieces.length > 0);
  return pruned.length > 0 ? pruned : [...sheets];
}

/** Parse a `?job=<id>` deep-link param into a positive cut job id, or null. */
export function parseJobQueryParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('job');
  if (raw === null) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Parse a CSV like "9, 10, x" into distinct positive integer ids. */
export function parseIdCsv(input: string): number[] {
  const ids = input
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)];
}

/**
 * Operator-facing message surfaced prominently when details are blocked only
 * because their material has no sheet spec (plan §5, Critic MAJOR-4). Null when
 * nothing is blocked for that reason.
 */
export function noSheetSpecMessage(noSheetSpecCount: number): string | null {
  if (noSheetSpecCount <= 0) return null;
  return `${noSheetSpecCount} деталей без раскройной спецификации материала — задайте её в Конфигурации`;
}

/**
 * Distinct order ids of the details already reserved into a job, in first-seen
 * order. Used to prefill the eligible-load criteria on open so "Загрузить
 * подходящие детали" is scoped to the order(s) the job was actually built from,
 * instead of scanning every order (the stored selection_criteria is not exposed
 * on the job DTO, so the reserved items are the source of truth).
 */
export function distinctOrderIdsFromItems(items: ReadonlyArray<{ orderId: number }>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const item of items) {
    if (Number.isInteger(item.orderId) && item.orderId > 0 && !seen.has(item.orderId)) {
      seen.add(item.orderId);
      out.push(item.orderId);
    }
  }
  return out;
}

/**
 * Fail-closed href sanitizer for operator-clickable detail links. Stored order
 * link_* fields are only `z.string().url()`-validated upstream, which accepts
 * `javascript:`/`data:` URIs — rendering those as live anchors on the cut screen
 * would be stored-link XSS. Returns the href only for absolute http(s) or
 * app-relative ("/...") links; everything else (any non-http scheme, protocol-
 * relative "//", bare/unknown forms) collapses to null so the caller renders
 * plain, non-clickable text instead.
 */
export function safeHttpHref(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('//')) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // non-http scheme -> reject
  if (trimmed.startsWith('/')) return trimmed; // app-relative path
  return null; // unknown bare form -> fail closed
}

/** Detail ids that may be added to the basket (eligible only). */
export function selectableDetailIds(details: ReadonlyArray<{ orderDetailId: number; eligible: boolean }>): number[] {
  return details.filter((d) => d.eligible).map((d) => d.orderDetailId);
}

/**
 * Reason-aware warning when nothing can be added to a cut job. Instead of a flat
 * "нет подходящих деталей", it explains WHY each candidate was rejected (notably
 * "уже в раскрое" for already-reserved details), counting per reason.
 */
export function buildCutAddWarning(
  candidates: ReadonlyArray<{ eligible: boolean; ineligibleReason: string | null }>,
): string {
  const ineligible = candidates.filter((c) => !c.eligible);
  const count = (reason: string) => ineligible.filter((c) => c.ineligibleReason === reason).length;
  const parts: string[] = [];
  const noSpec = count('no_sheet_spec');
  const wrongStatus = count('wrong_status');
  const deleted = count('deleted');
  if (noSpec) parts.push(`без раскройной спецификации материала: ${noSpec}`);
  if (wrongStatus) parts.push(`неподходящий статус: ${wrongStatus}`);
  if (deleted) parts.push(`удалены: ${deleted}`);
  if (parts.length === 0) return 'Нет подходящих деталей для раскроя';
  return `Нет деталей, готовых к раскрою (${parts.join(', ')})`;
}

/**
 * Informational note for the add-to-cut modal: where the chosen details are ALREADY
 * placed. Placement never blocks adding (multi-job allowed) — this only informs.
 * Active jobs are listed by #id + name; archived placements collapse to one note.
 * Returns null when the details are not in any job.
 */
export function formatPlacementsMessage(
  placements: { jobs: ReadonlyArray<{ cutJobId: number; name: string }>; hasArchived: boolean },
): string | null {
  const segments: string[] = [];
  if (placements.jobs.length > 0) {
    const list = placements.jobs.map((j) => `#${j.cutJobId} ${j.name}`).join(', ');
    segments.push(`Эти детали уже есть в заданиях: ${list}.`);
  }
  if (placements.hasArchived) {
    segments.push('Часть деталей в архивных заданиях.');
  }
  if (segments.length === 0) return null;
  segments.push('Добавление не ограничено — деталь может быть в нескольких заданиях.');
  return segments.join(' ');
}

/**
 * Detail-level "add to cut": keep only the operator-chosen detail ids that are
 * also eligible. Order follows `selectableEligible`; result is distinct.
 */
export function restrictDetailIds(selectableEligible: number[], chosen: number[]): number[] {
  const chosenSet = new Set(chosen);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of selectableEligible) {
    if (chosenSet.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export type PdfFetchResult = { pending: true } | { pending: false; blob: Blob; fileName: string | null };

export interface PollPdfOptions {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll an on-demand PDF endpoint that answers 202 (`{ pending: true }`) on a
 * cold cache (plan §7/§8). Retries up to `maxAttempts`, sleeping between tries,
 * and resolves with the ready result. The sleep is injectable so the polling
 * loop is unit-testable without timers. Throws if still pending after the cap.
 */
export async function pollPdf(
  fetchPdf: () => Promise<PdfFetchResult>,
  options: PollPdfOptions = {},
): Promise<Exclude<PdfFetchResult, { pending: true }>> {
  const maxAttempts = options.maxAttempts ?? 6;
  const delayMs = options.delayMs ?? 1500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await fetchPdf();
    if (!result.pending) return result;
    if (attempt < maxAttempts - 1) await sleep(delayMs);
  }
  throw new Error('PDF готовится — попробуйте ещё раз через несколько секунд');
}

/** Trigger a browser download of a blob (DOM side-effect; not unit-tested). */
export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Russian labels for cut_job.status (chk_cut_job_status: draft/calculating/ready/failed/archived). */
export const CUT_JOB_STATUS_LABELS: Record<string, string> = {
  draft: 'Черновик',
  calculating: 'Расчёт',
  ready: 'Готов',
  failed: 'Ошибка',
  archived: 'Архив',
};

/** Human label for a cut_job status; unknown codes are passed through verbatim. */
export function cutJobStatusLabel(status: string): string {
  return CUT_JOB_STATUS_LABELS[status] ?? status;
}

/** Russian labels for cut_job.source (chk_cut_job_source: manual/auto/api). */
export const CUT_JOB_SOURCE_LABELS: Record<string, string> = {
  manual: 'Ручной',
  auto: 'Авто',
  api: 'API',
};

/** Human label for a cut_job source; unknown codes are passed through verbatim. */
export function cutJobSourceLabel(source: string): string {
  return CUT_JOB_SOURCE_LABELS[source] ?? source;
}

/** Pseudo-status used by the list filter to mean "show everything". */
export const CUT_JOB_STATUS_FILTER_ALL = 'all';

/** Status filter options for the job list (the backend already excludes archived). */
export const CUT_JOB_STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: CUT_JOB_STATUS_FILTER_ALL, label: 'Все статусы' },
  { value: 'draft', label: CUT_JOB_STATUS_LABELS.draft },
  { value: 'calculating', label: CUT_JOB_STATUS_LABELS.calculating },
  { value: 'ready', label: CUT_JOB_STATUS_LABELS.ready },
  { value: 'failed', label: CUT_JOB_STATUS_LABELS.failed },
];

/** Filter a job list by status; `all` (or empty) returns the list unchanged. */
export function filterJobsByStatus<T extends { status: string }>(jobs: ReadonlyArray<T>, status: string): T[] {
  if (!status || status === CUT_JOB_STATUS_FILTER_ALL) return [...jobs];
  return jobs.filter((job) => job.status === status);
}

/** Item/group counts for a job-list row (items reserved, groups computed). */
export function cutJobCounts(job: { items?: unknown[]; groups?: unknown[] }): { items: number; groups: number } {
  return { items: job.items?.length ?? 0, groups: job.groups?.length ?? 0 };
}

/** Compact one-line freecut group summary for display. */
export function formatGroupSummary(summary: Record<string, unknown> | null): string {
  if (!summary) return '';
  const sheets = summary.used_stock_count;
  const waste = summary.waste_percent;
  const parts: string[] = [];
  if (sheets !== undefined && sheets !== null) parts.push(`листов: ${sheets}`);
  if (waste !== undefined && waste !== null) {
    const roundedWaste = Math.round(Number(waste));
    parts.push(`остаток: ${Number.isFinite(roundedWaste) ? roundedWaste : waste}%`);
  }
  return parts.join(', ');
}
