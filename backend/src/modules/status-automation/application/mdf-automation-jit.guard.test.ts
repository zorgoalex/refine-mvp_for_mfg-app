import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');

// The MDF board reads have inflated cost estimates: under PostgreSQL JIT their compilation took 10+ s on a busy host,
// past the query timeout, failing detail status changes (stage, order 2987, 30.10.2026).
describe('MDF status automation reads run without PostgreSQL JIT', () => {
  it('turns JIT off before the board-event read of a dispatch', () => {
    const runtime = read('./status-automation-runtime.ts');
    const dispatch = runtime.slice(runtime.indexOf('export async function dispatchMdfBoardEvent'));
    expect(dispatch.indexOf("await tx.query('SET LOCAL jit=off');")).toBeGreaterThan(0);
    expect(dispatch.indexOf("await tx.query('SET LOCAL jit=off');"))
      .toBeLessThan(dispatch.indexOf('listEnabledRulesForManualRefresh'));
  });

  it('turns JIT off before the laminated-bath read of a detail status change', () => {
    const repository = read('../../production-actions/adapters/pg-production-action-repository.ts');
    const evaluate = repository.slice(repository.indexOf('async function evaluateMdfBoardLaminatedBathAutomationForDetails'));
    expect(evaluate.indexOf("await tx.query('SET LOCAL jit=off');")).toBeGreaterThan(0);
    expect(evaluate.indexOf("await tx.query('SET LOCAL jit=off');"))
      .toBeLessThan(evaluate.indexOf('loadMdfLaminatedBathAutomationRows(tx, detailIds)'));
  });
});
