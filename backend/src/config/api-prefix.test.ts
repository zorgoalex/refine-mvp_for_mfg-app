import { describe, expect, it } from 'vitest';
import {
  getAuthCookiePath,
  isVersionedApiPrefix,
  normalizeApiPrefix,
  toNestGlobalPrefix,
} from './api-prefix';

describe('backend API prefix helpers', () => {
  it('normalizes API prefix to a leading slash and no trailing slash', () => {
    expect(normalizeApiPrefix('api/v1/')).toBe('/api/v1');
    expect(toNestGlobalPrefix('/api/v2')).toBe('api/v2');
  });

  it('accepts only explicit versioned API prefixes', () => {
    expect(isVersionedApiPrefix('/api/v1')).toBe(true);
    expect(isVersionedApiPrefix('/api/v12')).toBe(true);
    expect(isVersionedApiPrefix('/api')).toBe(false);
    expect(isVersionedApiPrefix('/api/latest')).toBe(false);
  });

  it('scopes auth refresh cookie to the versioned auth route', () => {
    expect(getAuthCookiePath('/api/v1')).toBe('/api/v1/auth');
  });
});
