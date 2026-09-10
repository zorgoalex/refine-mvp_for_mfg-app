import { describe, it, expect, vi } from 'vitest';
import { Bitrix24ReverseAdminController } from './bitrix24-reverse-admin.controller';

describe('Bitrix authorship permission boundary', () => {
  it.each([false, true])('gates metadata on CRM view permission: %s', async allowed => {
    const repository = { getMappedOrderPayments: vi.fn().mockResolvedValue({ linked: true, bitrixDealId: '77' }) };
    const processor = { reconcileMappedOrderPaymentsNow: vi.fn() };
    const controller = new Bitrix24ReverseAdminController(repository as never, processor as never);
    const request = { user: { id: '7', role: 'manager', permissions: ['orders.view_financials', ...(allowed ? ['bitrix24.requests.view'] : [])] }, requestId: 'test' };
    await controller.getMappedOrderPayments(request as never, '20');
    expect(repository.getMappedOrderPayments).toHaveBeenLastCalledWith(20, { mode: 'assigned', userId: 7 }, allowed);
    await controller.reconcileMappedOrderPayments(request as never, '20');
    expect(repository.getMappedOrderPayments).toHaveBeenLastCalledWith(20, { mode: 'assigned', userId: 7 }, allowed);
  });
});
