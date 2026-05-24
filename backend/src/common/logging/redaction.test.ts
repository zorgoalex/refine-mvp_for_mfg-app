import { describe, expect, it } from 'vitest';
import { isSensitiveKey, redactLogFields, redactLogValue } from './redaction';

describe('log redaction', () => {
  it('redacts sensitive object fields recursively', () => {
    expect(
      redactLogFields({
        username: 'manager',
        password: 'secret',
        nested: {
          refresh_token: 'refresh',
          GAS_API_KEY: 'gas',
        },
      }),
    ).toEqual({
      username: 'manager',
      password: '[REDACTED]',
      nested: {
        refresh_token: '[REDACTED]',
        GAS_API_KEY: '[REDACTED]',
      },
    });
  });

  it('redacts authorization headers and tokens inside strings', () => {
    expect(
      redactLogValue({
        message:
          'Authorization: Bearer abc.def.ghi access_token=abc123 refresh_token=def456 password=pw',
      }),
    ).toEqual({
      message:
        'Authorization: Bearer [REDACTED] access_token=[REDACTED] refresh_token=[REDACTED] password=[REDACTED]',
    });
  });

  it('redacts sensitive header-shaped values inside strings', () => {
    expect(
      redactLogValue(
        'Authorization: Basic basic-secret x-api-key: gas-secret Cookie: session=abc password: plain-secret',
      ),
    ).toBe(
      'Authorization: [REDACTED] x-api-key: [REDACTED] Cookie: [REDACTED] password: [REDACTED]',
    );
  });

  it('detects known sensitive keys', () => {
    expect(isSensitiveKey('password_hash')).toBe(true);
    expect(isSensitiveKey('AUTH0_M2M_CLIENT_SECRET')).toBe(true);
    expect(isSensitiveKey('order_name')).toBe(false);
  });

  it('handles circular objects safely', () => {
    const value: Record<string, unknown> = { id: 1 };
    value.self = value;

    expect(redactLogValue(value)).toEqual({
      id: 1,
      self: '[Circular]',
    });
  });
});
