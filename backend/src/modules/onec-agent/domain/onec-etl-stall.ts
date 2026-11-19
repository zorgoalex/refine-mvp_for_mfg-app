/**
 * «Выгрузка стоит» (incident 12–18.11.2026): the agent is online, but no ETL run has succeeded for a long time. Six days
 * passed unnoticed because only warnings were raised. Pure rule, no SQL.
 */
import type { OnecAgentMode } from './onec-config';

/** At least this long without a successful run (the nightly stop of the 1C machine is ~35 min). */
export const ETL_STALL_MIN_MS = 2 * 60 * 60_000;
/** …and at least this many ETL intervals of the agent's configuration. */
export const ETL_STALL_INTERVALS = 3;

/** ETL is expected to run in these modes (PauseEtl, Drain, Maintenance, Disabled stop it on purpose). */
export function etlExpected(mode: OnecAgentMode | string | null | undefined): boolean {
  return mode === 'Normal' || mode === 'PauseCommands';
}

export function etlStallThresholdMs(etlIntervalMinutes: number | null | undefined): number {
  const interval = Number.isFinite(etlIntervalMinutes) && (etlIntervalMinutes ?? 0) > 0 ? Number(etlIntervalMinutes) : 60;
  return Math.max(ETL_STALL_MIN_MS, ETL_STALL_INTERVALS * interval * 60_000);
}

export interface EtlStallInput {
  now: Date;
  mode: string | null;
  etlIntervalMinutes: number | null;
  /** Completion of the last run with no failed entity; null — none yet. */
  lastSuccessAt: Date | null;
  /** The first run of the agent (the reference point when nothing has succeeded yet); null — no run at all. */
  firstRunAt: Date | null;
}

/** The stall to report, or null: keyed by the last success, so one alert per stall period. */
export function etlStall(input: EtlStallInput): { since: Date; key: string; thresholdMinutes: number } | null {
  if (!etlExpected(input.mode)) return null;
  const threshold = etlStallThresholdMs(input.etlIntervalMinutes);
  const since = input.lastSuccessAt ?? input.firstRunAt;
  if (!since || input.now.getTime() - since.getTime() <= threshold) return null;
  return { since, key: input.lastSuccessAt ? input.lastSuccessAt.toISOString() : 'never', thresholdMinutes: Math.round(threshold / 60_000) };
}

/** After this long of a stall ERP itself sends `etl_reset` (the second safeguard; the agent resets itself at 24 h too). */
export const ETL_AUTO_RESET_AFTER_MS = 24 * 60 * 60_000;
/** The first agent version that executes `etl_reset` (agent-bridge to-erp/0219). */
export const ETL_RESET_MIN_AGENT_VERSION = '1.3.17';

/** `a.b.c` ≥ `min` by numeric parts; an unparsable version — false. */
export function agentVersionAtLeast(version: string | null | undefined, min: string): boolean {
  const parse = (value: string) => value.trim().split('.').map((part) => Number(part));
  if (!version || !/^\d+(\.\d+)*$/.test(version.trim())) return false;
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Send `etl_reset` now: the stall lasts at least 24 h and the agent can execute the command. */
export function etlAutoResetDue(now: Date, since: Date, agentVersion: string | null | undefined): boolean {
  return now.getTime() - since.getTime() >= ETL_AUTO_RESET_AFTER_MS && agentVersionAtLeast(agentVersion, ETL_RESET_MIN_AGENT_VERSION);
}
