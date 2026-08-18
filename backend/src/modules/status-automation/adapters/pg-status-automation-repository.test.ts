import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import {
  PgStatusAutomationRepository,
  listEnabledRulesForEvent,
  listEnabledRulesForManualRefresh,
  loadOrderAutomationState,
} from './pg-status-automation-repository';

describe('PgStatusAutomationRepository', () => {
  it('lists enabled rules for an event, ordered by priority and id, and maps conditions_json', async () => {
    const database = createDatabase({
      responses: ({ text }) =>
        text.includes('FROM status_automation_rules')
          ? result([
              ruleRow({
                id: '2',
                priority: '10',
                conditions_json: '{"paidShareGte":50}',
              }),
            ])
          : result([]),
    });

    const rules = await listEnabledRulesForEvent(database.tx, 'payment.created');

    expect(rules[0]).toMatchObject({
      id: 2,
      priority: 10,
      conditions: { paidShareGte: 50 },
    });
    const query = database.queries.find((entry) => entry.text.includes('FROM status_automation_rules'));
    expect(query?.text).toMatch(/event_type = \$1/i);
    expect(query?.text).toMatch(/is_enabled\s*=\s*true/i);
    expect(query?.text).toMatch(/ORDER BY priority, id/i);
  });

  it('lists all enabled rules for manual refresh without an event filter', async () => {
    const database = createDatabase({
      responses: ({ text }) =>
        text.includes('FROM status_automation_rules')
          ? result([
              ruleRow({ id: '2', event_type: 'order.updated', priority: '10' }),
              ruleRow({ id: '3', event_type: 'payment.created', priority: '20' }),
            ])
          : result([]),
    });

    const rules = await listEnabledRulesForManualRefresh(database.tx);

    expect(rules.map((rule) => rule.id)).toEqual([2, 3]);
    const query = database.queries.find((entry) => entry.text.includes('FROM status_automation_rules'));
    expect(query?.text).toMatch(/is_enabled\s*=\s*true/i);
    expect(query?.text).not.toMatch(/event_type\s*=/i);
    expect(query?.text).toMatch(/ORDER BY priority, id/i);
  });

  it('lists recent order ids for manual automation refresh from the order date cutoff', async () => {
    const database = createDatabase({
      responses: ({ text }) =>
        text.includes('FROM orders') && text.includes('order_date >= $1::date')
          ? result([{ order_id: '44' }, { order_id: '42' }])
          : result([]),
    });

    const ids = await new PgStatusAutomationRepository(database.service)
      .listRecentOrderIdsForAutomation('2026-06-17');

    expect(ids).toEqual([44, 42]);
    const query = database.queries.find((entry) => entry.text.includes('order_date >= $1::date'));
    expect(query?.params).toEqual(['2026-06-17']);
    expect(query?.text).toMatch(/delete_flag\s*=\s*false/i);
    expect(query?.text).toMatch(/order_date <= CURRENT_DATE/i);
    expect(query?.text).toMatch(/ORDER BY order_date DESC, order_id DESC/i);
  });

  it('creates a rule after validating the target status and audits in the same transaction', async () => {
    const database = createDatabase({
      responses: ({ text }) => {
        if (text.includes('FROM order_statuses')) return result([{ order_status_id: '7' }]);
        if (text.includes('INSERT INTO status_automation_rules')) {
          return result([ruleRow({ id: '41', version: '1', target_status_id: '7' })]);
        }
        if (text.includes('INSERT INTO audit_log')) return result([{ audit_id: 'audit-41' }]);
        return result([]);
      },
    });
    const repository = new PgStatusAutomationRepository(database.service);

    const rule = await repository.createRule({
      currentUser: currentUser(),
      requestId: 'request-create',
      dto: {
        name: 'Оплата → готово',
        eventType: 'payment.created',
        actionType: 'change_order_status',
        targetStatusId: 7,
        conditions: { paidShareGte: 100 },
        priority: 10,
        isEnabled: true,
      },
    });

    expect(rule).toMatchObject({ id: 41, targetStatusId: 7, version: 1 });
    expect(database.queries.some((entry) => entry.text.includes('SELECT set_session_user($1)'))).toBe(true);
    expect(database.queries.some((entry) => entry.text.includes('INSERT INTO status_automation_rules'))).toBe(true);
    const audit = database.queries.find((entry) => entry.text.includes('INSERT INTO audit_log'));
    expect(audit).toBeDefined();
    expect(audit?.params[0]).toBe('status_automation.rule_created');
    expect(audit?.params[1]).toBe('status_automation_rule');
    expect(audit?.params[2]).toBe('41');
    expect(audit?.params[6]).toBe('request-create');
    expect(audit?.params[7]).toBe('backend-status-automation');
    expect(audit?.params[19]).toBeNull();
    expect(JSON.parse(String(audit?.params[20]))).toMatchObject({ id: 41 });
    expect(JSON.parse(String(audit?.params[22]))).toEqual({
      eventType: 'payment.created',
      actionType: 'change_order_status',
      targetStatusId: 7,
    });
  });

  it('rejects creation when the active target status does not exist', async () => {
    const database = createDatabase({
      responses: ({ text }) => (text.includes('FROM order_statuses') ? result([]) : result([])),
    });
    const repository = new PgStatusAutomationRepository(database.service);

    await expect(
      repository.createRule({
        currentUser: currentUser(),
        requestId: 'request-invalid-target',
        dto: {
          name: 'Некорректное правило',
          eventType: 'order.created',
          actionType: 'change_order_status',
          targetStatusId: 999,
          conditions: {},
          priority: 100,
          isEnabled: false,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'TARGET_STATUS_NOT_FOUND' });
    expect(database.queries.some((entry) => entry.text.includes('INSERT INTO status_automation_rules'))).toBe(false);
  });

  it('rejects creation when a condition references an inactive status', async () => {
    const database = createDatabase({
      responses: ({ text }) => (text.includes('FROM order_statuses') ? result([]) : result([])),
    });

    await expect(
      new PgStatusAutomationRepository(database.service).createRule({
        currentUser: currentUser(),
        requestId: 'request-inactive-condition',
        dto: {
          name: 'Правило с архивным условием',
          eventType: 'order.created',
          actionType: 'change_order_status',
          targetStatusId: 7,
          conditions: { currentOrderStatusIn: [5] },
          priority: 100,
          isEnabled: false,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CONDITION_STATUS_NOT_FOUND' });
    expect(database.queries.some((entry) => entry.text.includes('INSERT INTO status_automation_rules'))).toBe(false);
  });

  it('creates a many-to-one mapping after validating both status catalogs', async () => {
    const database = createDatabase({
      responses: ({ text, params }) => {
        if (text.includes('FROM production_statuses') || text.includes('FROM order_statuses')) {
          return result((params[0] as number[]).map((statusId) => ({ status_id: String(statusId) })));
        }
        if (text.includes('INSERT INTO status_automation_rules')) {
          return result([ruleRow({
            id: '42',
            event_type: 'order.production_status_changed',
            action_type: 'map_production_status_to_order_status',
            target_status_id: null,
            action_config_json: {
              statusMapping: { entries: [{ sourceStatusIds: [5, 6], targetStatusId: 7 }] },
            },
          })]);
        }
        if (text.includes('INSERT INTO audit_log')) return result([{ audit_id: 'audit-42' }]);
        return result([]);
      },
    });

    const rule = await new PgStatusAutomationRepository(database.service).createRule({
      currentUser: currentUser(),
      requestId: 'request-mapping',
      dto: {
        name: 'Производство → заказ',
        eventType: 'order.production_status_changed',
        actionType: 'map_production_status_to_order_status',
        targetStatusId: null,
        conditions: {},
        actionConfig: {
          statusMapping: { entries: [{ sourceStatusIds: [5, 6], targetStatusId: 7 }] },
        },
        priority: 10,
        isEnabled: true,
      },
    });

    expect(rule).toMatchObject({
      targetStatusId: null,
      actionConfig: {
        statusMapping: { entries: [{ sourceStatusIds: [5, 6], targetStatusId: 7 }] },
      },
    });
  });

  it('updates a rule with optimistic version and audits before/after', async () => {
    const before = ruleRow({ id: '41', version: '3', name: 'Старое имя' });
    const after = ruleRow({ id: '41', version: '4', name: 'Новое имя' });
    const database = createDatabase({
      responses: ({ text }) => {
        if (text.includes('SELECT id, name')) return result([before]);
        if (text.includes('FROM order_statuses')) return result([{ order_status_id: '7' }]);
        if (/UPDATE status_automation_rules/.test(text)) return result([after]);
        if (text.includes('INSERT INTO audit_log')) return result([{ audit_id: 'audit-update-41' }]);
        return result([]);
      },
    });
    const repository = new PgStatusAutomationRepository(database.service);

    const rule = await repository.updateRule({
      currentUser: currentUser(),
      requestId: 'request-update',
      ruleId: 41,
      dto: { name: 'Новое имя', version: 3 },
    });

    expect(rule).toMatchObject({ id: 41, name: 'Новое имя', version: 4 });
    const update = database.queries.find((entry) => /UPDATE status_automation_rules/.test(entry.text));
    expect(update?.text).toMatch(/version = version \+ 1/i);
    expect(update?.text).toMatch(/WHERE id = \$1 AND version = \$2/i);
    const audit = database.queries.find((entry) => entry.text.includes('INSERT INTO audit_log'));
    expect(audit?.params[0]).toBe('status_automation.rule_updated');
    expect(JSON.parse(String(audit?.params[19]))).toMatchObject({ id: 41, name: 'Старое имя' });
    expect(JSON.parse(String(audit?.params[20]))).toMatchObject({ id: 41, name: 'Новое имя' });
  });

  it('rejects an update whose merged conditions are inapplicable to the merged event type', async () => {
    const before = ruleRow({
      id: '41',
      version: '1',
      event_type: 'payment.created',
      conditions_json: { firstPaymentOnly: true },
    });
    const database = createDatabase({
      responses: ({ text }) => {
        if (text.includes('SELECT id, name')) return result([before]);
        if (text.includes('FROM order_statuses')) return result([{ order_status_id: '7' }]);
        return result([]);
      },
    });

    await expect(
      new PgStatusAutomationRepository(database.service).updateRule({
        currentUser: currentUser(),
        requestId: 'request-merged-conditions',
        ruleId: 41,
        dto: { eventType: 'order.created', version: 1 },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    expect(database.queries.some((entry) => /UPDATE status_automation_rules/.test(entry.text))).toBe(false);
  });

  it('rejects re-enabling a rule whose persisted target status went stale', async () => {
    const before = ruleRow({ id: '41', version: '1', is_enabled: false });
    const database = createDatabase({
      responses: ({ text }) => {
        if (text.includes('SELECT id, name')) return result([before]);
        if (text.includes('FROM order_statuses')) return result([]); // статус деактивирован
        return result([]);
      },
    });

    await expect(
      new PgStatusAutomationRepository(database.service).updateRule({
        currentUser: currentUser(),
        requestId: 'request-stale-target',
        ruleId: 41,
        dto: { isEnabled: true, version: 1 },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'TARGET_STATUS_NOT_FOUND' });
  });

  it('returns 409 for a stale version and 404 for a missing rule', async () => {
    const staleDatabase = createDatabase({
      responses: ({ text }) => {
        if (text.includes('SELECT id, name')) return result([ruleRow({ id: '41', version: '3' })]);
        if (/UPDATE status_automation_rules/.test(text)) return result([], 0);
        if (text.includes('SELECT 1 FROM status_automation_rules')) return result([{ '?column?': 1 }]);
        return result([]);
      },
    });
    const repository = new PgStatusAutomationRepository(staleDatabase.service);

    await expect(
      repository.updateRule({
        currentUser: currentUser(),
        requestId: 'request-stale',
        ruleId: 41,
        dto: { version: 2 },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'STALE_VERSION' });

    const missingDatabase = createDatabase({
      responses: ({ text }) => (text.includes('SELECT id, name') ? result([]) : result([])),
    });
    await expect(
      new PgStatusAutomationRepository(missingDatabase.service).updateRule({
        currentUser: currentUser(),
        requestId: 'request-missing',
        ruleId: 404,
        dto: { version: 1 },
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'RULE_NOT_FOUND' });
  });

  it('deletes a rule, audits it, and returns 404 when it does not exist', async () => {
    const row = ruleRow({ id: '41', version: '2' });
    const database = createDatabase({
      responses: ({ text }) => {
        if (/DELETE FROM status_automation_rules/.test(text)) return result([row]);
        if (text.includes('INSERT INTO audit_log')) return result([{ audit_id: 'audit-delete-41' }]);
        return result([]);
      },
    });
    const repository = new PgStatusAutomationRepository(database.service);

    await expect(
      repository.deleteRule({ currentUser: currentUser(), requestId: 'request-delete', ruleId: 41 }),
    ).resolves.toEqual({ deleted: true });
    const audit = database.queries.find((entry) => entry.text.includes('INSERT INTO audit_log'));
    expect(audit?.params[0]).toBe('status_automation.rule_deleted');
    expect(JSON.parse(String(audit?.params[19]))).toMatchObject({ id: 41 });
    expect(audit?.params[20]).toBeNull();

    const missingDatabase = createDatabase({
      responses: ({ text }) => (/DELETE FROM status_automation_rules/.test(text) ? result([], 0) : result([])),
    });
    await expect(
      new PgStatusAutomationRepository(missingDatabase.service).deleteRule({
        currentUser: currentUser(),
        requestId: 'request-delete-missing',
        ruleId: 404,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'RULE_NOT_FOUND' });
  });

  it.each([
    ['bazis', true, false],
    ['import', false, true],
    ['manual', false, false],
  ] as const)('loads order automation state with %s source', async (source, isBazis, isImport) => {
    const database = createDatabase({
      responses: ({ text }) =>
        text.includes('FROM orders o')
          ? result([
              {
                order_id: '12',
                order_status_id: '2',
                payment_status_id: '3',
                production_status_id: null,
                production_status_from_details_enabled: true,
                final_amount: '1000.50',
                paid_amount: '250.25',
                version: '8',
                client_id: '77',
                is_bazis: isBazis,
                is_import: isImport,
              },
            ])
          : result([]),
    });

    await expect(loadOrderAutomationState(database.tx, 12)).resolves.toEqual({
      orderId: 12,
      orderStatusId: 2,
      paymentStatusId: 3,
      productionStatusId: null,
      productionStatusFromDetailsEnabled: true,
      finalAmount: 1000.5,
      paidAmount: 250.25,
      version: 8,
      clientId: 77,
      source,
    });
  });

  it('returns null when the order is absent', async () => {
    const database = createDatabase({
      responses: ({ text }) => (text.includes('FROM orders o') ? result([]) : result([])),
    });

    await expect(loadOrderAutomationState(database.tx, 404)).resolves.toBeNull();
  });
});

interface QueryCall {
  text: string;
  params: readonly unknown[];
}

interface DatabaseOptions {
  responses: (call: QueryCall) => QueryResult<QueryResultRow>;
}

function createDatabase(options: DatabaseOptions): {
  service: DatabaseService;
  tx: TransactionClient;
  queries: QueryCall[];
} {
  const queries: QueryCall[] = [];
  const query = async <T extends QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> => {
    const call = { text, params };
    queries.push(call);
    return options.responses(call) as unknown as QueryResult<T>;
  };
  const tx = { query } as unknown as TransactionClient;
  const service = {
    query,
    transaction: async <T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> => handler(tx),
  } as unknown as DatabaseService;

  return { service, tx, queries };
}

function result<T extends QueryResultRow>(rows: T[], rowCount = rows.length): QueryResult<T> {
  return {
    rows,
    rowCount,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

function ruleRow(overrides: Record<string, unknown> = {}): QueryResultRow {
  return {
    id: '41',
    name: 'Правило',
    event_type: 'payment.created',
    action_type: 'change_order_status',
    target_status_id: '7',
    conditions_json: { paidShareGte: 50 },
    action_config_json: {},
    priority: '10',
    is_enabled: true,
    version: '1',
    ...overrides,
  };
}

function currentUser(): CurrentUser {
  return {
    id: '1',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
}
