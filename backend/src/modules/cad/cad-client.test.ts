import { describe, it, expect, vi } from 'vitest';
import { CadClient } from './cad-client';

describe('CAD private client', () => {
  it('chunks large policy evaluation in order and rejects incomplete batches', async () => {
    const sizes: number[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); sizes.push(body.recipes.length);
      return new Response(JSON.stringify({ items: body.recipes.map((recipe: unknown) => ({ recipe, manager_allowed: true, errors: [] })) }));
    });
    const recipes = Array.from({ length: 1001 }, (_, n) => ({ code: 'neo', version: String(n), parameters: {} }));
    const client = new CadClient('http://cad-service:8000', 'x'.repeat(40), transport);
    expect((await client.evaluate(recipes)).map(i => i.recipe.version)).toEqual(recipes.map(r => r.version));
    expect(sizes).toEqual([500, 500, 1]);
    transport.mockResolvedValue(new Response(JSON.stringify({ items: [] })));
    await expect(client.evaluate(recipes)).rejects.toMatchObject({ code: 'CAD_EVALUATION_INCOMPLETE' });
  });
  it('requires both production formats before accepting order work', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ durable_jobs: true, scoped_auth: true, formats: ['svg'] })));
    await expect(new CadClient('http://cad-service:8000', 'x'.repeat(40), transport).capabilities()).rejects.toMatchObject({ code: 'CAD_FORMATS_UNAVAILABLE' });
  });
  it('fails closed without a scoped credential', async () => {
    const transport = vi.fn();
    await expect(new CadClient('http://cad-service:8000', '', transport).capabilities()).rejects.toMatchObject({ code: 'CAD_NOT_CONFIGURED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects arbitrary URLs and admin/legacy paths', async () => {
    const transport = vi.fn(); const client = new CadClient('http://cad-service:8000', 'x'.repeat(40), transport);
    for (const path of ['https://evil.test/', '/v1/templates', '/api/v2/admin/approve', '/api/v2/artifacts/../../files/x']) {
      await expect(client.request(path)).rejects.toMatchObject({ code: 'CAD_PATH_DENIED' });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses server authentication, forbids redirects and propagates production gate', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'PRODUCTION_APPROVAL_REQUIRED' }), { status: 409 }));
    const client = new CadClient('http://cad-service:8000', 'x'.repeat(40), transport);
    await expect(client.package('abc')).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCTION_APPROVAL_REQUIRED' });
    expect(transport.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${'x'.repeat(40)}` } });
  });
});
