import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paymentsApi, validatePaymentId } from './paymentsApi';
import type { PaymentDto } from './types/paymentApi.types';

describe('paymentsApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('creates, updates, and deletes payments through /api/v1/payments', async () => {
    const payment = paymentDto();
    const fetchMock = mockFetch(
      { payment, order: orderSummary() },
      { payment: { ...payment, amount: 200 }, order: orderSummary({ paidAmount: 200 }) },
      { paymentId: 30, order: orderSummary({ paidAmount: 0 }), deleted: true },
    );

    await expect(
      paymentsApi.create({
        orderId: 15,
        typePaidId: 1,
        amount: 100,
        paymentDate: '2026-05-01',
      }),
    ).resolves.toEqual(payment);
    await expect(paymentsApi.update(30, { amount: 200 })).resolves.toMatchObject({
      amount: 200,
    });
    await expect(paymentsApi.delete(30)).resolves.toMatchObject({
      paymentId: 30,
      deleted: true,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/payments');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/payments/30');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/payments/30');
    expect(fetchMock.mock.calls[2][1]?.method).toBe('DELETE');
  });

  it('rejects invalid payment ids before fetch', async () => {
    const fetchMock = mockFetch({ payment: paymentDto(), order: orderSummary() });

    expect(() => validatePaymentId(0)).toThrow('Invalid paymentId');
    await expect(paymentsApi.update(1.5, { amount: 10 })).rejects.toThrow('Invalid paymentId');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function paymentDto(overrides: Partial<PaymentDto> = {}): PaymentDto {
  return {
    paymentId: 30,
    orderId: 15,
    typePaidId: 1,
    amount: 100,
    paymentDate: '2026-05-01',
    notes: null,
    refKey1c: null,
    createdBy: 1,
    editedBy: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: null,
    ...overrides,
  };
}

function orderSummary(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 15,
    paidAmount: 100,
    debtAmount: 900,
    paymentDate: '2026-05-01',
    paymentStatusId: 2,
    version: 4,
    ...overrides,
  };
}

