import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../database/database.types';
import {
  markPaymentStatusEventEmitted,
  setPaymentStatusEventContext,
  suppressPaymentStatusEvents,
} from './payment-status-event-context';

const SRC = resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) ? [path] : [];
  });
}

/** `UPDATE orders … payment_status_id = …` (not `doweling_orders`), within one SQL statement. */
const ORDER_PAYMENT_STATUS_WRITE = /UPDATE\s+(?:public\.)?orders\b[^;`]*?\bpayment_status_id\s*=/i;

describe('order.payment_status_changed (migration 291): every writer of orders.payment_status_id sets the event context', () => {
  it('each module that updates orders.payment_status_id sets the context or marks its own event', () => {
    const writers = sourceFiles(SRC)
      .filter((file) => ORDER_PAYMENT_STATUS_WRITE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    // The known writers (plan part A); a new one must be added here after setting the context.
    expect(writers.sort()).toEqual([
      'modules/crm-sync/reverse/pg-bitrix24-reverse-repository.ts',
      'modules/crm-sync/widget/bitrix24-payment-widget.repository.ts',
      'modules/orders/adapters/pg-order-snapshot.ts',
      'modules/orders/adapters/pg-order-transaction-manager.ts',
      'modules/orders/application/order-detail-transfer.service.ts',
      'modules/payments/adapters/pg-payment-repository.ts',
      'modules/production-actions/adapters/pg-production-action-repository.ts',
    ]);
    for (const file of writers) {
      const text = readFileSync(join(SRC, file), 'utf8');
      expect(text, file).toMatch(/setPaymentStatusEventContext\(|markPaymentStatusEventEmitted\(/);
    }
  });

  // Actor/correlation equal to what the path's audit writes (plan part A); unit tests check order and values for
  // payments, order save and the production action, these pin the other paths to the audit's own expressions.
  it.each([
    ['modules/crm-sync/widget/bitrix24-payment-widget.repository.ts', [
      "setPaymentStatusEventContext(tx, { actorUserId: command.erpActorUserId, source: 'crm-sync-widget', correlationId: command.originatingRequestId });",
      'actor: { id: command.erpActorUserId, username: null, role: null },',
      'requestId: command.originatingRequestId,',
    ]],
    ['modules/crm-sync/reverse/pg-bitrix24-reverse-repository.ts', [
      "recalculatePaymentState(tx, orderId, { actorUserId: input.actorUserId, source: 'crm-sync-reverse-auto', correlationId: input.requestId });",
      "recalculatePaymentState(tx, orderId, { actorUserId: input.actorUserId, source: 'crm-sync-reverse-manual', correlationId: input.auditRequestId });",
      "recalculatePaymentState(tx, input.orderId, { actorUserId: input.actorUserId, source: 'crm-sync-reverse-manual', correlationId: input.auditRequestId });",
    ]],
    ['modules/orders/adapters/pg-order-snapshot.ts', [
      "setPaymentStatusEventContext(tx, { actorUserId: command.currentUser.id, source: 'orders-snapshot', correlationId: command.requestId ?? runId });",
      'requestId: command.requestId ?? runId,',
    ]],
    ['modules/orders/application/order-detail-transfer.service.ts', [
      "setPaymentStatusEventContext(tx, { actorUserId: command.currentUser.id, source: 'orders-detail-transfer', correlationId: requestId });",
    ]],
  ] as const)('%s uses the audit actor/correlation', (file, snippets) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    for (const snippet of snippets) expect(text, snippet).toContain(snippet);
  });

  it('the shared Bitrix recalculation sets the context right before its order UPDATE', () => {
    const text = readFileSync(join(SRC, 'modules/crm-sync/reverse/pg-bitrix24-reverse-repository.ts'), 'utf8');
    const body = text.slice(text.indexOf('async function recalculatePaymentState('));
    const context = body.indexOf('await setPaymentStatusEventContext(tx, event);');
    const update = body.search(/UPDATE orders\s+SET paid_amount=\$2, payment_date=\$3, payment_status_id=\$4/);
    expect(context).toBeGreaterThan(-1);
    expect(context).toBeLessThan(update);
    const widget = readFileSync(join(SRC, 'modules/crm-sync/widget/bitrix24-payment-widget.repository.ts'), 'utf8');
    const widgetContext = widget.indexOf("source: 'crm-sync-widget'");
    expect(widgetContext).toBeGreaterThan(-1);
    expect(widgetContext).toBeLessThan(widget.indexOf('payment_status_id=$4, version=version+1'));
  });
});

describe('payment status event context helpers', () => {
  const tx = () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }) as unknown as TransactionClient & {
    query: ReturnType<typeof vi.fn>;
  };

  it('sets transaction-local actor, source and correlation (empty strings for missing values)', async () => {
    const client = tx();
    await setPaymentStatusEventContext(client, { actorUserId: 7, source: 'payments', correlationId: 'req-1' });
    await setPaymentStatusEventContext(client, { actorUserId: null, source: 'crm-sync-widget' });
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain("set_config('erp.event_actor_user_id', $1, true)");
    expect(sql).toContain("set_config('erp.event_source', $2, true)");
    expect(sql).toContain("set_config('erp.event_correlation_id', $3, true)");
    expect(params).toEqual(['7', 'payments', 'req-1']);
    expect(client.query.mock.calls[1][1]).toEqual(['', 'crm-sync-widget', '']);
  });

  it('marks the own event and suppresses only with a reason', async () => {
    const client = tx();
    await markPaymentStatusEventEmitted(client);
    expect(client.query.mock.calls[0][0]).toContain("set_config('erp.payment_status_event', 'emitted', true)");
    await expect(suppressPaymentStatusEvents(client, '  ')).rejects.toThrow(/requires a reason/);
    await suppressPaymentStatusEvents(client, 'backfill 291');
    expect(client.query.mock.calls[1][1]).toEqual(['backfill 291']);
  });
});
