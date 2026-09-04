import { describe, expect, it, vi } from 'vitest';
import { Bitrix24ManualPaymentCommandService } from './bitrix24-manual-payment-command.service';
import type { ManualPaymentCommand } from './bitrix24-payment-widget.repository';

const command = (status: ManualPaymentCommand['status']): ManualPaymentCommand => ({
  commandId: '6ce6630e-75a7-4a4e-83eb-3d194bc0fcf5',
  idempotencyKey: 'f3911845-0e21-48ac-9709-c499a8291b03',
  requestHash: 'a'.repeat(64),
  memberId: 'member-12345678',
  domain: 'mebelkz.bitrix24.kz',
  bitrixDealId: '8204',
  bitrixActorUserId: '17',
  erpActorUserId: 7,
  bitrixExecutorUserId: '1',
  originatingRequestId: 'req-test',
  requestId: null,
  erpOrderId: 10798,
  expectedOrderVersion: 12,
  bitrixPaymentId: status === 'remote_created' ? '1038' : null,
  erpPaymentId: null,
  amount: '50000.00',
  currencyId: 'KZT',
  paymentDate: '2026-09-03',
  paySystemId: 14,
  typePaidId: 1,
  comment: null,
  overpaymentConfirmed: false,
  beforePaymentIds: [],
  diagnosticCandidateIds: [],
  status,
  version: 3,
  callerAccessTokenCiphertext: null,
  callerRefreshTokenCiphertext: null,
  callerAccessTokenExpiresAt: null,
  response: null,
  errorCode: null,
});

function setup() {
  const repository = {
    claimCommand: vi.fn().mockResolvedValue('4c14f129-2232-4746-9a9e-6ccf716f638e'),
    releaseCommand: vi.fn().mockResolvedValue(undefined),
    getCommand: vi.fn(),
    listRecoverableCommands: vi.fn(),
    markCrashedCreateAmbiguous: vi.fn().mockResolvedValue(undefined),
    markPostCreateFailure: vi.fn().mockResolvedValue(undefined),
    refreshCommandCallerTokens: vi.fn().mockResolvedValue(undefined),
  };
  const bitrix = {
    createDealPayment: vi.fn(),
    currentUser: vi.fn(),
  };
  const tokens = { refreshCallerToken: vi.fn() };
  const config = {
    getPaymentWidget: vi.fn().mockReturnValue({
      enabled: true,
      commandTokenEncryptionKey: Buffer.alloc(32, 3).toString('base64'),
      commandLeaseMs: 60_000,
    }),
  };
  const service = new Bitrix24ManualPaymentCommandService(
    repository as never,
    {} as never,
    bitrix as never,
    tokens as never,
    config as never,
    {} as never,
  );
  return { service, repository, bitrix, tokens };
}

describe('Bitrix24ManualPaymentCommandService safety', () => {
  it('never repeats remote create after takeover of remote_create_started', async () => {
    const { service, repository, bitrix } = setup();
    repository.listRecoverableCommands.mockResolvedValue([
      command('remote_create_started'),
    ]);

    await expect(service.recover()).resolves.toEqual({
      recovered: 0,
      ambiguous: 1,
      failed: 0,
    });
    expect(repository.markCrashedCreateAmbiguous).toHaveBeenCalledOnce();
    expect(bitrix.createDealPayment).not.toHaveBeenCalled();
    expect(repository.releaseCommand).toHaveBeenCalledOnce();
  });

  it('does no external work when another worker owns the command lease', async () => {
    const { service, repository, bitrix } = setup();
    const initial = command('processing');
    repository.claimCommand.mockResolvedValue(null);
    repository.getCommand.mockResolvedValue(initial);

    await expect((service as unknown as {
      resume(value: ManualPaymentCommand): Promise<ManualPaymentCommand>;
    }).resume(initial)).resolves.toBe(initial);
    expect(bitrix.createDealPayment).not.toHaveBeenCalled();
    expect(repository.releaseCommand).not.toHaveBeenCalled();
  });

  it('keeps a linked CRM request distinct from a production order', async () => {
    const repository = {
      getDealContext: vi.fn().mockResolvedValue({
        dealId: '8204',
        requestId: 41,
        requestState: 'active',
        orderId: 10798,
        orderKind: 'crm_request',
        orderVersion: 12,
        finalAmount: '250000.00',
        paidAmount: '50000.00',
        managerId: 7,
        createdBy: 7,
        hasActiveDetails: false,
      }),
      listWidgetPaymentSystems: vi.fn().mockResolvedValue([{
        paySystemId: 14,
        name: 'Наличные Bitrix',
        typePaidId: 1,
        isDefault: true,
      }]),
      getRecentDealPayments: vi.fn().mockResolvedValue([]),
    };
    const auth = { requireCreateAccess: vi.fn().mockResolvedValue(undefined) };
    const bitrix = { getDeal: vi.fn().mockResolvedValue({ title: 'Заявка', currencyId: 'KZT' }) };
    const config = {
      getBitrix24: vi.fn().mockReturnValue({ currencyId: 'KZT', paySystemId: 12 }),
      getReverseSync: vi.fn().mockReturnValue({ portalTimezone: 'Asia/Almaty' }),
    };
    const catalog = { refreshIfStale: vi.fn().mockResolvedValue(undefined) };
    const service = new Bitrix24ManualPaymentCommandService(
      repository as never,
      auth as never,
      bitrix as never,
      {} as never,
      config as never,
      catalog as never,
    );

    const result = await service.getContext({
      session: {
        domain: 'mebelkz.bitrix24.kz',
        dealId: '8204',
        bitrixUserId: '17',
      },
      actorDisplayName: 'Оператор',
      accessToken: 'actor-token',
    } as never);

    expect(result.erp.linkState).toBe('crm_request');
    expect(result.erp.orderId).toBe(10798);
    expect(result.canCreate).toBe(true);
  });

  it('materializes confirmed overpayment only while owning the command lease', async () => {
    const pending = command('awaiting_overpayment_confirmation');
    const confirmed = { ...pending, status: 'snapshot_saved' as const, overpaymentConfirmed: true };
    const completed = {
      ...confirmed,
      status: 'completed' as const,
      erpPaymentId: 901,
    };
    const repository = {
      getCommand: vi.fn().mockResolvedValue(pending),
      confirmOverpayment: vi.fn().mockResolvedValue(confirmed),
      claimCommand: vi.fn().mockResolvedValue('lease-token'),
      materializeCommand: vi.fn().mockResolvedValue(completed),
      releaseCommand: vi.fn().mockResolvedValue(undefined),
      markPostCreateFailure: vi.fn().mockResolvedValue(undefined),
    };
    const config = {
      getPaymentWidget: vi.fn().mockReturnValue({
        enabled: true,
        commandTokenEncryptionKey: Buffer.alloc(32, 3).toString('base64'),
        commandLeaseMs: 180_000,
      }),
    };
    const service = new Bitrix24ManualPaymentCommandService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      config as never,
      {} as never,
    );

    const result = await service.confirmOverpayment({
      session: {
        memberId: pending.memberId,
        domain: pending.domain,
        dealId: pending.bitrixDealId,
        bitrixUserId: pending.bitrixActorUserId,
      },
      actor: {
        id: String(pending.erpActorUserId),
        permissions: ['bitrix24.payments.confirm_overpayment'],
      },
      actorDisplayName: 'Оператор',
      accessToken: 'actor-token',
    } as never, pending.commandId);

    expect(result.status).toBe('completed');
    expect(repository.claimCommand).toHaveBeenCalledWith(pending.commandId, 180_000);
    expect(repository.materializeCommand).toHaveBeenCalledWith(pending.commandId);
    expect(repository.releaseCommand).toHaveBeenCalledWith(pending.commandId, 'lease-token');
  });
});
