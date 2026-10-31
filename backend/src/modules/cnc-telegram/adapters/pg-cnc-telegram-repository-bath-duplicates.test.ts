import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { mdfBathDuplicatesReadEnabled } from '../../orders/adapters/mdf-bath-duplicate-facts';
import type { CncTelegramTodayResponseDto } from '../dto/cnc-telegram.dto';
import { withBathDuplicates } from './pg-cnc-telegram-repository';

describe('MDF board: bath duplicates read', () => {
  const previous = process.env.BACKEND_MDF_BATH_DUPLICATES_READ;
  afterEach(() => {
    if (previous === undefined) delete process.env.BACKEND_MDF_BATH_DUPLICATES_READ;
    else process.env.BACKEND_MDF_BATH_DUPLICATES_READ = previous;
  });

  it('is off unless BACKEND_MDF_BATH_DUPLICATES_READ=true', () => {
    delete process.env.BACKEND_MDF_BATH_DUPLICATES_READ;
    expect(mdfBathDuplicatesReadEnabled()).toBe(false);
    process.env.BACKEND_MDF_BATH_DUPLICATES_READ = 'false';
    expect(mdfBathDuplicatesReadEnabled()).toBe(false);
    process.env.BACKEND_MDF_BATH_DUPLICATES_READ = 'true';
    expect(mdfBathDuplicatesReadEnabled()).toBe(true);
  });

  it('attaches the lists to every shown bath only behind the flag, bounded to the shown baths', () => {
    const source = readFileSync(new URL('./pg-cnc-telegram-repository.ts', import.meta.url), 'utf8');
    expect(source).toContain('const duplicatesPromise = mdfBathDuplicatesReadEnabled() ? loadBoardBathDuplicates(');
    expect(source).toContain('return duplicatesPromise ? withBathDuplicates(withDigests, await duplicatesPromise) : withDigests;');
    expect(source).toContain('{ presentationDigests: true, engineOwnsBoard: true }');
    expect(source).toContain('{ engineOwnsBoard: false }');
  });

  it('gives every bath both lists (empty when none) and keeps other cards untouched', () => {
    const bath = (id: string) => ({ bathCardId: id, items: [], sheets: [] }) as never;
    const today = { workday: '2026-10-30', generatedAt: '', columns: [{ key: 'baths', title: 'Ванны', total: 2,
      packets: [], bazisCutSets: [], baths: [bath('cut-result:854'), bath('cut-result:868')] }] } as CncTelegramTodayResponseDto;
    const duplicate = { otherBathCardId: 'cut-result:868', otherJobLabel: null, shared: [], sharedCount: 2,
      coveredBy: true, archivable: false, blockedReason: 'engine' as const, digest: 'd'.repeat(64), resolvedAction: null };
    const result = withBathDuplicates(today, new Map([['cut-result:854', { duplicates: [duplicate], reworkMarks: [],
      reworkDetailCount: 0 }]]));
    expect(result.columns[0].baths[0]).toMatchObject({ duplicates: [duplicate], reworkMarks: [] });
    expect(result.columns[0].baths[1]).toMatchObject({ duplicates: [], reworkMarks: [], reworkDetailCount: 0 });
  });
});
