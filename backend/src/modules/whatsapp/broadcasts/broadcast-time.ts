import type { DailyDigestCatchUpPolicy } from '../daily-digest.types';

/** Business calendar of the broadcasts: fixed Asia/Almaty (UTC+05:00, no DST). */
export const BUSINESS_OFFSET = '+05:00';
/** Delivery deadline of an automatic run with the `skip` policy (plan §6.2). */
export const SKIP_DELIVERY_GRACE_MINUTES = 30;

export function businessDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function businessClock(now = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now);
}

/** ISO weekday of an ISO date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function clockMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function minutesToClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Minute of a business date as an absolute instant (second and millisecond zero). */
export function zonedMinute(isoDate: string, minutes: number): string {
  return `${isoDate}T${minutesToClock(minutes)}:00.000${BUSINESS_OFFSET}`;
}

export interface FrozenTiming {
  /** Chosen dispatch minute of the day (absolute instant). */
  scheduledAt: Date;
  catchUpPolicy: DailyDigestCatchUpPolicy;
  /** HH:mm, used by `until_deadline`. */
  catchUpDeadline: string;
}

/** Last second at which an automatic run may still be fixed for the day. */
function lastFixSecond(timing: FrozenTiming): string {
  if (timing.catchUpPolicy === 'end_of_day') return '23:59:59';
  if (timing.catchUpPolicy === 'until_deadline') return `${timing.catchUpDeadline}:59`;
  return `${businessClock(timing.scheduledAt).slice(0, 5)}:59`;
}

/** Window state at the moment of fixation (plan §6.2): the decision is taken here, once. */
export function fixationWindowState(timing: FrozenTiming, now: Date): 'before' | 'open' | 'missed' {
  if (now.getTime() < timing.scheduledAt.getTime()) return 'before';
  if (businessDate(now) !== businessDate(timing.scheduledAt)) return 'missed';
  return businessClock(now) <= lastFixSecond(timing) ? 'open' : 'missed';
}

/** Deadline of delivering an automatic run: its catch-up limit, or +30 min for `skip`. */
export function automaticDeliveryDeadline(timing: FrozenTiming, isoDate: string): Date {
  if (timing.catchUpPolicy === 'skip') return new Date(timing.scheduledAt.getTime() + SKIP_DELIVERY_GRACE_MINUTES * 60_000);
  const time = timing.catchUpPolicy === 'end_of_day' ? '23:59:59' : `${timing.catchUpDeadline}:59`;
  return new Date(`${isoDate}T${time}.999${BUSINESS_OFFSET}`);
}
