import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import {
  createOrderStatusBoardFilterKey,
  PgOrderStatusBoardRepository,
} from './pg-order-status-board-repository';

describe('PgOrderStatusBoardRepository', () => {
  it('returns a virtual unassigned column, limit+1 cursor and exact total', async () => {
    const database = fakeDatabase([
      boardRow(null, null),
      boardRow(101, '2026-07-20'),
      boardRow(100, null),
      boardRow(99, null),
    ]);
    const repository = new PgOrderStatusBoardRepository(database.client);

    const result = await repository.getBoard({
      currentUser: worker(),
      query: {
        board: 'production',
        column: 'unassigned',
        limit: 2,
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });

    expect(result).toMatchObject({
      board: 'production',
      financialsVisible: true,
      columns: [
        {
          key: 'unassigned',
          status: { id: null, name: 'Без статуса', isActive: true },
          total: 3,
          cards: [
            {
              orderId: 101,
              canChangeOrderStatus: false,
              canChangeProductionStatus: true,
            },
            { orderId: 100 },
          ],
        },
      ],
    });
    expect(result.columns[0]?.nextCursor).toEqual(expect.any(String));
    expect(database.queries[0]?.text).toContain('ROW_NUMBER() OVER');
    expect(database.queries[0]?.text).toContain('assigned_ow.delete_flag = false');
    expect(database.queries[0]?.text).toContain('ranked.row_number <=');
    expect(database.queries[0]?.params).toContain(3);
  });

  it('binds cursor to board, column and canonical filters', async () => {
    const firstDatabase = fakeDatabase([
      boardRow(null, null),
      boardRow(101, '2026-07-20'),
      boardRow(100, null),
    ]);
    const repository = new PgOrderStatusBoardRepository(firstDatabase.client);
    const first = await repository.getBoard({
      currentUser: worker(),
      query: {
        board: 'production',
        column: 'unassigned',
        limit: 1,
        search: 'ABC',
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });
    const cursor = first.columns[0]?.nextCursor;
    expect(cursor).toBeTruthy();

    await expect(
      repository.getBoard({
        currentUser: worker(),
        query: {
          board: 'production',
          column: 'unassigned',
          cursor: cursor!,
          limit: 1,
          search: 'DIFFERENT',
          onlyMyOrders: false,
          overdueOnly: false,
        },
      }),
    ).rejects.toMatchObject({
      code: 'BOARD_CURSOR_MISMATCH',
      statusCode: 422,
    });
    expect(firstDatabase.queries).toHaveLength(1);
  });

  it.each([
    [{ priority: 100, plannedCompletionDate: '2026-02-30' }, 'invalid date'],
    [{ priority: 101, plannedCompletionDate: null }, 'out-of-range priority'],
  ])('rejects a forged cursor with %s before querying PostgreSQL', async (override) => {
    const query = {
      board: 'production' as const,
      column: 'unassigned',
      limit: 1,
      onlyMyOrders: false,
      overdueOnly: false,
    };
    const cursor = Buffer.from(
      JSON.stringify({
        v: 1,
        board: query.board,
        column: query.column,
        filterKey: createOrderStatusBoardFilterKey(query),
        priority: 100,
        plannedCompletionDate: null,
        orderId: 101,
        ...override,
      }),
    ).toString('base64url');
    const database = fakeDatabase([]);

    await expect(
      new PgOrderStatusBoardRepository(database.client).getBoard({
        currentUser: worker(),
        query: { ...query, cursor },
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'BOARD_CURSOR_INVALID',
    });
    expect(database.queries).toHaveLength(0);
  });

  it('builds a stable filter fingerprint independent of page size', () => {
    const base = {
      board: 'order' as const,
      limit: 10,
      search: ' A ',
      onlyMyOrders: true,
      overdueOnly: false,
      plannedFrom: '2026-07-01',
    };
    expect(createOrderStatusBoardFilterKey(base)).toBe(
      createOrderStatusBoardFilterKey({ ...base, limit: 60 }),
    );
    expect(createOrderStatusBoardFilterKey(base)).not.toBe(
      createOrderStatusBoardFilterKey({ ...base, search: 'B' }),
    );
  });

  it('does not evaluate assignment joins for an unrestricted unfiltered reader', async () => {
    const database = fakeDatabase([]);
    const repository = new PgOrderStatusBoardRepository(database.client);

    await repository.getBoard({
      currentUser: user('admin'),
      query: {
        board: 'order',
        limit: 24,
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });

    expect(database.queries[0]?.text).toContain('FALSE AS current_user_assigned');
    expect(database.queries[0]?.text).not.toContain('assigned_ow');
    expect(database.queries[0]?.text).toContain('ranked.row_number <= $1');
    expect(database.queries[0]?.text).not.toContain('$2');
    expect(database.queries[0]?.params).toEqual([25]);
  });

  it('excludes the completed status from the order catalog and order scan', async () => {
    const database = fakeDatabase([]);

    await new PgOrderStatusBoardRepository(database.client).getBoard({
      currentUser: user('admin'),
      query: {
        board: 'order',
        limit: 24,
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });

    const sql = database.queries[0]?.text ?? '';
    expect(sql).toContain(
      'JOIN order_statuses board_order_status ON board_order_status.order_status_id = o.order_status_id',
    );
    expect(sql).toContain(
      "LOWER(BTRIM(board_order_status.order_status_name)) NOT IN ('завершен', 'завершён')",
    );
    expect(sql).toContain(
      "LOWER(BTRIM(os.order_status_name)) NOT IN ('завершен', 'завершён')",
    );
  });

  it('keeps an inactive referenced status visible but read-only as a destination', async () => {
    const database = fakeDatabase([
      {
        ...boardRow(null, null),
        status_key: '7',
        status_id: 7,
        status_name: 'Архивный',
        status_is_active: false,
        total_count: 0,
      },
    ]);
    const repository = new PgOrderStatusBoardRepository(database.client);

    const result = await repository.getBoard({
      currentUser: user('admin'),
      query: {
        board: 'order',
        limit: 24,
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });

    expect(result.columns).toEqual([
      expect.objectContaining({
        key: '7',
        status: expect.objectContaining({ id: 7, name: 'Архивный', isActive: false }),
        total: 0,
        cards: [],
        nextCursor: null,
      }),
    ]);
  });

  it('uses the canonical own and assigned read predicates for restricted roles', async () => {
    const managerDatabase = fakeDatabase([]);
    await new PgOrderStatusBoardRepository(managerDatabase.client).getBoard({
      currentUser: user('manager'),
      query: {
        board: 'order',
        limit: 24,
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });
    expect(managerDatabase.queries[0]?.text).toContain(
      '(o.created_by = $1 OR o.manager_id = $1)',
    );

    const workerDatabase = fakeDatabase([]);
    await new PgOrderStatusBoardRepository(workerDatabase.client).getBoard({
      currentUser: user('worker'),
      query: {
        board: 'production',
        limit: 24,
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });
    expect(workerDatabase.queries[0]?.text).toContain(
      'assigned_user.user_id = $1',
    );
  });

  it('keeps totals pre-cursor and emits the nullable-date keyset predicate', async () => {
    const firstDatabase = fakeDatabase([
      boardRow(null, null),
      boardRow(100, null),
      boardRow(99, null),
    ]);
    const first = await new PgOrderStatusBoardRepository(firstDatabase.client).getBoard({
      currentUser: worker(),
      query: {
        board: 'production',
        column: 'unassigned',
        limit: 1,
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });
    const cursor = first.columns[0]?.nextCursor;
    expect(cursor).toBeTruthy();
    expect(first.columns[0]?.total).toBe(3);

    const nextDatabase = fakeDatabase([
      boardRow(null, null),
      boardRow(99, null),
    ]);
    const next = await new PgOrderStatusBoardRepository(nextDatabase.client).getBoard({
      currentUser: worker(),
      query: {
        board: 'production',
        column: 'unassigned',
        cursor: cursor!,
        limit: 1,
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });

    expect(next.columns[0]?.total).toBe(3);
    expect(nextDatabase.queries[0]?.text).toContain(
      'planned_completion_date IS NOT DISTINCT FROM',
    );
    expect(nextDatabase.queries[0]?.params).toContain(null);
  });

  it('mirrors owner and assigned-worker command capabilities per card', async () => {
    const ownerRow = {
      ...boardRow(101, null),
      created_by: 42,
      manager_id: null,
      current_user_assigned: false,
    };
    const ownerDatabase = fakeDatabase([boardRow(null, null), ownerRow]);
    const owner = await new PgOrderStatusBoardRepository(ownerDatabase.client).getBoard({
      currentUser: user('manager'),
      query: {
        board: 'order',
        limit: 24,
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });
    expect(owner.columns[0]?.cards[0]).toMatchObject({
      canChangeOrderStatus: true,
      canChangeProductionStatus: true,
    });

    const unassignedWorkerDatabase = fakeDatabase([
      boardRow(null, null),
      { ...boardRow(101, null), current_user_assigned: false },
    ]);
    const unassignedWorker = await new PgOrderStatusBoardRepository(
      unassignedWorkerDatabase.client,
    ).getBoard({
      currentUser: worker(),
      query: {
        board: 'production',
        column: 'unassigned',
        limit: 24,
        onlyMyOrders: false,
        overdueOnly: false,
      },
    });
    expect(unassignedWorker.columns[0]?.cards[0]).toMatchObject({
      canChangeOrderStatus: false,
      canChangeProductionStatus: false,
    });
  });
});

function fakeDatabase(rows: Record<string, unknown>[]) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const client = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      return { rows };
    },
  } as DatabaseClient;
  return { client, queries };
}

function boardRow(orderId: number | null, plannedCompletionDate: string | null) {
  return {
    status_key: 'unassigned',
    status_id: null,
    status_code: 'unassigned',
    status_name: 'Без статуса',
    status_color: '#8c8c8c',
    status_sort_order: 0,
    status_is_active: true,
    total_count: 3,
    row_number: orderId === null ? null : 1,
    order_id: orderId,
    order_name: orderId === null ? null : String(orderId),
    full_number: orderId === null ? null : `ABC-${orderId}`,
    client_id: orderId === null ? null : 5,
    client_name: orderId === null ? null : 'Client',
    priority: orderId === null ? null : 100,
    planned_completion_date: plannedCompletionDate,
    past_planned_date: false,
    order_status_id: orderId === null ? null : 1,
    order_status_name: orderId === null ? null : 'Новый',
    production_status_id: null,
    production_status_name: null,
    production_status_from_details_enabled: true,
    payment_status_id: orderId === null ? null : 2,
    payment_status_name: orderId === null ? null : 'Не оплачен',
    final_amount: orderId === null ? null : 1000,
    paid_amount: orderId === null ? null : 0,
    parts_count: orderId === null ? null : 5,
    total_area: orderId === null ? null : 2.5,
    manager_id: orderId === null ? null : null,
    manager_name: null,
    created_by: null,
    current_user_assigned: orderId !== null,
    updated_at: orderId === null ? null : '2026-07-19T00:00:00.000Z',
    version: orderId === null ? null : 3,
  };
}

function worker(): CurrentUser {
  return user('worker');
}

function user(role: CurrentUser['role']): CurrentUser {
  return {
    id: '42',
    username: role,
    role,
    roleId: 20,
    permissions: getPermissionsForRole(role),
  };
}
