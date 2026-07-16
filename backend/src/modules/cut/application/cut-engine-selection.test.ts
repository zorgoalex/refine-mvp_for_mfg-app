import { describe, expect, it } from 'vitest';
import { applyEngineSelection } from './cut-engine-selection';
import type { FreecutParams } from './cut-freecut-mapping';

const BASE: FreecutParams = {
  kerf_mm: 2,
  spacing_mm: 1,
  trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
  objective: 'min_waste',
  time_limit_ms: 1200,
  restarts: 5,
  layout_mode: 'guillotine',
  retry_strategy: 'disabled',
};

describe('applyEngineSelection', () => {
  it('vacuum profile is untouched regardless of size', () => {
    const sel = applyEngineSelection({ ...BASE, layout_mode: 'vacuum_table' }, 5000, 100);
    expect(sel.engineUsed).toBe('vacuum_table');
    expect(sel.engineReason).toBe('vacuum');
    expect(sel.params.engine).toBeUndefined();
    expect(sel.params.cut_quality).toBeUndefined();
  });

  it('vacuum profile STRIPS stale engine/cut_quality instead of forwarding them (Critic R1 F1)', () => {
    const sel = applyEngineSelection(
      { ...BASE, layout_mode: 'vacuum_table', engine: 'heuristic', cut_quality: 'max' },
      5000,
      100,
    );
    expect(sel.engineUsed).toBe('vacuum_table');
    expect(sel.engineReason).toBe('vacuum');
    expect(sel.params.engine).toBeUndefined();
    expect(sel.params.cut_quality).toBeUndefined();
    expect(sel.params.layout_mode).toBe('vacuum_table');
    expect(sel.params.kerf_mm).toBe(BASE.kerf_mm);
  });

  it('explicit profile engine=heuristic pins heuristic and defaults cut_quality to max', () => {
    const sel = applyEngineSelection({ ...BASE, engine: 'heuristic' }, 1, 100);
    expect(sel.engineUsed).toBe('heuristic');
    expect(sel.engineReason).toBe('profile_engine');
    expect(sel.params.engine).toBe('heuristic');
    expect(sel.params.cut_quality).toBe('max');
  });

  it('explicit heuristic keeps an explicit cut_quality tier', () => {
    const sel = applyEngineSelection({ ...BASE, engine: 'heuristic', cut_quality: 'balanced' }, 1, 100);
    expect(sel.params.cut_quality).toBe('balanced');
  });

  it('explicit engine=ga opts out of auto even above the threshold', () => {
    const sel = applyEngineSelection({ ...BASE, engine: 'ga' }, 5000, 100);
    expect(sel.engineUsed).toBe('ga');
    expect(sel.engineReason).toBe('profile_engine');
    expect(sel.params.engine).toBe('ga');
    expect(sel.params.cut_quality).toBeUndefined();
  });

  it('auto: at/above threshold switches to heuristic+max', () => {
    const sel = applyEngineSelection(BASE, 100, 100);
    expect(sel.engineUsed).toBe('heuristic');
    expect(sel.engineReason).toBe('auto_threshold');
    expect(sel.params.engine).toBe('heuristic');
    expect(sel.params.cut_quality).toBe('max');
  });

  it('auto: below threshold stays GA with untouched params', () => {
    const sel = applyEngineSelection(BASE, 99, 100);
    expect(sel.engineUsed).toBe('ga');
    expect(sel.engineReason).toBe('default_ga');
    expect(sel.params).toEqual(BASE);
  });

  it('threshold 0 disables auto mode entirely', () => {
    const sel = applyEngineSelection(BASE, 5000, 0);
    expect(sel.engineUsed).toBe('ga');
    expect(sel.engineReason).toBe('default_ga');
    expect(sel.params.engine).toBeUndefined();
  });

  it('does not mutate the input params object', () => {
    const input = { ...BASE };
    applyEngineSelection(input, 5000, 100);
    expect(input).toEqual(BASE);
  });

  it('nested layout_mode participates in auto mode like guillotine', () => {
    const sel = applyEngineSelection({ ...BASE, layout_mode: 'nested' }, 200, 100);
    expect(sel.engineUsed).toBe('heuristic');
  });
});
