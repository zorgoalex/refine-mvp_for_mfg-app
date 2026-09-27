import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo, Server } from 'node:net';
import { join } from 'node:path';
import { json, urlencoded } from 'express';
import { Controller, Get, Module, RequestMethod, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OnecAgentProtocolService } from './application/onec-agent-protocol.service';
import { ApiErrorFilter } from '../../common/errors/api-error.filter';
import { PgOnecRepository } from './adapters/pg-onec-repository';
import { RateLimitService } from '../../rate-limit/rate-limit.service';
import { OnecRuntimeConfigService } from './onec-runtime-config.service';
import { OnecAgentController } from './http/onec-agent.controller';
import { listenOnecAgent, mountOnecAgentHttp, ONEC_AGENT_PREFIX_EXCLUDE } from './onec-agent-http';

// Decorators applied as functions: test files are outside the tsconfig that
// enables experimentalDecorators for the Vitest transform.
class PingController {
  ping() {
    return { ok: true };
  }
}
Get()(PingController.prototype, 'ping', Object.getOwnPropertyDescriptor(PingController.prototype, 'ping')!);
Controller('ping')(PingController);

const SECRET = 'e2e-ingress-secret-0123456789abcdef-0123';
const DER = new X509Certificate(readFileSync(join(__dirname, '__fixtures__', 'test-agent-a.cert.pem'), 'utf8')).raw;
const CERT_HEADER = encodeURIComponent(DER.toString('base64'));
const FINGERPRINT = createHash('sha256').update(DER).digest();
let agentPort = 0;
// The real OnecAgentAuthGuard runs; only its collaborators are stubbed.
const runtimeStub = {
  get: () => ({ enabled: true, agentPort, ingressSecrets: [SECRET], clientCertHeader: 'x-forwarded-tls-client-cert', sessionTtlMs: 600000, heartbeatIntervalMs: 60000, monitorOwner: 'none', monitorIntervalMs: 60000 }),
};
const repositoryStub = {
  db: {},
  findActiveCertificate: async (fingerprint: Buffer) =>
    fingerprint.equals(FINGERPRINT) ? { certId: 1, agentId: 'agent-a', sourceId: 1, agentStatus: 'active' } : null,
  recordIncident: async () => undefined,
  insertAuditLink: async () => undefined,
  transaction: async () => undefined,
};

class RoutingTestModule {}
Module({
  controllers: [OnecAgentController, PingController],
  providers: [
    { provide: OnecRuntimeConfigService, useValue: runtimeStub },
    { provide: RateLimitService, useValue: { assertAllowed: async () => undefined, refund: async () => undefined } },
    { provide: PgOnecRepository, useValue: repositoryStub },
    {
      provide: OnecAgentProtocolService,
      useValue: {
        startSession: async (_agent: unknown, body: unknown) => ({ echoed: body }),
        heartbeat: async () => undefined,
        configuration: async () => ({ notModified: false, body: '{"configVersion":7,"configHash":"h","configuration":{}}' }),
      },
    },
  ],
})(RoutingTestModule);

describe('1C agent HTTP wiring (real Nest + Express, two listeners)', () => {
  let app: INestApplication;
  let agentServer: Server;
  let mainUrl = '';
  let agentUrl = '';

  beforeAll(async () => {
    app = await NestFactory.create(RoutingTestModule, { logger: false, bodyParser: false, abortOnError: false });
    // Reserve the agent port first so the middleware knows it.
    agentServer = listenOnecAgent(app, 0);
    await new Promise<void>((resolve) => agentServer.once('listening', () => resolve()));
    agentPort = (agentServer.address() as AddressInfo).port;
    mountOnecAgentHttp(app, { enabled: true, agentPort });
    // Same order as main.ts: the global 50 MiB parsers come after the agent mount.
    app.use(json({ limit: '50mb' }));
    app.use(urlencoded({ limit: '50mb', extended: true }));
    app.useGlobalFilters(new ApiErrorFilter());
    app.setGlobalPrefix('api/v1', { exclude: [{ path: 'health/live', method: RequestMethod.GET }, ONEC_AGENT_PREFIX_EXCLUDE] });
    await app.listen(0, '127.0.0.1');
    mainUrl = await app.getUrl();
    agentUrl = `http://127.0.0.1:${agentPort}`;
  });

  afterAll(async () => {
    agentServer?.close();
    await app?.close();
  });

  const agentHeaders = { 'x-onec-ingress-auth': SECRET, 'x-forwarded-tls-client-cert': CERT_HEADER, 'x-agent-id': 'agent-a' };
  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = agentHeaders) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('serves the agent API outside the global /api/v1 prefix on the agent listener', async () => {
    const response = await post(agentUrl, '/api/integration/1c-agents/v1/session/start', { agentId: 'a' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ echoed: { agentId: 'a' } });
    expect((await post(agentUrl, '/api/integration/1c-agents/v1/session/start', {}, { ...agentHeaders, 'x-onec-ingress-auth': 'forged' })).status).toBe(403);
    expect((await post(agentUrl, '/api/integration/1c-agents/v1/session/start', {}, { ...agentHeaders, 'x-agent-id': 'agent-b' })).status).toBe(403);
    const config = await fetch(`${agentUrl}/api/integration/1c-agents/v1/configuration?currentVersion=1`, { headers: agentHeaders });
    expect(config.status).toBe(200);
    expect(await config.text()).toBe('{"configVersion":7,"configHash":"h","configuration":{}}');
    expect((await post(agentUrl, '/api/integration/1c-agents/v1/heartbeat', { agentId: 'a' })).status).toBe(204);
  });

  it('serves nothing else on the agent listener', async () => {
    expect((await fetch(`${agentUrl}/api/v1/ping`)).status).toBe(404);
    expect((await fetch(`${agentUrl}/health/live`)).status).toBe(404);
  });

  it('does not expose the agent API on the main listener and keeps /api/v1 routes there', async () => {
    // Even with valid trust headers the agent API does not exist on the main listener.
    expect((await post(mainUrl, '/api/integration/1c-agents/v1/session/start', {})).status).toBe(404);
    expect((await post(mainUrl, '/api/v1/api/integration/1c-agents/v1/session/start', {})).status).toBe(404);
    expect((await fetch(`${mainUrl}/api/v1/ping`)).status).toBe(200);
  });

  it('limits agent request bodies to 2 MiB', async () => {
    const response = await post(agentUrl, '/api/integration/1c-agents/v1/session/start', { blob: 'x'.repeat(3 * 1024 * 1024) });
    expect(response.status).toBe(413);
    const malformed = await fetch(`${agentUrl}/api/integration/1c-agents/v1/session/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...agentHeaders }, body: '{"agentId":',
    });
    expect(malformed.status).toBe(400);
    // A non-JSON body is refused before any parser reads it (no 50 MiB urlencoded bypass).
    const form = await fetch(`${agentUrl}/api/integration/1c-agents/v1/session/start`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...agentHeaders }, body: `a=${'x'.repeat(5 * 1024 * 1024)}`,
    });
    expect(form.status).toBe(415);
  });
});
