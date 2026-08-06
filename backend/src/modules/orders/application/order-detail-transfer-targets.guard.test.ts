import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import type { StatusAutomationEvent } from '../../status-automation/application/status-automation.types';
import { emitCreatedTransferTargetAutomation } from './order-detail-transfer.service';

const source = readFileSync(join(__dirname, 'order-detail-transfer.service.ts'), 'utf8');

describe('order detail transfer target list contract', () => {
  it('lists last-month orders and prioritizes targets with the source client', () => {
    expect(source).toContain("o.order_date >= (CURRENT_DATE - INTERVAL '1 month')");
    expect(source).toContain('LEFT JOIN clients c ON c.client_id = o.client_id');
    expect(source).toContain('CASE WHEN o.client_id = $3 THEN 0 ELSE 1 END');
    expect(source).not.toContain('AND o.client_id = $1');
  });

  it('returns display fields required by the target-order selector', () => {
    expect(source).toContain('clientId: toNumber(row.client_id)');
    expect(source).toContain('clientName: row.client_name');
    expect(source).toContain('orderDate: dateOnly(row.order_date)');
    expect(source).toContain('orderStatusName: row.order_status_name');
  });

  it('records self-contained audit metadata for moved details and order route', () => {
    expect(source).toContain("event: 'orders.detail_transfer'");
    expect(source).toContain('sourceOrderName');
    expect(source).toContain('targetOrderName');
    expect(source).toContain('movedDetails: movedDetailAuditItems');
    expect(source).toContain('sourceDetailNumber');
    expect(source).toContain('targetDetailNumber');
  });

  it('emits canonical create and inherited planned-date automation for a new target', () => {
    expect(source).toContain("eventType: 'order.created'");
    expect(source).toContain("eventType: 'order.planned_completion_date_changed'");
    expect(source).toContain('inheritedPlannedCompletionDate: dateOnlyOrNull(source.planned_completion_date)');
    expect(source).toContain('plannedCompletionDateBefore: null');
    expect(source).toContain('plannedCompletionDateAfter: input.inheritedPlannedCompletionDate');
    expect(source.indexOf("eventType: 'order.created'")).toBeLessThan(
      source.indexOf("eventType: 'order.planned_completion_date_changed'"),
    );
    expect(source).toContain("`${command.idempotencyKey}:order.details_transferred`");
  });

  it('emits created then inherited planned-date events with independent outbox keys', async () => {
    const outbox: Array<{ eventType: string; payload: Record<string, unknown>; idempotencyKey: string }> = [];
    const versions = [8, 9];
    const tx = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO outbox_events')) {
          outbox.push({
            eventType: String(params[0]),
            payload: JSON.parse(String(params[2])) as Record<string, unknown>,
            idempotencyKey: String(params[3]),
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT version FROM orders')) {
          return { rows: [{ version: versions.shift() }], rowCount: 1 };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      raw: {},
    } as unknown as TransactionClient;
    const events: StatusAutomationEvent[] = [];
    const evaluate = vi.fn(async (_tx: TransactionClient, event: StatusAutomationEvent) => {
      events.push(event);
    });

    const version = await emitCreatedTransferTargetAutomation(tx, {
      orderId: 77,
      clientId: 15,
      actor: {
        id: 'manager-1',
        username: 'manager',
        role: 'manager',
        roleId: 2,
        permissions: [],
      },
      requestId: 'request-transfer',
      sourceIdempotencyKey: 'transfer-key',
      initialVersion: 7,
      inheritedPlannedCompletionDate: '2026-08-20',
    }, evaluate);

    expect(version).toBe(9);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: 'order.created',
        orderId: 77,
        sourceIdempotencyKey: 'transfer-key',
      }),
      expect.objectContaining({
        eventType: 'order.planned_completion_date_changed',
        orderId: 77,
        plannedCompletionDateBefore: null,
        plannedCompletionDateAfter: '2026-08-20',
        sourceIdempotencyKey: 'transfer-key',
      }),
    ]);
    expect(outbox).toEqual([
      expect.objectContaining({
        eventType: 'order.created',
        idempotencyKey: 'transfer-key:order.created',
        payload: expect.objectContaining({
          action: 'order_created',
          version: 7,
          idempotencyKey: 'transfer-key',
          outboxIdempotencyKey: 'transfer-key:order.created',
        }),
      }),
      expect.objectContaining({
        eventType: 'order.planned_completion_date_changed',
        idempotencyKey: 'transfer-key:order.planned_completion_date_changed',
        payload: expect.objectContaining({
          action: 'planned_completion_date_change',
          plannedCompletionDateBefore: null,
          plannedCompletionDateAfter: '2026-08-20',
          version: 8,
          idempotencyKey: 'transfer-key',
          outboxIdempotencyKey: 'transfer-key:order.planned_completion_date_changed',
        }),
      }),
    ]);
  });

  it('does not emit a planned-date event when the new target inherits no date', async () => {
    const outboxEventTypes: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO outbox_events')) {
          outboxEventTypes.push(String(params[0]));
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT version FROM orders')) {
          return { rows: [{ version: 8 }], rowCount: 1 };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      raw: {},
    } as unknown as TransactionClient;
    const events: StatusAutomationEvent[] = [];

    const version = await emitCreatedTransferTargetAutomation(tx, {
      orderId: 77,
      clientId: 15,
      actor: {
        id: 'manager-1',
        username: 'manager',
        role: 'manager',
        roleId: 2,
        permissions: [],
      },
      requestId: 'request-transfer-no-date',
      sourceIdempotencyKey: 'transfer-no-date-key',
      initialVersion: 7,
      inheritedPlannedCompletionDate: null,
    }, async (_tx, event) => {
      events.push(event);
    });

    expect(version).toBe(8);
    expect(outboxEventTypes).toEqual(['order.created']);
    expect(events.map((event) => event.eventType)).toEqual(['order.created']);
  });
});
