import { describe, expect, it } from 'vitest';
import { onecAlertBalloonSlot, onecAlertGroupOf, onecAlertKindLabel } from './onec-alert-groups';
import { etlStall, etlStallThresholdMs } from './onec-etl-stall';

const now = new Date('2026-11-18T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe('ETL stall (incident 12–18.11.2026)', () => {
  it('threshold: at least 2 h, else 3 ETL intervals', () => {
    expect(etlStallThresholdMs(60)).toBe(3 * 3_600_000);
    expect(etlStallThresholdMs(15)).toBe(2 * 3_600_000);
    expect(etlStallThresholdMs(null)).toBe(3 * 3_600_000);
  });

  it('reports a stall keyed by the last success; none while within the threshold or when ETL is paused on purpose', () => {
    expect(etlStall({ now, mode: 'Normal', etlIntervalMinutes: 60, lastSuccessAt: hoursAgo(2.5), firstRunAt: hoursAgo(100) })).toBeNull();
    expect(etlStall({ now, mode: 'Normal', etlIntervalMinutes: 60, lastSuccessAt: hoursAgo(3.5), firstRunAt: hoursAgo(100) }))
      .toEqual({ since: hoursAgo(3.5), key: hoursAgo(3.5).toISOString(), thresholdMinutes: 180 });
    for (const mode of ['PauseEtl', 'Drain', 'Maintenance', 'Disabled', null]) {
      expect(etlStall({ now, mode, etlIntervalMinutes: 60, lastSuccessAt: hoursAgo(100), firstRunAt: hoursAgo(200) })).toBeNull();
    }
    expect(etlStall({ now, mode: 'PauseCommands', etlIntervalMinutes: 60, lastSuccessAt: hoursAgo(100), firstRunAt: null })?.key).toBe(hoursAgo(100).toISOString());
  });

  it('never succeeded: counted from the first run; no run at all — nothing', () => {
    expect(etlStall({ now, mode: 'Normal', etlIntervalMinutes: 60, lastSuccessAt: null, firstRunAt: hoursAgo(5) })?.key).toBe('never');
    expect(etlStall({ now, mode: 'Normal', etlIntervalMinutes: 60, lastSuccessAt: null, firstRunAt: null })).toBeNull();
  });

  it('the alert kind is listed (sync group) and balloon slots: the agent condition shares one slot per source', () => {
    expect(onecAlertGroupOf('etl_stalled')).toBe('sync');
    expect(onecAlertKindLabel('etl_stalled')).toBe('Выгрузка стоит: давно нет успешного прогона');
    expect(onecAlertBalloonSlot('agent_offline', 1)).toBe('onec_alert:1:agent');
    expect(onecAlertBalloonSlot('agent_state', 1)).toBe('onec_alert:1:agent');
    expect(onecAlertBalloonSlot('sync', 1)).toBe('onec_alert:1:sync');
    expect(onecAlertBalloonSlot('other', null)).toBe('onec_alert:none:other');
  });
});
