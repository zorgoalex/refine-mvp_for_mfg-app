import { describe, expect, it, vi } from 'vitest';
import { Bitrix24ManualPaymentCommandService } from './bitrix24-manual-payment-command.service';
import { requestHash } from './bitrix24-payment-widget.dto';
import type { ManualPaymentCommand, WidgetDealContext } from './bitrix24-payment-widget.repository';

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
  it('resumes an ERP-only retry without creating another Bitrix payment', async () => {
    const { service, repository, bitrix, tokens } = setup();
    const pending = { ...command('awaiting_erp_retry'), bitrixPaymentId: '8322' };
    const completed = { ...pending, status: 'completed' as const, erpPaymentId: 9001 };
    const materializeCommand = vi.fn().mockResolvedValue(completed);
    Object.assign(repository, { materializeCommand });

    await expect((service as unknown as {
      resume(value: ManualPaymentCommand): Promise<ManualPaymentCommand>;
    }).resume(pending)).resolves.toBe(completed);
    expect(materializeCommand).toHaveBeenCalledWith(pending.commandId);
    expect(bitrix.createDealPayment).not.toHaveBeenCalled();
    expect(tokens.refreshCallerToken).not.toHaveBeenCalled();
    expect(repository.releaseCommand).toHaveBeenCalledOnce();
  });

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
        hasActivePositions: false,
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
    const productSync = {
      syncDeal: vi.fn().mockResolvedValue({
        status: 'ready',
        requestId: 41,
        orderId: 10798,
        reason: null,
        blockedIds: [],
      }),
    };
    const service = new Bitrix24ManualPaymentCommandService(
      repository as never,
      auth as never,
      bitrix as never,
      {} as never,
      config as never,
      catalog as never,
      undefined,
      productSync as never,
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

const WIDGET_SESSION = {
  memberId: 'member-12345678',
  domain: 'mebelkz.bitrix24.kz',
  dealId: '8204',
  bitrixUserId: '17',
  erpUserId: 7,
  accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
};
const WIDGET_AUTH = {
  session: WIDGET_SESSION,
  actor: { id: '7', permissions: ['bitrix24.payments.create'] },
  actorDisplayName: 'Оператор',
  accessToken: 'actor-token',
  refreshToken: 'refresh-token',
  installation: { executorBitrixUserId: '1' },
};
const WIDGET_BODY = {
  amount: '5000.00',
  paymentDate: '2026-09-25',
  paySystemId: 14,
  comment: null,
  expectedOrderVersion: 12,
  confirmOverpayment: false,
};

function widgetContext(overrides: Partial<WidgetDealContext> = {}): WidgetDealContext {
  return {
    dealId: '8204',
    requestId: 41,
    requestState: 'active',
    requestSyncStatus: 'ok',
    orderId: 10798,
    orderKind: 'crm_request',
    orderVersion: 12,
    finalAmount: '10000.00',
    paidAmount: '0.00',
    snapshotPaidAmount: '0.00',
    commandReservedAmount: '0.00',
    paymentOutOfSync: false,
    managerId: 7,
    createdBy: 7,
    hasActivePositions: true,
    ...overrides,
  };
}

function createHarness(contextOverrides: Partial<WidgetDealContext> = {}) {
  const repository = {
    getDealContext: vi.fn().mockResolvedValue(widgetContext(contextOverrides)),
    findCommandByIdempotencyKey: vi.fn().mockResolvedValue(null),
    listWidgetPaymentSystems: vi.fn().mockResolvedValue([{
      paySystemId: 14, name: 'Наличные Bitrix', typePaidId: 1, isDefault: true,
    }]),
    createCommand: vi.fn().mockResolvedValue({
      command: command('completed'), created: true,
    }),
    claimCommand: vi.fn().mockResolvedValue('lease-token'),
    releaseCommand: vi.fn().mockResolvedValue(undefined),
    getCommand: vi.fn(),
    getPaymentSyncFence: vi.fn().mockResolvedValue(0),
  };
  const auth = { requireCreateAccess: vi.fn().mockResolvedValue(undefined) };
  const bitrix = {
    getDeal: vi.fn().mockResolvedValue({ title: 'Заявка', currencyId: 'KZT' }),
  };
  const config = {
    getBitrix24: vi.fn().mockReturnValue({ currencyId: 'KZT', paySystemId: 12 }),
    getReverseSync: vi.fn().mockReturnValue({ portalTimezone: 'Asia/Almaty' }),
    getPaymentWidget: vi.fn().mockReturnValue({
      enabled: true,
      commandTokenEncryptionKey: Buffer.alloc(32, 3).toString('base64'),
      commandLeaseMs: 60_000,
    }),
  };
  const catalog = { refreshIfStale: vi.fn().mockResolvedValue(undefined) };
  const processor = {
    reconcileIncomingRequestNow: vi.fn().mockResolvedValue({
      productStatus: 'ready',
      productReason: null,
      productBlockedIds: [],
      paymentsApplied: true,
    }),
    reconcileMappedOrderPaymentsNow: vi.fn().mockResolvedValue({ applied: true }),
  };
  const productSync = { syncDeal: vi.fn() };
  const service = new Bitrix24ManualPaymentCommandService(
    repository as never,
    auth as never,
    bitrix as never,
    {} as never,
    config as never,
    catalog as never,
    undefined,
    productSync as never,
    processor as never,
  );
  return { service, repository, auth, bitrix, processor, productSync };
}

describe('Bitrix24ManualPaymentCommandService.create', () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    authenticated: WIDGET_AUTH,
    idempotencyKey: 'f3911845-0e21-48ac-9709-c499a8291b03',
    body: { ...WIDGET_BODY, ...overrides },
    requestId: 'req-create',
  });

  it('requires current ERP access before even an idempotent replay resumes', async () => {
    const { service, repository, auth } = createHarness();
    repository.findCommandByIdempotencyKey.mockResolvedValue(command('completed'));
    auth.requireCreateAccess.mockRejectedValue(
      Object.assign(new Error('denied'), { statusCode: 403, code: 'FORBIDDEN' }),
    );

    await expect(service.create(input() as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.findCommandByIdempotencyKey).not.toHaveBeenCalled();
    expect(repository.createCommand).not.toHaveBeenCalled();
  });

  it('replays an accepted command with no currency/product/payment preflight', async () => {
    const { service, repository, bitrix, processor, productSync } = createHarness();
    bitrix.getDeal.mockResolvedValue({ title: 'Заявка', currencyId: 'USD' });
    const stored = { ...command('completed'), requestHash: requestHash(WIDGET_BODY as never) };
    repository.findCommandByIdempotencyKey.mockResolvedValue(stored);

    const result = await service.create(input() as never);
    expect(result.created).toBe(false);
    expect(result.response.status).toBe('completed');
    expect(processor.reconcileIncomingRequestNow).not.toHaveBeenCalled();
    expect(productSync.syncDeal).not.toHaveBeenCalled();
    expect(repository.createCommand).not.toHaveBeenCalled();
  });

  it('never resumes a command bound to another Deal under the same key', async () => {
    const { service, repository } = createHarness();
    repository.findCommandByIdempotencyKey.mockResolvedValue({
      ...command('completed'),
      bitrixDealId: '9999',
      requestHash: requestHash(WIDGET_BODY as never),
    });

    await expect(service.create(input() as never)).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(repository.createCommand).not.toHaveBeenCalled();
  });

  it('rejects a new payment on an archived CRM request before any remote work', async () => {
    const { service, repository, processor } = createHarness({ requestState: 'archived' });

    await expect(service.create(input() as never)).rejects.toMatchObject({
      statusCode: 409,
      code: 'BITRIX24_REQUEST_NOT_ACTIVE',
    });
    expect(processor.reconcileIncomingRequestNow).not.toHaveBeenCalled();
    expect(repository.createCommand).not.toHaveBeenCalled();
  });

  it('blocks when a required product refresh was skipped on a still-active request', async () => {
    const { service, repository, processor } = createHarness();
    processor.reconcileIncomingRequestNow.mockResolvedValue({
      productStatus: 'skipped',
      productReason: null,
      productBlockedIds: [],
      paymentsApplied: true,
    });

    await expect(service.create(input() as never)).rejects.toMatchObject({
      statusCode: 409,
      code: 'BITRIX24_PRODUCT_SYNC_FAILED',
    });
    expect(repository.createCommand).not.toHaveBeenCalled();
  });

  it('rejects a torn payment reconcile (stale generation) as retryable', async () => {
    const { service, repository, processor } = createHarness();
    processor.reconcileIncomingRequestNow.mockResolvedValue({
      productStatus: 'ready',
      productReason: null,
      productBlockedIds: [],
      paymentsApplied: false,
    });

    await expect(service.create(input() as never)).rejects.toMatchObject({
      statusCode: 409,
      code: 'BITRIX24_PAYMENT_SYNC_STALE',
    });
    expect(repository.createCommand).not.toHaveBeenCalled();
  });

  it('computes the remaining amount in integer cents (0.30 - 0.20 accepts 0.10)', async () => {
    const { service, repository } = createHarness({
      finalAmount: '0.30',
      paidAmount: '0.20',
    });

    const result = await service.create(input({ amount: '0.10' }) as never);
    expect(result.created).toBe(true);
    expect(repository.createCommand).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '0.10' }),
    );
  });

  it('still flags a genuine one-cent overpayment', async () => {
    const { service } = createHarness({ finalAmount: '0.30', paidAmount: '0.20' });

    await expect(service.create(input({ amount: '0.11' }) as never)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAYMENT_OVERPAYMENT_CONFIRMATION_REQUIRED',
    });
  });

  it('a fresh native Bitrix paid snapshot shrinks the remaining amount', async () => {
    const { service } = createHarness({
      finalAmount: '10000.00',
      paidAmount: '0.00',
      snapshotPaidAmount: '5000.00',
    });

    await service.create(input({ amount: '5000.00' }) as never);
    await expect(
      service.create(input({ amount: '5000.01' }) as never),
    ).rejects.toMatchObject({ code: 'PAYMENT_OVERPAYMENT_CONFIRMATION_REQUIRED' });
  });

  it('loser of a same-key race resumes the winner command instead of a spurious error', async () => {
    // The first lookup saw no command; a concurrent winner then stored and
    // completed it. The loser's stale CAS fails; the fallback re-check finds
    // the matching hash+Deal command and returns it as a replay.
    const { service, repository, auth, processor } = createHarness();
    const stored = { ...command('completed'), requestHash: requestHash(WIDGET_BODY as never) };
    repository.findCommandByIdempotencyKey
      .mockResolvedValueOnce(null)   // initial lookup — winner not committed yet
      .mockResolvedValue(stored);    // fallback re-check — winner now visible
    processor.reconcileIncomingRequestNow.mockResolvedValue({
      productStatus: 'ready',
      productReason: null,
      productBlockedIds: [],
      paymentsApplied: false,        // CAS-false: a newer apply committed
    });

    const result = await service.create(input() as never);
    expect(result.created).toBe(false);
    expect(result.response.status).toBe('completed');
    // Authorization was re-verified against the fresh context before resume.
    expect(auth.requireCreateAccess).toHaveBeenCalledTimes(2);
    expect(repository.createCommand).not.toHaveBeenCalled();
  });

  it('refreshes remote payments before a NEW command on a production order', async () => {
    const { service, repository, processor } = createHarness({
      orderKind: 'production_order',
      requestId: null,
      requestState: null,
      requestSyncStatus: null,
    });
    processor.reconcileMappedOrderPaymentsNow.mockResolvedValue({ applied: true });

    await service.create(input() as never);
    expect(processor.reconcileMappedOrderPaymentsNow).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: '8204', orderId: 10798 }),
    );
    expect(repository.createCommand).toHaveBeenCalledTimes(1);
  });

  it('a native Bitrix payment recorded before the second widget command blocks it', async () => {
    // After the first partial payment converted the request, a native Bitrix
    // payment exists only remotely; the production reconcile must shrink the
    // remaining amount or the second widget payment is an overpayment.
    const { service, repository, processor } = createHarness({
      orderKind: 'production_order',
      requestId: null,
      requestState: null,
      requestSyncStatus: null,
    });
    processor.reconcileMappedOrderPaymentsNow.mockResolvedValue({ applied: true });
    repository.getDealContext
      .mockResolvedValueOnce(widgetContext({
        orderKind: 'production_order', requestId: null,
        requestState: null, requestSyncStatus: null,
      }))
      .mockResolvedValue(widgetContext({
        orderKind: 'production_order', requestId: null,
        requestState: null, requestSyncStatus: null,
        snapshotPaidAmount: '5000.00',
      }));

    await expect(
      service.create(input({ amount: '5000.01' }) as never),
    ).rejects.toMatchObject({ code: 'PAYMENT_OVERPAYMENT_CONFIRMATION_REQUIRED' });
    expect(repository.createCommand).not.toHaveBeenCalled();
  });

  it('rejects a stale production payment refresh instead of paying on old totals', async () => {
    const { service, repository, processor } = createHarness({
      orderKind: 'production_order',
      requestId: null,
      requestState: null,
      requestSyncStatus: null,
    });
    processor.reconcileMappedOrderPaymentsNow.mockResolvedValue({ applied: false });

    await expect(service.create(input() as never)).rejects.toMatchObject({
      statusCode: 409, code: 'BITRIX24_PAYMENT_SYNC_STALE',
    });
    expect(repository.createCommand).not.toHaveBeenCalled();
  });

  it('rejects a mismatched same-key command even when reached via the race fallback', async () => {
    const { service, repository, processor } = createHarness();
    repository.findCommandByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        ...command('completed'),
        bitrixDealId: '9999',
        requestHash: requestHash(WIDGET_BODY as never),
      });
    processor.reconcileIncomingRequestNow.mockResolvedValue({
      productStatus: 'ready', productReason: null,
      productBlockedIds: [], paymentsApplied: false,
    });

    await expect(service.create(input() as never)).rejects.toMatchObject({
      statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(repository.createCommand).not.toHaveBeenCalled();
  });
});
