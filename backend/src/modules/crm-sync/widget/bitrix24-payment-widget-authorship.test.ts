import { describe, it, expect, vi } from 'vitest';
import { Bitrix24PaymentWidgetRepository } from './bitrix24-payment-widget.repository';

describe('Widget command author immutability', () => {
  it('returns original actor on replay without an insert, update or audit', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ request_hash: 'a'.repeat(64), bitrix_actor_user_id: '17', erp_actor_user_id: 7, bitrix_executor_user_id: '1', amount: '100.00', payment_date: '2026-09-10', request_id: null, erp_order_id: 20, expected_order_version: 1 }] });
    const audit = { record: vi.fn() };
    const repository = new Bitrix24PaymentWidgetRepository({ transaction: (fn: (tx: unknown) => unknown) => fn({ query }) } as never, audit as never);
    const result = await repository.createCommand({ requestHash: 'a'.repeat(64), session: { memberId: 'test', bitrixUserId: '17' }, idempotencyKey: 'test-key', actorDisplayName: 'New name must not overwrite old evidence' } as never);
    expect(result).toMatchObject({ created: false, command: { bitrixActorUserId: '17', bitrixExecutorUserId: '1' } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('SELECT *');
    expect(audit.record).not.toHaveBeenCalled();
  });
});
