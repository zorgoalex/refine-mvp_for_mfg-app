import { describe, expect, it } from 'vitest';
import { agentSupportsStockSnapshots, isLocalMoment, startWindowReason } from './onec-stock-snapshot-rules';

const at = (time: string) => new Date(`2026-10-08T${time}:00Z`);

describe('stock snapshot rules', () => {
  it('a moment is a real local date-time without a zone', () => {
    for (const good of ['2026-09-26T10:14:00', '2024-02-29T00:00:00', '2026-12-31T23:59:59']) expect(isLocalMoment(good), good).toBe(true);
    for (const bad of ['2026-09-26 10:14:00', '2026-09-26T10:14', '2026-09-26T10:14:00Z', '2026-02-30T10:00:00', '2025-02-29T00:00:00', '2026-13-01T00:00:00',
      '2026-09-26T24:00:00', '2026-09-26T10:60:00', "2026-09-26T10:14:00'", '']) expect(isLocalMoment(bad), bad).toBe(false);
  });

  it('the agent reads balances as of a moment from 1.3.11', () => {
    expect(['1.3.11', '1.3.12', '1.4.0', '2.0', '1.3.11.1'].map(agentSupportsStockSnapshots)).toEqual([true, true, true, true, true]);
    expect(['1.3.10', '1.3.9', '1.2.99', '0.9', '1.3'].map(agentSupportsStockSnapshots)).toEqual([false, false, false, false, false]);
    // An unknown or unparsable version is «unknown», not «too old».
    expect([null, undefined, '', 'dev', '1.3.11-beta'].map(agentSupportsStockSnapshots)).toEqual([null, null, null, null, null]);
  });

  it('a snapshot does not start in the agent quiet window, around the top of the hour and right before the nightly sync', () => {
    const none = { expectedSilenceUtc: null, nightlyFullSyncHourUtc: null };
    expect(['10:07', '10:30', '10:57'].map((time) => startWindowReason(at(time), none))).toEqual([null, null, null]);
    expect(['10:58', '10:59', '11:00', '11:06'].map((time) => startWindowReason(at(time), none))).toEqual(Array(4).fill('HOURLY_RUN_WINDOW'));
    const quiet = { expectedSilenceUtc: '23:45-00:25', nightlyFullSyncHourUtc: null };
    expect(['23:39', '23:40', '23:45', '23:57', '00:10', '00:24'].map((time) => startWindowReason(at(time), quiet)))
      .toEqual([null, 'AGENT_QUIET_WINDOW', 'AGENT_QUIET_WINDOW', 'AGENT_QUIET_WINDOW', 'AGENT_QUIET_WINDOW', 'AGENT_QUIET_WINDOW']);
    expect(startWindowReason(at('00:25'), quiet)).toBeNull();
    const nightly = { expectedSilenceUtc: null, nightlyFullSyncHourUtc: 21 };
    expect(['20:29', '20:30', '20:45', '20:57', '20:59', '21:00', '21:07'].map((time) => startWindowReason(at(time), nightly)))
      .toEqual([null, 'NIGHTLY_SYNC_WINDOW', 'NIGHTLY_SYNC_WINDOW', 'NIGHTLY_SYNC_WINDOW', 'NIGHTLY_SYNC_WINDOW', 'HOURLY_RUN_WINDOW', null]);
    // A nightly sync at midnight: the lead-in is on the previous day.
    expect(startWindowReason(at('23:40'), { expectedSilenceUtc: null, nightlyFullSyncHourUtc: 0 })).toBe('NIGHTLY_SYNC_WINDOW');
    // A malformed silence setting is ignored.
    expect(startWindowReason(at('23:50'), { expectedSilenceUtc: 'whenever', nightlyFullSyncHourUtc: null })).toBeNull();
  });
});
