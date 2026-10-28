import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgOrderTransactionManager } from './pg-order-transaction-manager';

/**
 * An order save that keeps its link to a Bazis project card of an unknown client (`client_source = 'default'`) refines the
 * card's client (migration 279) — so it needs the card rule even when the link itself does not change (R2 #1).
 */
describe('order save and a Bazis project card of an unknown client', () => {
  const run = async (permissions: string[]) => {
    const queries: string[] = [];
    const tx = {
      async query(text: string) {
        const sql = text.replace(/\s+/g, ' ').trim();
        queries.push(sql);
        if (sql.startsWith('SELECT order_doweling_link_id, doweling_order_id, delete_flag FROM order_doweling_links WHERE order_id')) {
          return { rows: [{ order_doweling_link_id: 51, doweling_order_id: 7, delete_flag: false }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT doweling_order_id, design_engineer_id FROM doweling_orders')) {
          return { rows: [{ doweling_order_id: 7, design_engineer_id: 3 }], rowCount: 1 };
        }
        if (sql.includes("AND client_source = 'default'")) {
          return { rows: [{ doweling_order_id: 7 }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT d.doweling_order_id, d.order_id AS legacy_order_id')) {
          return { rows: [{ doweling_order_id: 7, legacy_order_id: null, linked: [101] }], rowCount: 1 };
        }
        return { rows: [{ audit_id: 'a' }], rowCount: 1 };
      },
    };
    const database = {
      transaction: async <T>(handler: (client: typeof tx) => Promise<T>) => handler(tx),
      query: tx.query,
    } as unknown as DatabaseService;
    const user = { id: '9', username: 'u', role: 'manager', roleId: 4, permissions } as unknown as CurrentUser;
    const manager = new PgOrderTransactionManager(database);
    await manager.runInTransaction((unitOfWork) => unitOfWork.assertDowelingLinkChangesAllowed({
      orderId: 101,
      links: [{ id: 51, dowelingOrderId: 7, designEngineerId: 3, refKey1c: null, clientKey: null } as never],
      deletedLinkIds: [],
      currentUser: user,
      requestId: 'r',
    }));
    return queries;
  };

  it('refuses without doweling.update although the link stays as it is', async () => {
    const permissions = getPermissionsForRole('manager').filter((p) => p !== 'doweling.update');
    await expect(run(permissions)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('passes with doweling.update (the card is checked like a changed one)', async () => {
    const queries = await run(getPermissionsForRole('manager'));
    expect(queries.some((sql) => sql.startsWith('SELECT d.doweling_order_id, d.order_id AS legacy_order_id'))).toBe(true);
  });
});
