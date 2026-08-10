import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { TransactionClient } from '../../../database/database.types';
import {
  changeDetailsProductionStatusFromAutomationInTransaction,
  changeOrderStatusFromAutomationInTransaction,
  changeProductionStatusFromAutomationInTransaction,
  type AutomationActionContext,
} from './pg-production-action-repository';

describe('production-action automation in-transaction actions', () => {
  it('skips an order status action when the target is already current without audit or outbox', async () => {
    const database = createAutomationTx({ orderStatusId: 7 });

    await expect(
      changeOrderStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toEqual({ status: 'skipped', skipReason: 'same_status' });

    expect(database.auditCalls).toHaveLength(0);
    expect(database.outboxCalls).toHaveLength(0);
  });

  it('cascades a production status automation action through details even when detail-derived mode is active', async () => {
    const database = createAutomationTx({
      productionStatusFromDetailsEnabled: true,
      detailRows: [
        { detail_id: 101, production_status_id: 1 },
        { detail_id: 102, production_status_id: 2 },
      ],
      updatedDetailIds: [101, 102],
      recalcOrderProductionStatusId: 7,
    });

    await expect(
      changeProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toMatchObject({ status: 'executed', auditId: 42 });

    expect(database.sql.some((sql) => sql.startsWith('UPDATE order_details'))).toBe(true);
    expect(database.recalcCalls).toEqual([15]);
    expect(database.auditCalls[0]?.metadata).toMatchObject({
      productionStatusFromDetailsEnabled: true,
      affectedDetailCount: 2,
    });
    expect(database.outboxCalls[0]?.payload).toMatchObject({
      productionStatusFromDetailsEnabled: true,
    });
  });

  it('writes automation metadata and preserves the supplied outbox idempotency key', async () => {
    const database = createAutomationTx({ orderStatusId: 5 });
    const context = automationContext();

    await expect(
      changeOrderStatusFromAutomationInTransaction(database.tx, 15, 7, context),
    ).resolves.toMatchObject({ status: 'executed', auditId: 42 });

    expect(database.auditCalls[0]).toMatchObject({
      event: 'orders.status_change',
      source: 'backend-status-automation',
      metadata: expect.objectContaining({
        ruleId: 21,
        eventType: 'order.status_changed',
      }),
    });
    expect(database.outboxCalls[0]).toMatchObject({
      eventType: 'order.status_changed',
      idempotencyKey: context.outboxIdempotencyKey,
      payload: expect.objectContaining({ origin: 'automation' }),
    });
  });

  it('skips detail automation when the order has no live details', async () => {
    const database = createAutomationTx({ detailRows: [] });

    await expect(
      changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toEqual({ status: 'skipped', skipReason: 'no_details' });

    expect(database.auditCalls).toHaveLength(0);
    expect(database.outboxCalls).toHaveLength(0);
  });

  it('skips detail automation without version bump when every live detail already has the target status', async () => {
    const database = createAutomationTx({
      detailRows: [
        { detail_id: 101, production_status_id: 7 },
        { detail_id: 102, production_status_id: 7 },
      ],
    });

    await expect(
      changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toEqual({ status: 'skipped', skipReason: 'same_status' });

    expect(database.auditCalls).toHaveLength(0);
    expect(database.outboxCalls).toHaveLength(0);
    expect(database.sql.some((sql) => sql.startsWith('UPDATE orders'))).toBe(false);
    expect(database.sql.some((sql) => sql.startsWith('UPDATE order_details'))).toBe(false);
  });

  it('locks the order before details and recalculates in details auto mode', async () => {
    const database = createAutomationTx({
      productionStatusFromDetailsEnabled: true,
      detailRows: [
        { detail_id: 102, production_status_id: 1 },
        { detail_id: 101, production_status_id: 2 },
      ],
      updatedDetailIds: [101, 102],
    });

    await expect(
      changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toMatchObject({ status: 'executed', auditId: 42 });

    const orderLockIndex = database.sql.findIndex((sql) => sql.includes('FROM orders') && sql.includes('FOR UPDATE'));
    const detailLockIndex = database.sql.findIndex((sql) => sql.includes('FROM order_details') && sql.includes('FOR UPDATE'));
    const detailUpdateIndex = database.sql.findIndex((sql) => sql.startsWith('UPDATE order_details'));
    expect(orderLockIndex).toBeGreaterThanOrEqual(0);
    expect(detailLockIndex).toBeGreaterThan(orderLockIndex);
    expect(detailUpdateIndex).toBeGreaterThan(detailLockIndex);
    expect(database.recalcCalls).toEqual([15]);
  });
});

interface AutomationTxOptions {
  orderStatusId?: number;
  productionStatusId?: number | null;
  productionStatusFromDetailsEnabled?: boolean;
  detailRows?: Array<{ detail_id: number; production_status_id: number | null }>;
  updatedDetailIds?: number[];
  recalcOrderProductionStatusId?: number;
}

interface AutomationTxState {
  tx: TransactionClient;
  sql: string[];
  auditCalls: Array<{ event: unknown; source: unknown; metadata: Record<string, unknown> }>;
  outboxCalls: Array<{
    eventType: unknown;
    idempotencyKey: unknown;
    payload: Record<string, unknown>;
  }>;
  recalcCalls: number[];
}

function createAutomationTx(options: AutomationTxOptions = {}): AutomationTxState {
  const sql: string[] = [];
  const auditCalls: AutomationTxState['auditCalls'] = [];
  const outboxCalls: AutomationTxState['outboxCalls'] = [];
  const recalcCalls: number[] = [];
  const detailRows = options.detailRows ?? [{ detail_id: 101, production_status_id: 1 }];

  const tx = {
    async query<T extends object>(text: string, params: readonly unknown[] = []) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      sql.push(normalized);

      if (normalized.includes('FROM orders') && normalized.includes('FOR UPDATE')) {
        return {
          rows: [{
            order_id: 15,
            client_id: 969,
            order_date: '2026-05-01',
            planned_completion_date: '2026-05-10',
            order_status_id: options.orderStatusId ?? 5,
            payment_status_id: 1,
            production_status_id: options.productionStatusId ?? 1,
            production_status_from_details_enabled: options.productionStatusFromDetailsEnabled ?? false,
            version: 3,
            created_by: 1,
            manager_id: null,
          } as T],
        };
      }
      if (normalized.startsWith('SELECT order_status_id, order_status_name')) {
        return { rows: [{ order_status_id: params[0], order_status_name: 'Выдан' } as T] };
      }
      if (normalized.startsWith('SELECT production_status_id, production_status_name')) {
        return { rows: [{ production_status_id: params[0], production_status_name: 'Крой', production_status_code: 'cut' } as T] };
      }
      if (normalized.includes('FROM order_details') && normalized.includes('FOR UPDATE')) {
        return { rows: detailRows as T[] };
      }
      if (normalized.startsWith('UPDATE order_details')) {
        return { rows: (options.updatedDetailIds ?? detailRows.map((row) => row.detail_id)).map((detail_id) => ({ detail_id } as T)) };
      }
      if (normalized.startsWith('UPDATE orders SET order_status_id')) {
        return { rows: [{ version: 4 } as T] };
      }
      if (normalized.startsWith('UPDATE orders SET production_status_id')) {
        return {
          rows: [{
            version: 4,
            production_status_id:
              options.recalcOrderProductionStatusId ?? params[2] ?? options.productionStatusId ?? 1,
          } as T],
        };
      }
      if (normalized.startsWith('UPDATE orders SET production_status_from_details_enabled = true')) {
        return {
          rows: [{
            version: 4,
            production_status_id:
              options.recalcOrderProductionStatusId ?? options.productionStatusId ?? 1,
          } as T],
        };
      }
      if (normalized.startsWith('UPDATE orders SET version = version + 1')) {
        return { rows: [{ version: 4, production_status_id: options.productionStatusId ?? 1 } as T] };
      }
      if (normalized.startsWith('SELECT recalc_order_production_status')) {
        recalcCalls.push(Number(params[0]));
        return { rows: [] as T[] };
      }
      if (normalized.startsWith('INSERT INTO audit_log')) {
        const metadata = JSON.parse(String(params[22])) as Record<string, unknown>;
        auditCalls.push({ event: params[0], source: params[7], metadata });
        return { rows: [{ audit_id: 42 } as T] };
      }
      if (normalized.startsWith('INSERT INTO outbox_events')) {
        outboxCalls.push({
          eventType: params[0],
          idempotencyKey: params[4],
          payload: JSON.parse(String(params[3])) as Record<string, unknown>,
        });
        return { rows: [] as T[] };
      }
      return { rows: [] as T[] };
    },
  };

  return {
    tx: tx as unknown as TransactionClient,
    sql,
    auditCalls,
    outboxCalls,
    recalcCalls,
  };
}

function automationContext(): AutomationActionContext {
  return {
    actor: currentUser(),
    requestId: 'automation-request-1',
    ruleId: 21,
    ruleName: 'После выдачи',
    eventType: 'order.status_changed',
    outboxIdempotencyKey: 'source-key-1:automation:21',
  };
}

function currentUser(): CurrentUser {
  return {
    id: '1',
    username: 'automation-user',
    role: 'admin',
    roleId: 1,
    permissions: [],
  };
}
