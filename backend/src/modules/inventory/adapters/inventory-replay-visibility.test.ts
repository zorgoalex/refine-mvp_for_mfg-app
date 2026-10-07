import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { assertReplayVisible } from './pg-inventory-repository';

const user = (permissions: string[]): CurrentUser => ({
  id: '7', username: 'u', role: 'manager', roleId: 10, permissions: permissions as CurrentUser['permissions'],
});
const client = (rows: unknown[]): DatabaseClient => ({
  query: async () => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }),
} as unknown as DatabaseClient);

async function status(run: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    return (error as { statusCode: number }).statusCode;
  }
}

describe('assertReplayVisible', () => {
  it('returns a cached document without an order link', async () => {
    expect(await status(assertReplayVisible(client([]), user(['inventory.manage']), { orderId: null }))).toBe('ok');
  });

  it('hides a cached order-linked document after orders.view is revoked', async () => {
    expect(await status(assertReplayVisible(client([{ order_name: 'A' }]), user(['inventory.manage']), { orderId: 5 }))).toBe(404);
  });

  it('hides a cached order-linked document when the order left the user scope', async () => {
    expect(await status(assertReplayVisible(client([]), user(['inventory.manage', 'orders.view']), { orderId: 5 }))).toBe(404);
  });

  it('returns it while the order is still visible', async () => {
    expect(await status(assertReplayVisible(client([{ order_name: 'A' }]), user(['inventory.manage', 'orders.view']), { orderId: 5 }))).toBe('ok');
  });
});
