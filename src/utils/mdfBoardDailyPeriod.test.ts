import { beforeEach, describe, expect, it } from 'vitest';
import {
  MDF_BOARD_DAY_START_PERIOD,
  mdfBoardDailyPeriodDays,
  readMdfBoardDailyPeriod,
  writeMdfBoardDailyPeriod,
} from './mdfBoardDailyPeriod';
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

describe('MDF board daily period', () => {
  it('a day starts with the current day', () => {
    expect(MDF_BOARD_DAY_START_PERIOD).toBe('1d');
    expect(readMdfBoardDailyPeriod(7, '2026-10-04')).toBe('1d');
  });

  it('keeps the choice until midnight and drops it on the next day', () => {
    writeMdfBoardDailyPeriod(7, '2026-10-04', '2w');
    expect(readMdfBoardDailyPeriod(7, '2026-10-04')).toBe('2w');
    expect(readMdfBoardDailyPeriod(7, '2026-10-05')).toBe('1d');
  });

  it('is kept per user and ignores a broken value', () => {
    writeMdfBoardDailyPeriod(7, '2026-10-04', '1m');
    expect(readMdfBoardDailyPeriod(8, '2026-10-04')).toBe('1d');
    store.set('erp.mdfBoard.period.9', '{"day":"2026-10-04","period":"5y"}');
    expect(readMdfBoardDailyPeriod(9, '2026-10-04')).toBe('1d');
    store.set('erp.mdfBoard.period.9', 'not json');
    expect(readMdfBoardDailyPeriod(9, '2026-10-04')).toBe('1d');
  });

  it('counts days exactly like the board', () => {
    for (const period of ['1d', '1w', '2w', '1m'] as const) {
      expect(mdfBoardDailyPeriodDays(period)).toBe(cncOrderSearchPeriodDays(period));
    }
  });
});
