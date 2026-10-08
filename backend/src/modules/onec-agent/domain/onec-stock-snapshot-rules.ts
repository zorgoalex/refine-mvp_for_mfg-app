import { parseExpectedSilence } from './onec-expected-silence';

/** The first agent version that reads balances as of a moment (agent to-erp/0172). */
export const STOCK_SNAPSHOT_MIN_AGENT_VERSION = '1.3.11';
/** The agent must take the published version within this time, or the snapshot fails. */
export const CONFIG_APPLY_TIMEOUT_MS = 10 * 60_000;
/** Delivery deadline of the read command. */
export const COMMAND_DELIVERY_TIMEOUT_MS = 10 * 60_000;
/** One deadline for every unfinished branch of reading: no result, no run, a run that never completes. */
export const SYNC_DEADLINE_MS = 60 * 60_000;
/** ETL commands and runs open longer than this are stuck: they no longer hold back new snapshots. */
export const STALE_ACTIVITY_MS = 60 * 60_000;
/** A slot that cannot be released or switched off for this long raises an alert. */
export const SLOT_STUCK_MS = 15 * 60_000;
/** Minutes around the top of the hour left to the clock run of the agent. */
const HOURLY_FROM_MINUTE = 58;
const HOURLY_TO_MINUTE = 6;
/** No new snapshot this long before the nightly full sync starts. */
const NIGHTLY_LEAD_MINUTES = 30;
/** No new snapshot this long before the expected silence of the agent begins. */
const SILENCE_LEAD_MINUTES = 5;

export type StockSnapshotWaitReason =
  | 'AGENT_OFFLINE' | 'AGENT_TOO_OLD' | 'CONFIG_PUBLISH_BLOCKED' | 'AGENT_QUIET_WINDOW' | 'HOURLY_RUN_WINDOW' | 'NIGHTLY_SYNC_WINDOW'
  | 'AGENT_BUSY' | 'QUEUED';

const MOMENT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** `YYYY-MM-DDTHH:MM:SS` of a real calendar moment (no zone: local time of the 1C base). */
export function isLocalMoment(value: string): boolean {
  const match = MOMENT.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  if (hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Numeric comparison of dotted versions; anything that is not `n.n.n…` is «unknown» (null). */
export function agentSupportsStockSnapshots(version: string | null | undefined): boolean | null {
  const parse = (value: string) => (/^\d+(\.\d+){0,3}$/.test(value) ? value.split('.').map(Number) : null);
  const have = version ? parse(version.trim()) : null;
  if (!have) return null;
  const need = parse(STOCK_SNAPSHOT_MIN_AGENT_VERSION)!;
  for (let index = 0; index < Math.max(have.length, need.length); index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/**
 * A reason not to START a snapshot at `now` because of the clock (null — the clock allows it): the expected
 * silence of the agent (and a few minutes before it), the minutes of the hourly clock run, the lead-in of the
 * nightly full sync. What happens after the nightly sync starts is covered by «the agent is busy».
 */
export function startWindowReason(now: Date, input: { expectedSilenceUtc: string | null; nightlyFullSyncHourUtc: number | null }): StockSnapshotWaitReason | null {
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const silence = parseExpectedSilence(input.expectedSilenceUtc);
  if (silence) {
    const sinceLeadIn = (minuteOfDay - (silence.startMinute - SILENCE_LEAD_MINUTES) + 2880) % 1440;
    if (sinceLeadIn < silence.lengthMinutes + SILENCE_LEAD_MINUTES) return 'AGENT_QUIET_WINDOW';
  }
  if (input.nightlyFullSyncHourUtc !== null) {
    const untilNightly = (input.nightlyFullSyncHourUtc * 60 - minuteOfDay + 1440) % 1440;
    if (untilNightly > 0 && untilNightly <= NIGHTLY_LEAD_MINUTES) return 'NIGHTLY_SYNC_WINDOW';
  }
  const minute = now.getUTCMinutes();
  if (minute >= HOURLY_FROM_MINUTE || minute <= HOURLY_TO_MINUTE) return 'HOURLY_RUN_WINDOW';
  return null;
}
