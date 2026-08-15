import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../config/env.validation';
import { RequestContextService } from '../common/request-context/request-context.service';
import {
  fingerprintSql,
  PerformanceQueryTelemetryService,
} from './performance-query-telemetry.service';

describe('PerformanceQueryTelemetryService', () => {
  it('normalizes literals into one non-reversible fingerprint', () => {
    expect(fingerprintSql("SELECT * FROM orders WHERE order_id = 42 AND name = 'A'")).toBe(
      fingerprintSql("select * from orders where order_id = 77 and name = 'B'"),
    );
    expect(fingerprintSql('SELECT * FROM orders WHERE order_id = 42')).toMatch(/^sql_[0-9a-f]{16}$/);
  });

  it('reports actual retained-sample percentiles with normalized route labels', async () => {
    const contexts = new RequestContextService();
    const config = { get: () => true } as unknown as ConfigService<BackendEnv, true>;
    const telemetry = new PerformanceQueryTelemetryService(config, contexts);

    await contexts.run(
      { requestId: 'req-test', method: 'GET', route: '/api/v1/orders/*' },
      () => telemetry.measure('SELECT 1', async () => ({ rows: [{ ok: 1 }], rowCount: 1 } as never)),
    );

    expect(telemetry.snapshot()).toMatchObject({
      source: 'app-query-histogram',
      series: [
        {
          method: 'GET',
          route: '/api/v1/orders/*',
          calls: 1,
          errors: 0,
          rows: 1,
          retainedSamples: 1,
        },
      ],
    });
  });
});
