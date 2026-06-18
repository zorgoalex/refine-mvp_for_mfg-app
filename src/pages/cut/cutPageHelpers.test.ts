import { describe, expect, it } from 'vitest';
import {
  formatGroupSummary,
  noSheetSpecMessage,
  parseIdCsv,
  pollPdf,
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
});
