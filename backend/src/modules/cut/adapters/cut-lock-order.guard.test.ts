import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'pg-cut-repository.ts'), 'utf8');
const body = (name: string) => {
  const start = source.indexOf(`  ${name}(command`);
  const next = source.indexOf('\n  }\n', start);
  return source.slice(start, next);
};

/**
 * CNC job commands keep the job-first lock order (as the MDF board card command: job → the automation's orders). The
 * «Базис» route check (migration 282) needs no early order lock: the cut_job_item insert takes its order FK key-share
 * lock, which already serializes with a «Базис раскрой» command holding that order.
 */
describe('CNC job commands lock the job first (no early order lock)', () => {
  it('addItems: the job lock is the first lock; no lockOrdersOfDetails anywhere', () => {
    const fn = body('addItems');
    expect(fn.indexOf('loadJobForUpdate(tx, command.cutJobId)')).toBeGreaterThan(0);
    // after the job: the reserved orders in one sorted lock, before any reservation (review R2 #1)
    expect(fn.indexOf('lockReservedOrders(tx,')).toBeGreaterThan(fn.indexOf('loadJobForUpdate(tx, command.cutJobId)'));
    expect(fn.indexOf('lockReservedOrders(tx,')).toBeLessThan(fn.indexOf('this.reserveDetail('));
    expect(source).not.toContain('lockOrdersOfDetails');
  });

  it('createJob locks the reserved orders sorted before reserving', () => {
    const fn = body('createJob');
    expect(fn.indexOf('lockReservedOrders(tx,')).toBeGreaterThan(0);
    expect(fn.indexOf('lockReservedOrders(tx,')).toBeLessThan(fn.indexOf('this.reserveDetail('));
    expect(source).toContain('ORDER BY o.order_id FOR KEY SHARE');
  });

  it('createJob and addItems still report «Базис» conflicts', () => {
    expect(body('createJob')).toContain('this.routeConflicts(');
    expect(body('addItems')).toContain('this.routeConflicts(');
  });
});
