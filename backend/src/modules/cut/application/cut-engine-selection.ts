import type { FreecutParams } from './cut-freecut-mapping';

/**
 * Per-group solver-engine selection (plan 2026-07-13-cut-engine-heuristic).
 * Evidence: freecut-engine-replay-2026-07-13 — heuristic+max saves a sheet on
 * large jobs (185 details: 14->13 sheets) and matches GA on small ones.
 *
 * Priority: vacuum profile (engines not applicable) > explicit profile engine
 * > auto threshold (group instance count) > default GA (today's behavior).
 * The threshold is env-driven (BACKEND_CUT_HEURISTIC_AUTO_THRESHOLD, 0 = off)
 * and intentionally NOT part of request_hash: flipping the env must not
 * invalidate outbox idempotency. Explicit profile engine/cut_quality flow
 * through params and thus into the hash automatically.
 */
export type EngineUsed = 'ga' | 'heuristic' | 'vacuum_table';
export type EngineReason = 'vacuum' | 'profile_engine' | 'auto_threshold' | 'default_ga';

export interface EngineSelection {
  params: FreecutParams;
  engineUsed: EngineUsed;
  engineReason: EngineReason;
}

export function applyEngineSelection(
  params: FreecutParams,
  totalInstances: number,
  autoThresholdInstances: number,
): EngineSelection {
  if (params.layout_mode === 'vacuum_table') {
    // Runtime backstop for profiles switched to vacuum after engine fields were saved.
    if (params.engine !== undefined || params.cut_quality !== undefined) {
      const { engine: _engine, cut_quality: _cutQuality, ...rest } = params;
      return { params: rest, engineUsed: 'vacuum_table', engineReason: 'vacuum' };
    }
    return { params, engineUsed: 'vacuum_table', engineReason: 'vacuum' };
  }

  if (params.engine === 'heuristic') {
    return {
      params: { ...params, engine: 'heuristic', cut_quality: params.cut_quality ?? 'max' },
      engineUsed: 'heuristic',
      engineReason: 'profile_engine',
    };
  }

  if (params.engine === 'ga') {
    return { params, engineUsed: 'ga', engineReason: 'profile_engine' };
  }

  if (autoThresholdInstances > 0 && totalInstances >= autoThresholdInstances) {
    return {
      params: { ...params, engine: 'heuristic', cut_quality: 'max' },
      engineUsed: 'heuristic',
      engineReason: 'auto_threshold',
    };
  }

  return { params, engineUsed: 'ga', engineReason: 'default_ga' };
}
