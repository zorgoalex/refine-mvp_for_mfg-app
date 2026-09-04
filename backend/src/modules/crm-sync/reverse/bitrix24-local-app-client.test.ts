import { describe, expect, it, vi } from 'vitest';
import { Bitrix24LocalAppClient } from './bitrix24-local-app-client';
import { BITRIX24_REVERSE_EVENTS } from './bitrix24-reverse-payload';

function response(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ result }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Bitrix24LocalAppClient', () => {
  it('verifies local app context and binds only missing handlers', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response({
        CODE: 'local.erp',
        STATUS: 'L',
        INSTALLED: true,
      }))
      .mockResolvedValueOnce(response([
        {
          EVENT: BITRIX24_REVERSE_EVENTS[0],
          HANDLER: 'https://erp.example/api/v1/integrations/bitrix24/events',
        },
      ]))
      .mockImplementation(() => Promise.resolve(response(true)));
    const client = new Bitrix24LocalAppClient(fetchFn);

    await client.verifyAndBind({
      domain: 'mebelkz.bitrix24.kz',
      accessToken: 'secret-access',
      handlerUrl: 'https://erp.example/api/v1/integrations/bitrix24/events',
      expectedAppCode: 'local.erp',
    });

    expect(fetchFn).toHaveBeenCalledTimes(BITRIX24_REVERSE_EVENTS.length + 1);
    expect(JSON.stringify(fetchFn.mock.calls)).not.toContain('refresh');
  });

  it('rejects a token outside local application context', async () => {
    const client = new Bitrix24LocalAppClient(
      vi.fn().mockResolvedValue(response({
        CODE: 'local.other',
        STATUS: 'L',
        INSTALLED: true,
      })),
    );
    await expect(client.verifyAndBind({
      domain: 'mebelkz.bitrix24.kz',
      accessToken: 'secret-access',
      handlerUrl: 'https://erp.example/api/v1/integrations/bitrix24/events',
      expectedAppCode: 'local.erp',
    })).rejects.toMatchObject({ code: 'BITRIX24_APP_CONTEXT_INVALID' });
  });

  it('uses the documented dual-principal payment methods with exact IDs', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response([{ id: 100 }, { id: 101 }]))
      .mockResolvedValueOnce(response(102))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response({ payment: { id: 102, paid: 'Y' } }));
    const client = new Bitrix24LocalAppClient(fetchFn);

    await expect(client.listDealPaymentIds({
      domain: 'mebelkz.bitrix24.kz', accessToken: 'actor-token', dealId: '8204',
    })).resolves.toEqual(['100', '101']);
    await expect(client.createDealPayment({
      domain: 'mebelkz.bitrix24.kz', accessToken: 'actor-token', dealId: '8204',
    })).resolves.toBe('102');
    await client.updatePayment({
      domain: 'mebelkz.bitrix24.kz', accessToken: 'admin-token', paymentId: '102',
      fields: { paid: 'Y' },
    });
    await expect(client.getPayment({
      domain: 'mebelkz.bitrix24.kz', accessToken: 'admin-token', paymentId: '102',
    })).resolves.toMatchObject({ id: 102 });

    const calls = fetchFn.mock.calls.map((call) => ({
      url: call[0],
      body: JSON.parse(String(call[1]?.body)),
    }));
    expect(calls[1]).toMatchObject({
      url: 'https://mebelkz.bitrix24.kz/rest/crm.item.payment.add',
      body: { auth: 'actor-token', entityId: 8204, entityTypeId: 2 },
    });
    expect(calls[2]).toMatchObject({
      url: 'https://mebelkz.bitrix24.kz/rest/sale.payment.update',
      body: { auth: 'admin-token', id: 102, fields: { paid: 'Y' } },
    });
  });

  it('verifies pre-install separately from active runtime context', async () => {
    const client = new Bitrix24LocalAppClient(
      vi.fn().mockResolvedValue(response({ CODE: 'local.erp', STATUS: 'L', INSTALLED: false })),
    );
    await expect(client.verifyPreInstall({
      domain: 'mebelkz.bitrix24.kz',
      accessToken: 'secret-access',
      expectedAppCode: 'local.erp',
    })).resolves.toBeUndefined();
  });
});
