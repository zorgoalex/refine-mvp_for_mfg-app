import { describe, expect, it } from 'vitest';
import {
  buildCutAddWarning,
  formatPlacementsMessage,
  CUT_JOB_STATUS_FILTER_ALL,
  cutJobCounts,
  cutJobSourceLabel,
  cutJobStatusLabel,
  filterJobsByStatus,
  formatGroupSummary,
  noSheetSpecMessage,
  parseIdCsv,
  pollPdf,
  restrictDetailIds,
  selectableDetailIds,
} from './cutPageHelpers';

describe('cutPageHelpers', () => {
  it('parses a CSV of positive ids, dropping noise', () => {
    expect(parseIdCsv('9, 10, x, -3, 0, 11')).toEqual([9, 10, 11]);
    expect(parseIdCsv('')).toEqual([]);
    expect(parseIdCsv('  ')).toEqual([]);
  });

  it('builds a prominent no_sheet_spec operator message only when count > 0', () => {
    expect(noSheetSpecMessage(0)).toBeNull();
    const msg = noSheetSpecMessage(3);
    expect(msg).toContain('3');
    expect(msg?.toLowerCase()).toContain('специфика');
  });

  it('returns only the eligible detail ids as selectable', () => {
    const details = [
      { orderDetailId: 1, eligible: true },
      { orderDetailId: 2, eligible: false },
      { orderDetailId: 3, eligible: true },
    ];
    expect(selectableDetailIds(details)).toEqual([1, 3]);
  });

  it('formats a freecut group summary compactly', () => {
    expect(formatGroupSummary({ used_stock_count: 2, waste_percent: 12.5 })).toContain('2');
    expect(formatGroupSummary(null)).toBe('');
  });

  it('pollPdf retries on a cold-cache 202 and resolves once the PDF is ready', async () => {
    const blob = new Blob(['%PDF-1']);
    let calls = 0;
    const sleeps: number[] = [];
    const result = await pollPdf(
      async () => {
        calls += 1;
        return calls < 3 ? { pending: true } : { pending: false, blob, fileName: 'cut.pdf' };
      },
      { maxAttempts: 5, delayMs: 10, sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(result.pending).toBe(false);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 10]); // slept between the two pending attempts
  });

  it('pollPdf throws after exhausting attempts while still pending', async () => {
    await expect(
      pollPdf(async () => ({ pending: true }), { maxAttempts: 2, delayMs: 1, sleep: async () => {} }),
    ).rejects.toThrow(/PDF/);
  });

  it('maps cut job status codes to Russian labels, passing unknown through', () => {
    expect(cutJobStatusLabel('draft')).toBe('Черновик');
    expect(cutJobStatusLabel('ready')).toBe('Готов');
    expect(cutJobStatusLabel('archived')).toBe('Архив');
    expect(cutJobStatusLabel('weird')).toBe('weird');
  });

  it('maps cut job source codes to Russian labels, passing unknown through', () => {
    expect(cutJobSourceLabel('manual')).toBe('Ручной');
    expect(cutJobSourceLabel('api')).toBe('API');
    expect(cutJobSourceLabel('other')).toBe('other');
  });

  it('filters jobs by status, with "all" returning a copy of the list', () => {
    const jobs = [
      { status: 'draft' },
      { status: 'ready' },
      { status: 'draft' },
    ];
    expect(filterJobsByStatus(jobs, 'draft')).toEqual([{ status: 'draft' }, { status: 'draft' }]);
    expect(filterJobsByStatus(jobs, CUT_JOB_STATUS_FILTER_ALL)).toEqual(jobs);
    expect(filterJobsByStatus(jobs, CUT_JOB_STATUS_FILTER_ALL)).not.toBe(jobs);
    expect(filterJobsByStatus(jobs, '')).toEqual(jobs);
  });

  it('builds a reason-aware add-to-cut warning (no_sheet_spec / wrong_status counts)', () => {
    expect(buildCutAddWarning([{ eligible: false, ineligibleReason: 'no_sheet_spec' }])).toMatch(/специфика/);
    const mixed = buildCutAddWarning([
      { eligible: false, ineligibleReason: 'no_sheet_spec' },
      { eligible: false, ineligibleReason: 'wrong_status' },
    ]);
    expect(mixed).toMatch(/без раскройной спецификации материала: 1/);
    expect(mixed).toMatch(/неподходящий статус: 1/);
    expect(buildCutAddWarning([])).toBe('Нет подходящих деталей для раскроя');
  });

  it('formats an informational placements message (never blocking)', () => {
    expect(
      formatPlacementsMessage({ jobs: [{ cutJobId: 1, name: 'Раскрой A' }, { cutJobId: 5, name: 'B' }], hasArchived: false }),
    ).toMatch(/#1 Раскрой A.*#5 B/);
    const archived = formatPlacementsMessage({ jobs: [], hasArchived: true });
    expect(archived).toMatch(/архивных заданиях/);
    expect(formatPlacementsMessage({ jobs: [], hasArchived: false })).toBeNull();
    expect(
      formatPlacementsMessage({ jobs: [{ cutJobId: 1, name: 'A' }], hasArchived: false }),
    ).toMatch(/не ограничено/);
  });

  it('counts job items and groups defensively', () => {
    expect(cutJobCounts({ items: [1, 2], groups: [1] })).toEqual({ items: 2, groups: 1 });
    expect(cutJobCounts({})).toEqual({ items: 0, groups: 0 });
  });

  it('restrictDetailIds intersects eligible with chosen (eligible order, distinct)', () => {
    expect(restrictDetailIds([3, 1, 2], [2, 3])).toEqual([3, 2]);
    expect(restrictDetailIds([1, 2, 3], [])).toEqual([]);
    expect(restrictDetailIds([1, 2], [5, 6])).toEqual([]);
    expect(restrictDetailIds([1, 1, 2], [1, 2])).toEqual([1, 2]);
  });
});
