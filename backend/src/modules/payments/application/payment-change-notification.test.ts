import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { PaymentAuditRow } from './payment-change-audit';
import { recordPaymentNotifications, type NotifiedPaymentChange, type PaymentNotificationPayload } from './payment-change-notification';

const WEBHOOK = 'https://x.bitrix24.kz/rest/1/abcdef0123456789abcd/';

function row(overrides: Partial<PaymentAuditRow> = {}): PaymentAuditRow {
  return {
    paymentId: 30, orderId: 15, typePaidId: 2, typePaidName: 'Наличные', amount: 250, paymentDate: '2026-10-19',
    notes: 'секретная заметка', refKey1c: 'ref-1c', createdBy: 1, editedBy: 1, createdAt: '2026-10-19T00:00:00Z',
    updatedAt: null, deleted: false, ...overrides,
  };
}

function fakeClient(orders: Record<number, string> = { 15: 'Заказ 15', 16: 'Заказ 16' }, fullName: string | null = 'Иванов Иван') {
  const inserts: Array<{ orderId: number; requestId: string; auditIds: string[]; actorId: number | null; payload: PaymentNotificationPayload }> = [];
  const client = {
    inserts,
    async query(text: string, params: readonly unknown[] = []) {
      if (/FROM orders o/.test(text)) {
        const ids = params[0] as number[];
        return {
          rows: ids.filter((id) => orders[id] !== undefined).map((id) => ({
            order_id: id, order_name: orders[id], final_amount: '1000', paid_amount: '250', payment_status_name: 'Частично оплачен',
          })),
        };
      }
      if (/FROM users WHERE/.test(text)) return { rows: [{ full_name: fullName, username: 'ivanov' }] };
      if (/to_regclass/.test(text)) return { rows: [{ present: true }] };
      if (/payment_notification_sync_event c/.test(text)) return { rows: [{ outbox_event_id: `event-${String(params[0])}` }] };
      if (/INSERT INTO crm_sync_payment_notification/.test(text)) {
        inserts.push({
          orderId: params[1] as number, requestId: params[2] as string, auditIds: params[3] as string[],
          actorId: params[4] as number | null, payload: JSON.parse(params[5] as string),
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query ${text}`);
    },
  };
  return client as typeof client & DatabaseClient;
}

const actor = { id: '7', username: 'ivanov', role: 'manager' };
const input = (origin: Parameters<typeof recordPaymentNotifications>[1]['origin'] = 'order_form') => ({ origin, requestId: 'req-1', actor });
const change = (event: NotifiedPaymentChange['event'], was: PaymentAuditRow | null, now: PaymentAuditRow | null, auditId = '100'): NotifiedPaymentChange =>
  ({ event, was, now, auditId });

describe('recordPaymentNotifications', () => {
  it.each(['order_form', 'payment_command', 'snapshot_import'] as const)('writes one row per order for %s', async (origin) => {
    const client = fakeClient();
    const written = await recordPaymentNotifications(client, input(origin), [
      change('payments.create', null, row(), '100'),
      change('payments.update', row({ paymentId: 31, amount: 10 }), row({ paymentId: 31, amount: 20 }), '101'),
    ]);
    expect(written).toBe(1);
    expect(client.inserts[0]).toMatchObject({ orderId: 15, requestId: 'req-1', auditIds: ['100', '101'], actorId: 7 });
    expect(client.inserts[0].payload).toEqual({
      orderName: 'Заказ 15', finalAmount: 1000, paidAfter: 250, statusAfter: 'Частично оплачен', actorName: 'Иванов Иван',
      paymentIds: [30, 31],
      lines: [
        { kind: 'added', amountAfter: 250, dateAfter: '2026-10-19', typeAfter: 'Наличные' },
        { kind: 'changed', amountBefore: 10, amountAfter: 20 },
      ],
    });
  });

  it.each(['bitrix24_reverse_manual', 'bitrix24_reverse_auto', 'bitrix24_widget'] as const)('writes nothing for %s (echo of Bitrix24)', async (origin) => {
    const client = fakeClient();
    expect(await recordPaymentNotifications(client, input(origin), [change('payments.create', null, row())])).toBe(0);
    expect(client.inserts).toHaveLength(0);
  });

  it('writes nothing for a change of the note or the 1C reference only', async () => {
    const client = fakeClient();
    expect(await recordPaymentNotifications(client, input(), [
      change('payments.update', row(), row({ notes: 'другая', refKey1c: 'ref-2' })),
    ])).toBe(0);
  });

  it('gives a moved payment a row in each order with the totals of that order', async () => {
    const client = fakeClient();
    await recordPaymentNotifications(client, input(), [change('payments.update', row(), row({ orderId: 16 }))]);
    expect(client.inserts.map((insert) => [insert.orderId, insert.payload.lines])).toEqual([
      [15, [{ kind: 'moved_out', otherOrderName: 'Заказ 16', amountBefore: 250, dateBefore: '2026-10-19', typeBefore: 'Наличные' }]],
      [16, [{ kind: 'moved_in', otherOrderName: 'Заказ 15', amountAfter: 250, dateAfter: '2026-10-19', typeAfter: 'Наличные' }]],
    ]);
  });

  it('records deletes and restores', async () => {
    const client = fakeClient();
    await recordPaymentNotifications(client, input(), [
      change('payments.delete', row(), row({ deleted: true })),
      change('payments.restore', row({ paymentId: 31, deleted: true }), row({ paymentId: 31 })),
    ]);
    expect(client.inserts[0].payload.lines.map((line) => line.kind)).toEqual(['deleted', 'restored']);
  });

  it('never stores the note, the 1C reference or a webhook URL from names', async () => {
    const client = fakeClient({ 15: `Заказ ${WEBHOOK}`, 16: 'x' }, `Иван ${WEBHOOK}`);
    await recordPaymentNotifications(client, input(), [
      change('payments.create', null, row({ typePaidName: `Тип ${WEBHOOK}` })),
    ]);
    const quoted = fakeClient({ 15: '{"password":"a\\" x1y2z3"}' }, 'Иван password=q1,w2e3r4');
    await recordPaymentNotifications(quoted, input(), [change('payments.create', null, row())]);
    expect(JSON.stringify(quoted.inserts[0].payload)).not.toMatch(/x1y2z3|w2e3r4/);
    const stored = JSON.stringify(client.inserts[0].payload);
    expect(stored).not.toContain('abcdef0123456789abcd');
    expect(stored).not.toContain('bitrix24.kz');
    expect(stored).not.toContain('секретная заметка');
    expect(stored).not.toContain('ref-1c');
  });

  it('falls back to the login when the user has no full name, and skips orders that no longer exist', async () => {
    const client = fakeClient({ 16: 'Заказ 16' }, null);
    await recordPaymentNotifications(client, input(), [
      change('payments.create', null, row()),
      change('payments.create', null, row({ paymentId: 31, orderId: 16 })),
    ]);
    expect(client.inserts.map((insert) => [insert.orderId, insert.payload.actorName])).toEqual([[16, 'ivanov']]);
  });

  it('propagates an insert failure (the payment command rolls back)', async () => {
    const client = fakeClient();
    const failing = { ...client, async query(text: string, params?: readonly unknown[]) {
      if (/INSERT INTO crm_sync_payment_notification/.test(text)) throw new Error('insert failed');
      return client.query(text, params);
    } } as unknown as DatabaseClient;
    await expect(recordPaymentNotifications(failing, input(), [change('payments.create', null, row())])).rejects.toThrow('insert failed');
  });
});
