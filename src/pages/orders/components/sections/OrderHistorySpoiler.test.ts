import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rowFromProjection } from './OrderHistorySpoiler';

const source = readFileSync(new URL('./OrderHistorySpoiler.tsx', import.meta.url), 'utf8');

describe('order history spoiler', () => {
  it('shows a projected event as what/when/who with the resulting status only', () => {
    expect(rowFromProjection({
      auditId: 'a1',
      event: 'orders.status_change',
      createdAt: '2026-10-01T07:30:00.000Z',
      actorName: 'manager',
      entityType: 'order',
      statusField: 'orderStatus',
      statusName: 'В производстве',
      stageCode: null,
    })).toMatchObject({
      key: 'a1',
      actor: 'manager',
      changes: [{ label: 'Статус', before: '', after: 'В производстве' }],
      notes: [],
    });
  });

  it('labels the payment status and falls back to «Система» without an actor', () => {
    const row = rowFromProjection({
      auditId: 'a2',
      event: 'orders.payment_status_change',
      createdAt: '2026-10-01T07:30:00.000Z',
      actorName: null,
      entityType: 'order',
      statusField: 'paymentStatus',
      statusName: 'Оплачен',
      stageCode: null,
    });

    expect(row.actor).toBe('Система');
    expect(row.changes).toEqual([{ label: 'Статус оплаты', before: '', after: 'Оплачен' }]);
  });

  it('reads the order history for everyone and keeps the journal for audit.view', () => {
    expect(source).toContain("can('audit.view')");
    expect(source).toContain('ordersApi.history(orderId, { page: nextPage, pageSize: PAGE_SIZE })');
    expect(source).toContain("auditApi.list({ scope: 'business', orderIds: [orderId], page: nextPage, pageSize: PAGE_SIZE })");
    expect(source).not.toContain('Нет доступа к журналу истории');
  });
});
