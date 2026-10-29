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
    expect(fn).not.toMatch(/FOR UPDATE|FOR NO KEY UPDATE|lockOrders/);
    expect(source).not.toContain('lockOrdersOfDetails');
  });

  it('createJob and addItems still report «Базис» conflicts', () => {
    expect(body('createJob')).toContain('this.routeConflicts(');
    expect(body('addItems')).toContain('this.routeConflicts(');
  });
});
