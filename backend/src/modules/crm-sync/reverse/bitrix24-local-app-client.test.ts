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
});
