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
