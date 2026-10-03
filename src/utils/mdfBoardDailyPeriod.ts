// MDF board: the period filter («1 день / 1нед / 2нед / 1м») lives for one calendar day.
// A new day starts with the current day; what the user picks stays until midnight.
import type { CncOrderSearchPeriod } from '../pages/orderStatusBoard/model';

const STORAGE_PREFIX = 'erp.mdfBoard.period.';
const PERIODS: ReadonlySet<string> = new Set<CncOrderSearchPeriod>(['1d', '1w', '2w', '1m']);

/** Period every new day starts with. */
export const MDF_BOARD_DAY_START_PERIOD: CncOrderSearchPeriod = '1d';

const keyOf = (userId: unknown): string => `${STORAGE_PREFIX}${userId ?? 'anonymous'}`;

/** The period the user picked today, or the day-start period when nothing was picked today. */
export function readMdfBoardDailyPeriod(userId: unknown, today: string): CncOrderSearchPeriod {
  try {
    const raw = window.localStorage.getItem(keyOf(userId));
    const parsed = raw ? JSON.parse(raw) as { day?: unknown; period?: unknown } : null;
    if (parsed && parsed.day === today && typeof parsed.period === 'string' && PERIODS.has(parsed.period)) {
      return parsed.period as CncOrderSearchPeriod;
    }
  } catch {
    // no storage or a broken value: the day simply starts from the current day
  }
  return MDF_BOARD_DAY_START_PERIOD;
}

/** Remembers the user's choice for the rest of `today`. */
export function writeMdfBoardDailyPeriod(userId: unknown, today: string, period: CncOrderSearchPeriod): void {
  try {
    window.localStorage.setItem(keyOf(userId), JSON.stringify({ day: today, period }));
  } catch {
    // the choice then lives only in the page address until the tab is reopened
  }
}

/** Days shown for a period; mirrors `cncOrderSearchPeriodDays` without pulling the board model into the shell. */
export function mdfBoardDailyPeriodDays(period: CncOrderSearchPeriod): number {
  if (period === '1d') return 1;
  if (period === '2w') return 14;
  if (period === '1m') return 31;
  return 7;
}
