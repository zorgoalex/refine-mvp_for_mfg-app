import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createPayment = vi.fn();
const updatePayment = vi.fn();
const deletePayment = vi.fn();

describe('dataProvider backend payments mutation routing', () => {
  beforeEach(() => {
    vi.resetModules();
    createPayment.mockReset();
    updatePayment.mockReset();
    deletePayment.mockReset();
    vi.doMock('../config/featureFlags', () => ({
      featureFlags: {
        useBackendAuth: true,
        useBackendPermissions: true,
        useBackendOrdersRead: false,
        useBackendOrdersWrite: false,
        useBackendPayments: true,
        useBackendClientPhones: false,
        useBackendProductionActions: false,
        useBackendOrderExport: false,
        useBackendUsers: false,
        useBackendVlm: false,
        useBackendReferences: false,
        enableLegacyHasura: true,
      },
    }));
    vi.doMock('../api/paymentsApi', () => ({
      paymentsApi: {
        create: createPayment,
        update: updatePayment,
        delete: deletePayment,
      },
    }));
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', '/v1/graphql');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.doUnmock('../config/featureFlags');
    vi.doUnmock('../api/paymentsApi');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('routes payments create/update/delete to backend and maps legacy field names', async () => {
    const payment = backendPayment();
    createPayment.mockResolvedValue(payment);
    updatePayment.mockResolvedValue({ ...payment, amount: 200 });
    deletePayment.mockResolvedValue({
      paymentId: 30,
      order: {
        orderId: 15,
        paidAmount: 0,
        debtAmount: 1000,
        paymentDate: null,
        paymentStatusId: 1,
        version: 5,
      },
      deleted: true,
    });
    const { dataProvider } = await import('./dataProvider');
    const provider = dataProvider('');

    await expect(
      provider.create({
        resource: 'payments',
        variables: {
          order_id: 15,
          type_paid_id: 1,
          amount: 100,
          payment_date: '2026-05-01',
          notes: 'cash',
        },
      }),
    ).resolves.toMatchObject({
      data: {
        payment_id: 30,
        order_id: 15,
        type_paid_id: 1,
        amount: 100,
        payment_date: '2026-05-01',
      },
    });
    await provider.update({
      resource: 'payments',
      id: 30,
      variables: { amount: 200 },
    });
    await provider.deleteOne({ resource: 'payments', id: 30 });

    expect(createPayment).toHaveBeenCalledWith({
      orderId: 15,
      typePaidId: 1,
      amount: 100,
      paymentDate: '2026-05-01',
      notes: 'cash',
      refKey1c: null,
    });
    expect(updatePayment).toHaveBeenCalledWith(30, { amount: 200 });
    expect(deletePayment).toHaveBeenCalledWith(30);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('keeps legacy order-save payment mutations on Hasura when forceHasuraMutation meta is set', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { insert_payments_one: { payment_id: 31 } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { update_payments_by_pk: { payment_id: 31 } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { delete_payments_by_pk: { payment_id: 31 } } }));
    vi.stubGlobal('fetch', fetchMock);

    const { dataProvider } = await import('./dataProvider');
    const provider = dataProvider('');
    const meta = { forceHasuraMutation: true };

    await provider.create({
      resource: 'payments',
      variables: {
        order_id: 15,
        type_paid_id: 1,
        amount: 100,
        payment_date: '2026-05-01',
      },
      meta,
    });
    await provider.update({
      resource: 'payments',
      id: 31,
      variables: { amount: 120 },
      meta,
    });
    await provider.deleteOne({ resource: 'payments', id: 31, meta });

    expect(createPayment).not.toHaveBeenCalled();
    expect(updatePayment).not.toHaveBeenCalled();
    expect(deletePayment).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('insert_payments_one');
    expect(String(fetchMock.mock.calls[1][1]?.body)).toContain('update_payments_by_pk');
    expect(String(fetchMock.mock.calls[2][1]?.body)).toContain('delete_payments_by_pk');
  });

  it('does not retry Hasura payments mutation when backend payment create fails', async () => {
    createPayment.mockRejectedValue(new Error('Backend payments unavailable'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { dataProvider } = await import('./dataProvider');

    await expect(
      dataProvider('').create({
        resource: 'payments',
        variables: {
          order_id: 15,
          type_paid_id: 1,
          amount: 100,
          payment_date: '2026-05-01',
        },
      }),
    ).rejects.toThrow('Backend payments unavailable');

    expect(createPayment).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function backendPayment() {
  return {
    paymentId: 30,
    orderId: 15,
    typePaidId: 1,
    amount: 100,
    paymentDate: '2026-05-01',
    notes: 'cash',
    refKey1c: null,
    createdBy: 1,
    editedBy: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: null,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
