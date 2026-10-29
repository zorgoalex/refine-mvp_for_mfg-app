import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore plain ESM helper of the browser scripts, no types
import { printableError } from '../../../tests/helpers/redactSecrets.mjs';
// @ts-ignore plain ESM helper of the browser scripts, no types
import { vercelBypassCookies } from '../../../tests/helpers/vercelBypass.mjs';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});
async function listen(handler: (request: IncomingMessage) => { status: number; headers: Record<string, string> }) {
  const seen: Array<{ url: string; bypass: string | undefined }> = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url ?? '', bypass: request.headers['x-vercel-protection-bypass'] as string | undefined });
    const answer = handler(request);
    response.writeHead(answer.status, answer.headers);
    response.end('ok');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe('printable errors of the deployment smoke script', () => {
  it('prints one line without the credential, even when the error carries request headers in its call log', () => {
    const secret = 'dummy-bypass-secret-0123456789';
    const error = new Error(`apiRequestContext.get: Timeout 30000ms exceeded.\nCall log:\n  - → GET https://example.test/assets/a.js\n  -   x-vercel-protection-bypass: ${secret}`);
    const printed = printableError(error, [secret]);
    expect(printed).toBe('Error: apiRequestContext.get: Timeout 30000ms exceeded.');
    expect(printableError(new Error(`failed with ${secret} in the first line`), [secret])).toBe('Error: failed with [redacted] in the first line');
    expect(printableError(new Error(`x ${secret} y ${secret}`), [secret, undefined, ''])).not.toContain(secret);
    expect(printableError('plain', [secret])).toBe('Error: plain');
    expect(printableError(new Error('a'.repeat(1000)), []).length).toBeLessThanOrEqual(300);
  });
});

describe('bypass cookie exchange of the deployment smoke script', () => {
  const secret = 'dummy-bypass-secret-0123456789';

  it('sends the secret in one request to the deployment and follows no redirect, also through a same-origin hop', async () => {
    const other = await listen(() => ({ status: 200, headers: {} }));
    const deployment = await listen((request) => (request.url === '/'
      // The deployment answers with its cookie and a redirect to a same-origin hop that leads elsewhere.
      ? { status: 307, headers: { location: '/hop', 'set-cookie': 'bypass=granted; Path=/' } }
      : { status: 302, headers: { location: `${other.origin}/landing` } }));

    const cookies = await vercelBypassCookies(`${deployment.origin}/some/path`, secret);

    expect(deployment.seen).toEqual([{ url: '/', bypass: secret }]);
    expect(other.seen).toEqual([]);
    expect(cookies.map((cookie: { name: string; value: string; domain: string }) => [cookie.name, cookie.value, cookie.domain])).toEqual([['bypass', 'granted', '127.0.0.1']]);
  });

  it('a direct cross-origin redirect is not followed either, and without a secret nothing is requested', async () => {
    const other = await listen(() => ({ status: 200, headers: {} }));
    const deployment = await listen(() => ({ status: 302, headers: { location: `${other.origin}/steal` } }));
    expect(await vercelBypassCookies(deployment.origin, secret)).toEqual([]);
    expect(deployment.seen).toHaveLength(1);
    expect(other.seen).toEqual([]);
    expect(await vercelBypassCookies(deployment.origin, '')).toEqual([]);
    expect(deployment.seen).toHaveLength(1);
  });
});
