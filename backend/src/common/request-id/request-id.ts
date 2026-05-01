import { randomUUID } from 'node:crypto';

export const DEFAULT_REQUEST_ID_HEADER = 'x-request-id';

const VALID_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

export function normalizeRequestId(value: unknown): string | null {
  if (Array.isArray(value)) {
    return normalizeRequestId(value[0]);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!VALID_REQUEST_ID_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function createRequestId(): string {
  return `req_${randomUUID()}`;
}

export function getOrCreateRequestId(value: unknown): string {
  return normalizeRequestId(value) ?? createRequestId();
}
