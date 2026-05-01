export const DEFAULT_API_PREFIX = '/api/v1';

const API_PREFIX_PATTERN = /^\/api\/v[1-9]\d*$/;

export function normalizeApiPrefix(value: string): string {
  return `/${value.trim().replace(/^\/+|\/+$/g, '')}`;
}

export function isVersionedApiPrefix(value: string): boolean {
  return API_PREFIX_PATTERN.test(value);
}

export function toNestGlobalPrefix(value: string): string {
  return normalizeApiPrefix(value).replace(/^\//, '');
}

export function getAuthCookiePath(apiPrefix: string): string {
  return `${normalizeApiPrefix(apiPrefix)}/auth`;
}
