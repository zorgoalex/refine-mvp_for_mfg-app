import { beforeEach, describe, expect, it } from 'vitest';
import { mdfBoardPeriodDays, readMdfBoardPeriod, writeMdfBoardPeriod } from './mdfBoardDailyPeriod';
import { cncOrderSearchPeriodDays } from '../pages/orderStatusBoard/model';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
  };
});

describe('MDF board remembered period', () => {
  it('has no choice until the user picks one', () => {
    expect(readMdfBoardPeriod(7)).toBeNull();
  });

  it('keeps the last choice, also the one saved with a day by the previous version', () => {
    writeMdfBoardPeriod(7, '2w');
    expect(readMdfBoardPeriod(7)).toBe('2w');
    store.set('erp.mdfBoard.period.7', '{"day":"2026-10-04","period":"1m"}');
    expect(readMdfBoardPeriod(7)).toBe('1m');
  });

  it('is kept per user and ignores a broken value', () => {
    writeMdfBoardPeriod(7, '1m');
    expect(readMdfBoardPeriod(8)).toBeNull();
    store.set('erp.mdfBoard.period.9', '{"period":"5y"}');
    expect(readMdfBoardPeriod(9)).toBeNull();
    store.set('erp.mdfBoard.period.9', 'not json');
    expect(readMdfBoardPeriod(9)).toBeNull();
  });

  it('counts days exactly like the board', () => {
    for (const period of ['1d', '1w', '2w', '1m'] as const) {
      expect(mdfBoardPeriodDays(period)).toBe(cncOrderSearchPeriodDays(period));
    }
  });
});
