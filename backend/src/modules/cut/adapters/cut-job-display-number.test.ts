import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import {
  allocateCutJobSourceDisplayNumber,
  cutJobDisplayNumberKind,
  formatCutJobSourceDisplayNumber,
} from './cut-job-display-number';

describe('cut-job-display-number', () => {
  it('supports numbers above int32 and fails explicitly at safe integer exhaustion', async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [{ next_no: '3000000001' }], rowCount: 1 }) } as unknown as TransactionClient;
    await expect(allocateCutJobSourceDisplayNumber(tx, 'regular')).resolves.toBe('3000000001');
    tx.query = vi.fn().mockResolvedValue({ rows: [{ next_no: '9007199254740992' }], rowCount: 1 });
    await expect(allocateCutJobSourceDisplayNumber(tx, 'regular')).rejects.toMatchObject({ code: 'CUT_JOB_NUMBER_EXHAUSTED' });
  });
  it('formats and classifies regular and vacuum display-number scopes', () => {
    expect(formatCutJobSourceDisplayNumber('regular', 12)).toBe('12');
    expect(formatCutJobSourceDisplayNumber('vacuum', 7)).toBe('В-7');
    expect(cutJobDisplayNumberKind('12')).toBe('regular');
    expect(cutJobDisplayNumberKind('В-7')).toBe('vacuum');
    expect(cutJobDisplayNumberKind('  ')).toBeNull();
  });

  it('allocates regular and vacuum numbers under separate advisory locks', async () => {
    const calls: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        calls.push({ text, params });
        if (text.includes('MAX(substring')) return { rows: [{ next_no: 3 }], rowCount: 1 };
        if (text.includes('MAX(NULLIF')) return { rows: [{ next_no: 9 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as TransactionClient;

    await expect(allocateCutJobSourceDisplayNumber(tx, 'regular')).resolves.toBe('9');
    await expect(allocateCutJobSourceDisplayNumber(tx, 'vacuum')).resolves.toBe('В-3');
    expect(calls.map((call) => call.params[0])).toEqual([
      'cut_job_display_number:regular',
      undefined,
      'cut_job_display_number:vacuum',
      undefined,
    ]);
  });
});
