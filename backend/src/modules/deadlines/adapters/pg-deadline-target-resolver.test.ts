import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { PgDeadlineTargetResolver } from './pg-deadline-target-resolver';

describe('PgDeadlineTargetResolver', () => {
  it('resolves order completion and manager responsibility', async () => {
    const resolver = new PgDeadlineTargetResolver(
      createDatabase({
        order: {
          order_id: 100,
          client_id: 5,
          manager_id: 42,
          completion_date: '2026-05-02',
          delete_flag: false,
        },
      }),
    );

    const state = await resolver.resolveTargetState({ entityType: 'order', entityId: '100', orderId: 100 });

    expect(state).toMatchObject({
      isCompleted: true,
      responsibleUserIds: [42],
      auditContext: { entityType: 'order', orderId: 100, clientId: 5 },
    });
    expect(state.notificationRecipients).toEqual({
      assigneeUserId: 42,
      managerUserId: 42,
    });
  });

  it('resolves order stage completion and maps employee to user when available', async () => {
    const resolver = new PgDeadlineTargetResolver(
      createDatabase({
        workshop: {
          order_workshop_id: 200,
          order_id: 100,
          workshop_id: 1,
          workshop_name: 'Раскрой',
          production_status_id: 2,
          responsible_employee_id: 77,
          responsible_user_id: 55,
          manager_id: 42,
          completed_date: null,
          delete_flag: false,
        },
      }),
    );

    const state = await resolver.resolveTargetState({
      entityType: 'order_stage',
      entityId: '200',
      orderId: 100,
      orderWorkshopId: 200,
    });

    expect(state).toMatchObject({
      isCompleted: false,
      responsibleUserIds: [55, 42],
      auditContext: {
        entityType: 'order_stage',
        orderId: 100,
        orderWorkshopId: 200,
        workshopName: 'Раскрой',
      },
    });
    expect(state.notificationRecipients).toEqual({
      assigneeUserId: 55,
      managerUserId: 42,
    });
  });

  it('resolves client action with inherited order manager recipient and client action audit context', async () => {
    const resolver = new PgDeadlineTargetResolver(
      createDatabase({
        order: {
          order_id: 100,
          client_id: 5,
          manager_id: 42,
          completion_date: null,
          delete_flag: false,
        },
      }),
    );

    const state = await resolver.resolveTargetState({
      entityType: 'client_action',
      entityId: 'client-action-1',
      orderId: 100,
    });

    expect(state).toMatchObject({
      isCompleted: false,
      responsibleUserIds: [42],
      auditContext: {
        entityType: 'client_action',
        entityId: 'client-action-1',
        orderId: 100,
        clientId: 5,
      },
    });
    expect(state.notificationRecipients).toEqual({
      assigneeUserId: 42,
      managerUserId: 42,
    });
  });

  it('rejects dangerous status-changing actions in the first adapter phase', async () => {
    const resolver = new PgDeadlineTargetResolver(createDatabase());

    await expect(
      resolver.canApplyAction({
        actionType: 'change_order_status',
        target: { entityType: 'order', entityId: '100', orderId: 100 },
      }),
    ).resolves.toBe(false);
  });
});

function createDatabase(rows: { order?: Record<string, unknown>; workshop?: Record<string, unknown> } = {}) {
  return {
    async query(text: string) {
      if (text.includes('FROM orders')) {
        return { rows: rows.order ? [rows.order] : [] };
      }

      if (text.includes('FROM order_workshops')) {
        return { rows: rows.workshop ? [rows.workshop] : [] };
      }

      return { rows: [] };
    },
  } as unknown as DatabaseClient;
}
