import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'pg-bazis-cut-repository.ts'), 'utf8');
const body = (name: string) => {
  const start = source.indexOf(`  async ${name}(`);
  const next = source.indexOf('\n  async ', start + 10);
  return source.slice(start, next === -1 ? undefined : next);
};

/**
 * Every «Базис раскрой» command takes the owners of the set (its orders and their bath neighbours — the legacy MDF
 * automation's owner set) in one sorted lock BEFORE the set row or a new set (migration 282, lock protocol
 * orders → set): a command never holds the set while waiting for an order another command holds.
 */
describe('«Базис раскрой» commands lock the owners first', () => {
  it.each([
    ['create', 'lockOrderOwners(tx, { orderIds: [command.orderId], detailIds, hdfDetailIds })', 'insertSetHeader('],
    ['createFromPicker', 'lockOrderOwners(tx, { orderIds, detailIds:', 'insertSetHeader('],
    ['addDetails', 'lockOrdersOfSet(tx, command.setId, detailIds, hdfDetailIds)', 'lockSet(tx, command.setId'],
    ['updateDetail', 'lockOrdersOfSet(tx, command.setId)', 'lockSet(tx, command.setId'],
    ['deleteDetail', 'lockOrdersOfSet(tx, command.setId)', 'lockSet(tx, command.setId'],
  ])('%s: owners before the set', (name, ownersLock, setLock) => {
    const fn = body(name);
    expect(fn.indexOf(ownersLock), name).toBeGreaterThan(0);
    expect(fn.indexOf(ownersLock)).toBeLessThan(fn.indexOf(setLock));
  });

  it('add/update/delete re-check the owners under the set lock', () => {
    for (const name of ['addDetails', 'updateDetail', 'deleteDetail']) {
      const fn = body(name);
      expect(fn.indexOf('assertSetOrdersLocked(tx, command.setId, lockedOrders)'), name).toBeGreaterThan(fn.indexOf('lockSet(tx, command.setId'));
    }
  });
});
