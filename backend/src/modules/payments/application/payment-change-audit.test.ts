import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import {
  type PaymentAuditRow,
  type PaymentAuditState,
  recordPaymentChanges,
} from './payment-change-audit';

describe('recordPaymentChanges', () => {
  it('writes payments.create with the order totals before and after', async () => {
    const client = fakeClient();
    const written = await recordPaymentChanges(client, input(state([], { 15: 0 }), state([row()], { 15: 250 })));

    expect(written).toBe(1);
    const [audit] = client.audits();
    expect(audit.event).toBe('payments.create');
    expect(audit.before).toEqual({ orderPaidAmount: 0, orderPaymentStatusName: null });
    expect(audit.after).toMatchObject({ amount: 250, orderPaidAmount: 250 });
    expect(audit.diff).toMatchObject({ amount: { from: null, to: 250 } });
    expect(audit.metadata).toEqual({ origin: 'order_form', previousOrderId: null });
    expect(audit.relatedOrderId).toBe(15);
    expect(audit.relatedPaymentId).toBe(30);
  });

  it('writes payments.update only for the changed fields, excluding authorship', async () => {
    const client = fakeClient();
    await recordPaymentChanges(client, input(
      state([row()], { 15: 250 }),
      state([row({ amount: 249, editedBy: 7, updatedAt: '2026-10-19T00:00:00.000Z' })], { 15: 249 }),
    ));

    const [audit] = client.audits();
    expect(audit.event).toBe('payments.update');
    expect(Object.keys(audit.diff).sort()).toEqual(['amount', 'orderPaidAmount']);
  });

  it.each([
    ['refKey1c', { refKey1c: 'b7a1c2d3-0000-0000-0000-000000000001' }],
    ['typePaidId', { typePaidId: 2, typePaidName: 'Безнал' }],
    ['paymentDate', { paymentDate: '2026-10-18' }],
    ['notes', { notes: 'аванс' }],
  ] as const)('detects a change of %s alone', async (field, change) => {
    const client = fakeClient();
    await recordPaymentChanges(client, input(state([row()], { 15: 250 }), state([row(change)], { 15: 250 })));

    const [audit] = client.audits();
    expect(audit.event).toBe('payments.update');
    expect(Object.keys(audit.diff)).toContain(field);
  });

  it('writes nothing when no payment changed (replay)', async () => {
    const client = fakeClient();
    const written = await recordPaymentChanges(client, input(state([row()], { 15: 250 }), state([row()], { 15: 250 })));

    expect(written).toBe(0);
    expect(client.queries).toHaveLength(0);
  });

  it('writes payments.delete for a removed row and for a soft delete', async () => {
    const client = fakeClient();
    await recordPaymentChanges(client, input(
      state([row(), row({ paymentId: 31 })], { 15: 500 }),
      state([row({ paymentId: 31, deleted: true })], { 15: 0 }),
    ));

    const audits = client.audits();
    expect(audits.map((a) => [a.event, a.relatedPaymentId])).toEqual([
      ['payments.delete', 30],
      ['payments.delete', 31],
    ]);
    expect(audits[0].after).toEqual({ deleted: true, orderPaidAmount: 0, orderPaymentStatusName: null });
  });

  it('writes payments.restore when a soft-deleted row becomes active', async () => {
    const client = fakeClient();
    await recordPaymentChanges(client, input(
      state([row({ deleted: true })], { 15: 0 }),
      state([row()], { 15: 250 }),
    ));

    expect(client.audits().map((a) => a.event)).toEqual(['payments.restore']);
  });

  it('records a move between orders as one update linked to both orders', async () => {
    const client = fakeClient();
    await recordPaymentChanges(client, input(
      state([row()], { 15: 250, 16: 0 }),
      state([row({ orderId: 16 })], { 15: 0, 16: 250 }),
    ));

    const audits = client.audits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event: 'payments.update',
      relatedOrderId: 16,
      relatedEntities: [{ entityType: 'order', entityId: 16 }, { entityType: 'order', entityId: 15 }],
      metadata: { origin: 'order_form', previousOrderId: 15 },
    });
    expect(audits[0].before).toMatchObject({ orderId: 15, orderPaidAmount: 250 });
    expect(audits[0].after).toMatchObject({ orderId: 16, orderPaidAmount: 250 });
  });

  it('omits order totals for an order whose totals the transaction did not change', async () => {
    const client = fakeClient();
    // Moved from 15 (totals not recalculated by this command) to 16 (recalculated).
    await recordPaymentChanges(client, input(state([row()], { 16: 0 }), state([row({ orderId: 16 })], { 16: 250 })));

    const [audit] = client.audits();
    expect(audit.before).not.toHaveProperty('orderPaidAmount');
    expect(audit.after).toMatchObject({ orderId: 16, orderPaidAmount: 250 });
  });

  it('masks a pasted Bitrix24 webhook credential in notes before persisting', async () => {
    const client = fakeClient();
    const notes = 'см. https://x.bitrix24.kz/rest/1/abcdef0123456789abcd/crm.deal.get APP_SID=secret123';
    await recordPaymentChanges(client, input(state([row()], { 15: 250 }), state([row({ notes })], { 15: 250 })));

    const stored = JSON.stringify(client.queries.find((q) => /INSERT INTO audit_log \(/.test(q.text))!.params);
    expect(stored).not.toContain('abcdef0123456789abcd');
    expect(stored).not.toContain('secret123');
    expect(stored).toContain('см. https://x.bitrix24.kz/rest/1/');
  });

  it('looks up the author name when only the user id is known', async () => {
    const client = fakeClient({ username: 'ivanov', role_code: 'manager' });
    await recordPaymentChanges(client, {
      ...input(state([], { 15: 0 }), state([row()], { 15: 250 })),
      actor: { id: 7, username: null, role: null },
      origin: 'bitrix24_reverse_manual',
      requestRef: { incomingRequestId: 5 },
    });

    const [audit] = client.audits();
    expect(audit).toMatchObject({ userId: '7', username: 'ivanov', role: 'manager' });
    expect(audit.metadata).toMatchObject({ origin: 'bitrix24_reverse_manual', requestRef: { incomingRequestId: 5 } });
  });

  it('keeps the given author and does not query users when the name is known', async () => {
    const client = fakeClient();
    await recordPaymentChanges(client, input(state([], { 15: 0 }), state([row()], { 15: 250 })));

    // The audit itself does not look the author up (the notification reads the full name separately).
    expect(client.queries.some((q) => /FROM users u LEFT JOIN roles/.test(q.text))).toBe(false);
    expect(client.audits()[0]).toMatchObject({ userId: '1', username: 'admin', role: 'admin' });
  });
});

function row(overrides: Partial<PaymentAuditRow> = {}): PaymentAuditRow {
  return {
    paymentId: 30,
    orderId: 15,
    typePaidId: 1,
    typePaidName: 'Наличные',
    amount: 250,
    paymentDate: '2026-10-19',
    notes: null,
    refKey1c: null,
    createdBy: 1,
    editedBy: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: null,
    deleted: false,
    ...overrides,
  };
}

function state(rows: PaymentAuditRow[], paid: Record<number, number>): PaymentAuditState {
  return {
    payments: new Map(rows.map((r) => [r.paymentId, r])),
    orders: new Map(Object.entries(paid).map(([id, amount]) => [Number(id), {
      paidAmount: amount,
      paymentStatusId: null,
      paymentStatusName: null,
    }])),
  };
}

function input(before: PaymentAuditState, after: PaymentAuditState) {
  return {
    before,
    after,
    actor: { id: '1', username: 'admin', role: 'admin' },
    source: 'backend-orders-command',
    requestId: 'rq-1',
    origin: 'order_form' as const,
  };
}

interface RecordedAudit {
  event: string;
  userId: string | null;
  username: string | null;
  role: string | null;
  relatedOrderId: number | null;
  relatedPaymentId: number | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: Record<string, unknown>;
  metadata: Record<string, unknown>;
  relatedEntities: Array<{ entityType: string; entityId: number }>;
}

function fakeClient(user?: { username: string; role_code: string | null }) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const client = {
    queries,
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      if (/FROM users/.test(text)) return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
      if (/INSERT INTO audit_log \(/.test(text)) return { rows: [{ audit_id: String(queries.length) }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    audits(): RecordedAudit[] {
      const inserts = queries.filter((q) => /INSERT INTO audit_log \(/.test(q.text));
      return inserts
        .filter((q) => String(q.params[0]).startsWith('payments.'))
        .map((q) => ({
          event: String(q.params[0]),
          userId: q.params[3] === null ? null : String(q.params[3]),
          username: q.params[4] as string | null,
          role: q.params[5] as string | null,
          relatedOrderId: q.params[8] as number | null,
          relatedPaymentId: q.params[10] as number | null,
          before: JSON.parse(q.params[19] as string),
          after: JSON.parse(q.params[20] as string),
          diff: JSON.parse(q.params[21] as string),
          metadata: JSON.parse(q.params[22] as string),
          relatedEntities: relatedEntitiesOf(queries, q),
        }));
    },
  };
  return client as typeof client & DatabaseClient;
}

/** Related entities are written one insert each, right after the audit row. */
function relatedEntitiesOf(
  queries: Array<{ text: string; params: readonly unknown[] }>,
  audit: { text: string; params: readonly unknown[] },
): Array<{ entityType: string; entityId: number }> {
  const entities: Array<{ entityType: string; entityId: number }> = [];
  for (const query of queries.slice(queries.indexOf(audit) + 1)) {
    if (!/INSERT INTO audit_log_related_entity/.test(query.text)) break;
    entities.push({ entityType: String(query.params[1]), entityId: Number(query.params[2]) });
  }
  return entities;
}
