import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { QueryResult } from 'pg';
import type { BackendEnv } from '../config/env.validation';
import { RequestContextService } from '../common/request-context/request-context.service';

const MAX_SERIES = 100;
const MAX_SAMPLES_PER_SERIES = 256;

interface QuerySeries {
  fingerprint: string;
  method: string;
  route: string;
  durationsMs: number[];
  calls: number;
  errors: number;
  rows: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

export interface QueryHistogramSnapshot {
  capturedAt: string;
  source: 'app-query-histogram';
  series: Array<{
    fingerprint: string;
    method: string;
    route: string;
    calls: number;
    errors: number;
    rows: number;
    minMs: number;
    maxMs: number;
    meanMs: number;
    p50Ms: number;
    p75Ms: number;
    p95Ms: number;
    p99Ms: number;
    retainedSamples: number;
  }>;
}

@Injectable()
export class PerformanceQueryTelemetryService {
  private readonly logger = new Logger(PerformanceQueryTelemetryService.name);
  private readonly enabled: boolean;
  private readonly series = new Map<string, QuerySeries>();

  constructor(
    config: ConfigService<BackendEnv, true>,
    private readonly contexts: RequestContextService,
  ) {
    this.enabled = config.get('BACKEND_PERFORMANCE_QUERY_TELEMETRY', { infer: true });
  }

  async measure<T extends QueryResult>(sql: string, operation: () => Promise<T>): Promise<T> {
    if (!this.enabled) return operation();

    const startedAt = process.hrtime.bigint();
    try {
      const result = await operation();
      this.observe(sql, elapsedMs(startedAt), result.rowCount ?? result.rows.length, false);
      return result;
    } catch (error) {
      this.observe(sql, elapsedMs(startedAt), 0, true);
      throw error;
    }
  }

  snapshot(): QueryHistogramSnapshot {
    return {
      capturedAt: new Date().toISOString(),
      source: 'app-query-histogram',
      series: [...this.series.values()]
        .map((value) => {
          const sorted = [...value.durationsMs].sort((left, right) => left - right);
          return {
            fingerprint: value.fingerprint,
            method: value.method,
            route: value.route,
            calls: value.calls,
            errors: value.errors,
            rows: value.rows,
            minMs: round(value.minMs),
            maxMs: round(value.maxMs),
            meanMs: round(value.totalMs / value.calls),
            p50Ms: percentile(sorted, 0.5),
            p75Ms: percentile(sorted, 0.75),
            p95Ms: percentile(sorted, 0.95),
            p99Ms: percentile(sorted, 0.99),
            retainedSamples: sorted.length,
          };
        })
        .sort((left, right) => right.p95Ms - left.p95Ms),
    };
  }

  private observe(sql: string, durationMs: number, rows: number, failed: boolean): void {
    const context = this.contexts.get();
    const fingerprint = fingerprintSql(sql);
    const method = context?.method ?? 'BACKGROUND';
    const route = context?.route ?? 'background';
    const key = `${method}:${route}:${fingerprint}`;
    let value = this.series.get(key);

    if (!value) {
      if (this.series.size >= MAX_SERIES) {
        const oldest = this.series.keys().next().value as string | undefined;
        if (oldest) this.series.delete(oldest);
      }
      value = {
        fingerprint,
        method,
        route,
        durationsMs: [],
        calls: 0,
        errors: 0,
        rows: 0,
        totalMs: 0,
        minMs: durationMs,
        maxMs: durationMs,
      };
      this.series.set(key, value);
    }

    value.calls += 1;
    value.errors += failed ? 1 : 0;
    value.rows += rows;
    value.totalMs += durationMs;
    value.minMs = Math.min(value.minMs, durationMs);
    value.maxMs = Math.max(value.maxMs, durationMs);
    value.durationsMs.push(durationMs);
    if (value.durationsMs.length > MAX_SAMPLES_PER_SERIES) value.durationsMs.shift();

    this.logger.log({
      event: 'performance.sql.duration',
      requestId: context?.requestId ?? null,
      method,
      route,
      fingerprint,
      durationMs: round(durationMs),
      rows,
      outcome: failed ? 'error' : 'success',
    });
  }
}

export function fingerprintSql(sql: string): string {
  const normalized = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return `sql_${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return round(sorted[index]);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
