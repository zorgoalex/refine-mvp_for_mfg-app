import { describe, expect, it } from 'vitest';
import { computeStepOffset } from './useCalendarDays';

describe('computeStepOffset (AD-6 stepDays helper)', () => {
  it('returns 1 for forward + stepDays=1 (mobile per-day)', () => {
    expect(computeStepOffset(1, 1)).toBe(1);
  });

  it('returns -1 for backward + stepDays=1 (mobile per-day)', () => {
    expect(computeStepOffset(1, -1)).toBe(-1);
  });

  it('returns 7 for forward + stepDays=7 (desktop per-week)', () => {
    expect(computeStepOffset(7, 1)).toBe(7);
  });

  it('returns -7 for backward + stepDays=7 (desktop per-week)', () => {
    expect(computeStepOffset(7, -1)).toBe(-7);
  });

  it('supports day, week, two-week, and month navigation steps', () => {
    const validSteps: Array<1 | 7 | 14 | 30> = [1, 7, 14, 30];
    validSteps.forEach((step) => {
      expect(Math.abs(computeStepOffset(step, 1))).toBe(step);
      expect(Math.abs(computeStepOffset(step, -1))).toBe(step);
    });
  });
});
