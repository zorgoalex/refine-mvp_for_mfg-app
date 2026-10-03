// MDF board: the period filter («1 день / 1нед / 2нед / 1м») is remembered per user.
// The date starts from today on every opening and every new day; the period stays as the user left it.
import type { CncOrderSearchPeriod } from '../pages/orderStatusBoard/model';

const STORAGE_PREFIX = 'erp.mdfBoard.period.';
const PERIODS: ReadonlySet<string> = new Set<CncOrderSearchPeriod>(['1d', '1w', '2w', '1m']);

const keyOf = (userId: unknown): string => `${STORAGE_PREFIX}${userId ?? 'anonymous'}`;

/** The period the user picked last, or `null` when nothing was picked yet. */
export function readMdfBoardPeriod(userId: unknown): CncOrderSearchPeriod | null {
  try {
    const raw = window.localStorage.getItem(keyOf(userId));
    const parsed = raw ? JSON.parse(raw) as { period?: unknown } : null;
    if (parsed && typeof parsed.period === 'string' && PERIODS.has(parsed.period)) {
      return parsed.period as CncOrderSearchPeriod;
    }
  } catch {
    // no storage or a broken value: the board uses its default period
  }
  return null;
}

/** Remembers the user's choice. */
export function writeMdfBoardPeriod(userId: unknown, period: CncOrderSearchPeriod): void {
  try {
    window.localStorage.setItem(keyOf(userId), JSON.stringify({ period }));
  } catch {
    // the choice then lives only in the page address until the tab is reopened
  }
}

/** Days shown for a period; mirrors `cncOrderSearchPeriodDays` without pulling the board model into the shell. */
export function mdfBoardPeriodDays(period: CncOrderSearchPeriod): number {
  if (period === '1d') return 1;
  if (period === '2w') return 14;
  if (period === '1m') return 31;
  return 7;
}
