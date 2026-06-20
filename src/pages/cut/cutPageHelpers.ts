/** Pure helpers for the /cut page (unit-tested under vitest env=node, no jsdom). */

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

/** Detail ids that may be added to the basket (eligible only). */
export function selectableDetailIds(details: ReadonlyArray<{ orderDetailId: number; eligible: boolean }>): number[] {
  return details.filter((d) => d.eligible).map((d) => d.orderDetailId);
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
  if (waste !== undefined && waste !== null) parts.push(`отход: ${waste}%`);
  return parts.join(', ');
}
