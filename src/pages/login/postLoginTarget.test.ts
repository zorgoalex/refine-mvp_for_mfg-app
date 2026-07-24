import { describe, expect, it } from 'vitest';
import { resolvePostLoginTarget } from './postLoginTarget';

describe('post-login hard-navigation target', () => {
  const origin = 'https://app.example.test';

  it('preserves an encoded same-origin deep link', () => {
    expect(resolvePostLoginTarget(
      '?to=%2Forders%2Fshow%2F42%3Ftab%3Dpayments%23history',
      origin,
    )).toBe('/orders/show/42?tab=payments#history');
  });

  it('falls back to root for missing, external or protocol-relative targets', () => {
    expect(resolvePostLoginTarget('', origin)).toBe('/');
    expect(resolvePostLoginTarget('?to=https%3A%2F%2Fevil.test%2F', origin)).toBe('/');
    expect(resolvePostLoginTarget('?to=%2F%2Fevil.test%2F', origin)).toBe('/');
    expect(resolvePostLoginTarget('?to=%2F%5Cevil.test%2F', origin)).toBe('/');
  });
});
