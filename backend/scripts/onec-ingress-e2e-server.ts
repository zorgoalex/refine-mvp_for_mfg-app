/**
 * Test-only server for ops/onec-agent-ingress-e2e.sh: the REAL onec-agent HTTP
 * stack (controller, OnecAgentAuthGuard, protocol service, PgOnecRepository,
 * audit writer, memory rate limit, main.ts wiring helpers) against an isolated
 * PostgreSQL schema. Never used by the application.
 *
 * Env: ONEC_E2E_DATABASE_URL, ONEC_E2E_ENABLED (true|false), ONEC_E2E_BIND,
 *      ONEC_E2E_MAIN_PORT, ONEC_E2E_AGENT_PORT, ONEC_E2E_SECRET.
 */
import 'reflect-metadata';
import { Controller, Get, Module, RequestMethod } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { json } from 'express';
import { ApiErrorFilter } from '../src/common/errors/api-error.filter';
import type { BackendEnv } from '../src/config/env.validation';
import { DatabaseService } from '../src/database/database.service';
import { PgOnecRepository } from '../src/modules/onec-agent/adapters/pg-onec-repository';
import { OnecAgentProtocolService } from '../src/modules/onec-agent/application/onec-agent-protocol.service';
import { OnecAuditWriter } from '../src/modules/onec-agent/application/onec-audit';
import { OnecAgentAuthGuard } from '../src/modules/onec-agent/http/onec-agent-auth.guard';
import { OnecAgentController } from '../src/modules/onec-agent/http/onec-agent.controller';
import { listenOnecAgent, mountOnecAgentHttp, ONEC_AGENT_PREFIX_EXCLUDE } from '../src/modules/onec-agent/onec-agent-http';
import { OnecRuntimeConfigService } from '../src/modules/onec-agent/onec-runtime-config.service';
import type { PerformanceQueryTelemetryService } from '../src/performance/performance-query-telemetry.service';
import { MemoryRateLimitStore } from '../src/rate-limit/memory-rate-limit.store';
import { RateLimitService } from '../src/rate-limit/rate-limit.service';

const env = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

const enabled = env('ONEC_E2E_ENABLED') === 'true';
const bind = env('ONEC_E2E_BIND');
const mainPort = Number(env('ONEC_E2E_MAIN_PORT'));
const agentPort = Number(env('ONEC_E2E_AGENT_PORT'));

class PingController {
  ping() {
    return { ok: true };
  }
}
Get()(PingController.prototype, 'ping', Object.getOwnPropertyDescriptor(PingController.prototype, 'ping')!);
Controller('ping')(PingController);

async function main(): Promise<void> {
  const values: Partial<BackendEnv> = {
    DATABASE_URL: env('ONEC_E2E_DATABASE_URL'),
    DATABASE_QUERY_TIMEOUT_MS: 10000,
    DATABASE_POOL_MIN: 0,
    DATABASE_POOL_MAX: 4,
    DATABASE_SSL: false,
  };
  const database = new DatabaseService(
    { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
    { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService,
  );
  const repository = new PgOnecRepository(database);
  const runtime = {
    get: () => ({
      enabled,
      agentPort,
      ingressSecrets: [env('ONEC_E2E_SECRET')],
      clientCertHeader: 'x-forwarded-tls-client-cert',
      sessionTtlMs: 600000,
      heartbeatIntervalMs: 60000,
      monitorOwner: 'none' as const,
      monitorIntervalMs: 60000,
    }),
    requireEnabled: () => undefined,
  };
  class E2eModule {}
  Module({
    controllers: [OnecAgentController, PingController],
    providers: [
      { provide: DatabaseService, useValue: database },
      { provide: PgOnecRepository, useValue: repository },
      { provide: OnecRuntimeConfigService, useValue: runtime },
      { provide: RateLimitService, useValue: new RateLimitService(new MemoryRateLimitStore()) },
      { provide: OnecAuditWriter, useValue: new OnecAuditWriter(repository) },
      {
        provide: OnecAgentProtocolService,
        useFactory: (audit: OnecAuditWriter) => new OnecAgentProtocolService(repository, audit),
        inject: [OnecAuditWriter],
      },
      Reflector,
      OnecAgentAuthGuard,
    ],
  })(E2eModule);

  const app = await NestFactory.create(E2eModule, { bodyParser: false, logger: ['error', 'warn'] });
  mountOnecAgentHttp(app, { enabled, agentPort });
  app.use(json({ limit: '50mb' }));
  app.useGlobalFilters(new ApiErrorFilter());
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'health/live', method: RequestMethod.GET }, ONEC_AGENT_PREFIX_EXCLUDE] });
  await app.listen(mainPort, bind);
  if (enabled) listenOnecAgent(app, agentPort, bind);
  process.stdout.write(`READY enabled=${enabled}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
