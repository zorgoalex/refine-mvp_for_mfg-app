import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const contract = load(readFileSync(new URL('../../contracts/04-api-contract.openapi.yaml', import.meta.url), 'utf8')) as Record<string, any>;
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const operations = Object.entries(contract.paths).flatMap(([path, item]) =>
  Object.entries(item as Record<string, any>).filter(([method]) => methods.has(method))
    .map(([method, operation]) => ({ path, method, operation, item: item as Record<string, any> })));

function reference(value: Record<string, any>): Record<string, any> {
  if (!value.$ref) return value;
  expect(value.$ref).toMatch(/^#\//);
  return value.$ref.slice(2).split('/').reduce((node: any, key: string) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], contract);
}

describe('OpenAPI document structure', () => {
  it('has unique operation IDs and resolves every local reference and security scheme', () => {
    expect(contract.openapi).toBe('3.0.3');
    expect(operations.length).toBeGreaterThan(0);
    const ids = operations.map(({ operation }) => operation.operationId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    function visit(value: any): void {
      if (!value || typeof value !== 'object') return;
      if (value.$ref) expect(reference(value), value.$ref).toBeDefined();
      for (const child of Object.values(value)) visit(child);
    }
    visit(contract);
    for (const { operation } of operations) {
      for (const requirement of operation.security ?? []) {
        for (const scheme of Object.keys(requirement)) expect(contract.components.securitySchemes[scheme], scheme).toBeDefined();
      }
    }
  });

  it('declares required path parameters for CAD, WhatsApp and Bitrix24 contracts', () => {
    const affected = operations.filter(({ path }) => /^\/api\/v1\/(cad|whatsapp|bitrix24|integrations\/bitrix24)\//.test(path));
    expect(affected.length).toBeGreaterThan(0);
    for (const { path, method, operation, item } of affected) {
      const parameters = [...item.parameters ?? [], ...operation.parameters ?? []].map(reference);
      for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
        expect(parameters, `${method} ${path}: ${name}`).toContainEqual(expect.objectContaining({ name, in: 'path', required: true }));
      }
    }
  });

  it('distinguishes widget sessions, verified callbacks and WAHA HMAC from ERP bearer auth', () => {
    const widget = contract.paths['/api/v1/integrations/bitrix24/widget-api/payments'].post;
    expect(widget.security).toEqual([{ bitrixWidgetSession: [] }]);
    expect(widget.responses).toHaveProperty('200');
    expect(widget.responses).toHaveProperty('201');
    expect(widget.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } }));
    expect(contract.components.securitySchemes.bitrixWidgetSession).toMatchObject({ type: 'apiKey', in: 'header', name: 'Authorization' });
    expect(contract.components.securitySchemes.bitrixWidgetSession.description).toContain('BitrixWidget ');
    expect(contract.paths['/api/v1/integrations/bitrix24/widget/deal-payment'].post.security).toEqual([]);
    expect(contract.paths['/api/v1/integrations/bitrix24/widget/deal-payment'].post.responses['200'].content).toHaveProperty('text/html');

    const webhook = contract.paths['/api/v1/whatsapp/webhook'].post;
    expect(webhook.security).toEqual([{ whatsAppWebhookHmac: [] }]);
    expect(webhook.responses).toHaveProperty('202');
    expect(webhook.parameters.map((entry: any) => entry.name)).toEqual(['x-webhook-hmac-algorithm', 'x-webhook-timestamp']);
    expect(contract.components.securitySchemes.whatsAppWebhookHmac).toMatchObject({ type: 'apiKey', in: 'header', name: 'x-webhook-hmac' });
    expect(contract.paths['/api/v1/whatsapp/status'].get.security).toEqual([{ bearerAuth: [] }]);
  });

  it('preserves live-state caching and technical-log access after consolidating duplicate paths', () => {
    const live = contract.paths['/api/v1/orders/{orderId}/detail-live-state'].get;
    expect(live.parameters).toContainEqual(expect.objectContaining({ name: 'If-None-Match', in: 'header' }));
    expect(live.responses['200'].headers).toHaveProperty('ETag');
    expect(live.responses['200'].headers).toHaveProperty('X-ERP-Stream-Cursor');
    expect(live.responses).toHaveProperty('304');
    for (const suffix of ['', '/export']) {
      expect(contract.paths[`/api/v1/cnc-telegram/worker-logs/technical${suffix}`].get['x-permission']).toBe('audit.technical.view');
    }
    expect(contract.paths['/api/v1/cnc-telegram/worker-logs/technical/batch'].post.responses).toHaveProperty('409');
  });
});
