import { describe, expect, it } from 'vitest';
import { snapshotMdfExecutionContext } from './mdf-execution-context';

const context = () => ({ sourceCreatedAt: '2026-09-01T00:00:00Z', displayName: 'E2E CNC',
  priorColumn: 'parsed', compositionComplete: true,
  demand: [{ orderId: 1, detailId: 11, quantity: 10 }, { orderId: 1, detailId: 12, quantity: 5 }] });
describe('immutable MDF execution context', () => {
  it('normalizes demand order and creation date without retaining mutable input', () => {
    const input = context(); input.demand.reverse();
    const saved = snapshotMdfExecutionContext(input);
    input.demand[0].quantity = 999;
    expect(saved).toEqual({ ...context(), sourceCreatedAt: '2026-09-01T00:00:00.000Z' });
  });
  it.each(['duplicate', 'ownership', 'negative', 'fraction', 'overflow', 'date', 'column', 'empty'])(
    'rejects %s before any SQL', failure => {
      const value = context();
      if (failure === 'duplicate') value.demand.push(value.demand[0]);
      if (failure === 'ownership') value.demand.push({ ...value.demand[0], orderId: 2 });
      if (failure === 'negative') value.demand[0].quantity = -1;
      if (failure === 'fraction') value.demand[0].quantity = 0.5;
      if (failure === 'overflow') value.demand[0].quantity = Number.MAX_SAFE_INTEGER + 1;
      if (failure === 'date') value.sourceCreatedAt = 'invalid';
      if (failure === 'column') value.priorColumn = 'unknown';
      if (failure === 'empty') value.demand = [];
      expect(() => snapshotMdfExecutionContext(value)).toThrow('MDF_EXECUTION_CONTEXT_INVALID');
    });
  it('allows zero demand, but never negative or duplicate identities', () => {
    const value = context(); value.demand[0].quantity = 0;
    expect(snapshotMdfExecutionContext(value).demand[0].quantity).toBe(0);
  });
});
