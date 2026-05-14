import { createHash } from 'crypto';
import type { RateLimitSubject } from './rate-limit.types';

const KEY_VERSION = 'v1';

export function createRateLimitKey(feature: string, subject: RateLimitSubject): string {
  const parts = [
    `feature:${normalizePart(feature)}`,
    `route:${normalizePart(subject.route)}`,
    subject.userId === undefined || subject.userId === null
      ? null
      : `user:${hashPart(String(subject.userId))}`,
    subject.ipAddress ? `ip:${hashPart(normalizeIp(subject.ipAddress))}` : null,
    subject.username ? `username:${hashPart(subject.username.trim().toLowerCase())}` : null,
    subject.resourceId === undefined || subject.resourceId === null
      ? null
      : `resource:${hashPart(String(subject.resourceId))}`,
  ].filter((part): part is string => Boolean(part));

  return `erp:rate-limit:${KEY_VERSION}:${parts.join(':')}`;
}

function normalizePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function normalizeIp(value: string): string {
  return value.trim().toLowerCase();
}

function hashPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
