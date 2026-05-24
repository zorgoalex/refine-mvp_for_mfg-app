import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger';

describe('api logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts sensitive metadata and errors before writing JSON logs', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('Authorization: Bearer abc.def.ghi failed');
    Object.assign(error, {
      refreshToken: 'refresh-secret',
      nested: { apiKey: 'gas-secret' },
    });

    logger.error('Login error password=plain-secret', error, {
      password: 'plain-secret',
      authorization: 'Bearer abc.def.ghi',
      url: 'https://example.test/callback?access_token=token123',
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(entry.message).toBe('Login error password=[REDACTED]');
    expect(entry.meta).toEqual({
      password: '[REDACTED]',
      authorization: '[REDACTED]',
      url: 'https://example.test/callback?access_token=[REDACTED]',
    });
    expect(entry.error.message).toBe('Authorization: Bearer [REDACTED] failed');
    expect(entry.error.refreshToken).toBe('[REDACTED]');
    expect(entry.error.nested.apiKey).toBe('[REDACTED]');
    expect(JSON.stringify(entry)).not.toContain('plain-secret');
    expect(JSON.stringify(entry)).not.toContain('refresh-secret');
    expect(JSON.stringify(entry)).not.toContain('abc.def.ghi');
    expect(JSON.stringify(entry)).not.toContain('gas-secret');
  });
});
