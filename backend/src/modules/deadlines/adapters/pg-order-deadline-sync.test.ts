import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgOrderDeadlineSync } from './pg-order-deadline-sync';

describe('PgOrderDeadlineSync', () => {
  it('syncs final and stage deadlines after order save through a port', async () => {
    const database = createDatabase();
    const sync = new PgOrderDeadlineSync(database.service);

    await sync.syncOrderDeadlinesAfterSave({
      orderId: 100,
      currentUser: currentUser(),
      eventType: 'ORDER_CREATED',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text));
    expect(sql.filter((query) => query.includes('INSERT INTO deadline_instances'))).toHaveLength(2);
    expect(sql.filter((query) => query.includes('INSERT INTO deadline_events'))).toHaveLength(2);
    expect(sql.filter((query) => query.includes('INSERT INTO audit_log'))).toHaveLength(2);
    expect(sql.filter((query) => query.includes('INSERT INTO outbox_events'))).toHaveLength(3);
    expect(database.queries[0].params[0]).toBe('ORDER_CREATED');
  });
});

function createDatabase() {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let deadlineIndex = 0;
  let eventIndex = 0;
  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });

      if (text.includes('FROM orders')) {
        return {
          rows: [
            {
              order_id: 100,
              client_id: 5,
              manager_id: 42,
              planned_completion_date: '2026-05-10',
              completion_date: null,
              delete_flag: false,
            },
          ],
        };
      }

      if (text.includes('FROM order_workshops')) {
        return {
          rows: [
            {
              order_workshop_id: 200,
              order_id: 100,
              workshop_id: 1,
              workshop_name: 'Раскрой',
              production_status_id: 1,
              planned_completion_date: '2026-05-03',
              completed_date: null,
              responsible_employee_id: null,
              responsible_user_id: null,
              manager_id: 42,
              delete_flag: false,
            },
          ],
        };
      }

      if (text.includes('FROM deadline_instances')) {
        return { rows: [] };
      }

      if (text.includes('INSERT INTO deadline_instances')) {
        deadlineIndex += 1;
        return {
          rows: [
            deadlineRow({
              deadlineId:
                deadlineIndex === 1
                  ? '11111111-1111-4111-8111-111111111111'
                  : '22222222-2222-4222-8222-222222222222',
              entityType: String(params[0]),
              entityId: String(params[1]),
              orderWorkshopId: params[3] as number | null,
              deadlineAt: String(params[6]),
              metadata: JSON.parse(String(params[7])),
            }),
          ],
        };
      }

      if (text.includes('INSERT INTO deadline_events')) {
        eventIndex += 1;
        return {
          rows: [
            eventRow({
              eventId:
                eventIndex === 1
                  ? '33333333-3333-4333-8333-333333333333'
                  : '44444444-4444-4444-8444-444444444444',
              deadlineId: String(params[0]),
              eventType: String(params[1]),
              entityType: String(params[3]),
              entityId: String(params[4]),
              orderWorkshopId: params[6] as number | null,
              deadlineAt: String(params[8]),
            }),
          ],
        };
      }

      return { rows: [] };
    },
  };

  return {
    queries,
    service: {
      async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
        return handler(tx);
      },
    } as unknown as DatabaseService,
  };
}

function deadlineRow(input: {
  deadlineId: string;
  entityType: string;
  entityId: string;
  orderWorkshopId: number | null;
  deadlineAt: string;
  metadata: Record<string, unknown>;
}) {
  return {
    deadline_id: input.deadlineId,
    policy_id: null,
    policy_version_id: null,
    entity_type: input.entityType,
    entity_id: input.entityId,
    parent_entity_type: null,
    parent_entity_id: null,
    order_id: 100,
    order_workshop_id: input.orderWorkshopId,
    client_id: 5,
    responsible_user_id: 42,
    deadline_at: input.deadlineAt,
    status: 'active',
    source: 'recalculated',
    is_manually_overridden: false,
    policy_snapshot_json: null,
    metadata_json: input.metadata,
    started_at: null,
    completed_at: null,
    expired_at: null,
    cancelled_at: null,
    created_at: '2026-05-01T10:00:00.000Z',
    updated_at: '2026-05-01T10:00:00.000Z',
  };
}

function eventRow(input: {
  eventId: string;
  deadlineId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  orderWorkshopId: number | null;
  deadlineAt: string;
}) {
  return {
    deadline_event_id: input.eventId,
    deadline_id: input.deadlineId,
    event_type: input.eventType,
    severity: 'info',
    entity_type: input.entityType,
    entity_id: input.entityId,
    order_id: 100,
    order_workshop_id: input.orderWorkshopId,
    client_id: 5,
    deadline_at: input.deadlineAt,
    event_at: '2026-05-01T10:00:00.000Z',
    delay_minutes: null,
    payload_json: {},
    created_at: '2026-05-01T10:00:00.000Z',
  };
}

function currentUser() {
  return {
    id: '42',
    username: 'admin',
    role: 'admin' as const,
    roleId: 1,
    permissions: [],
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
