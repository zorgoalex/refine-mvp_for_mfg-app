import { describe, expect, it, vi } from 'vitest';
import { Bitrix24PaidConversionService } from './bitrix24-paid-conversion.service';

function setup(overrides = {}, ready = true, widgetEnabled = true) {
  const repository = { autoConvertPaidCrmRequest: vi.fn().mockResolvedValue({ status: 'converted' }) };
  const config = { getReverseSync: () => ({ enabled: true, autoConvertPaidRequests: true, relayOwner: 'in_process', dryRun: false,
    actorUserId: 86, initialOrderStatusCode: 'legacy_1', initialProductionStatusCode: 'drawn', ...overrides }),
  isProductionInitializationReady: () => ready, getPaymentWidget: () => ({ enabled: widgetEnabled }) };
  return { repository, service: new Bitrix24PaidConversionService(repository as never, config as never) };
}
const event = { dealId: '123', requestId: 'E2E-event', eventId: 'E2E-event', lockToken: 'lease' };
describe('paid conversion runtime gates', () => {
  it.each([{ autoConvertPaidRequests: false }, { enabled: false }, { relayOwner: 'none' }, { dryRun: true }, { actorUserId: null }])('does not mutate with %j', async (flags) => {
    const { service, repository } = setup(flags);
    expect(await service.run(event)).toEqual({ status: 'unchanged' });
    expect(repository.autoConvertPaidCrmRequest).not.toHaveBeenCalled();
  });
  it('requires initialization readiness and inbound ownership', async () => {
    const { service, repository } = setup({}, false);
    await service.run(event);
    expect(repository.autoConvertPaidCrmRequest).not.toHaveBeenCalled();
    const normal = setup();
    await normal.service.run({ ...event, lockToken: undefined });
    expect(normal.repository.autoConvertPaidCrmRequest).not.toHaveBeenCalled();
  });
  it('passes the verified executor and lease to the transaction', async () => {
    const { service, repository } = setup();
    await service.run(event);
    expect(repository.autoConvertPaidCrmRequest).toHaveBeenCalledWith(expect.objectContaining({ ...event, actorUserId: 86 }));
  });
});
