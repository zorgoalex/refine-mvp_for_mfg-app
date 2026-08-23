import { json, urlencoded } from 'express';
import { normalizeApiPrefix } from '../config/api-prefix';

export const PERFORMANCE_RUM_BODY_LIMIT_BYTES = 16 * 1024;

export function performanceRumBodyPath(apiPrefix: string): string {
  return `${normalizeApiPrefix(apiPrefix)}/performance/rum`;
}

export function createPerformanceRumBodyParser() {
  return json({ limit: PERFORMANCE_RUM_BODY_LIMIT_BYTES, strict: true });
}

export function createPerformanceRumFormBodyParser() {
  return urlencoded({
    limit: PERFORMANCE_RUM_BODY_LIMIT_BYTES,
    extended: false,
    parameterLimit: 32,
  });
}
