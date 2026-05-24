import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth0Token', () => ({
  getM2MToken: vi.fn().mockResolvedValue('m2m-token'),
}));

describe('vlm client logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('redacts provider error details before writing analyze failures to the console sink', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: 'Authorization: Basic provider-basic-secret',
          details: 'x-api-key: provider-api-key password: provider-password',
          code: 'UNAUTHORIZED',
        }),
      }),
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { analyzeImage } = await import('./vlmClient');

    await expect(analyzeImage('https://images.example.test/order.jpg')).rejects.toMatchObject({
      error: 'Authorization: [REDACTED]',
      details: 'x-api-key: [REDACTED] password: [REDACTED]',
      code: 'UNAUTHORIZED',
    });

    const logged = consoleSpy.mock.calls.map((args) => JSON.stringify(args)).join('\n');
    expect(logged).toContain('[REDACTED]');
    expect(logged).not.toContain('provider-basic-secret');
    expect(logged).not.toContain('provider-api-key');
    expect(logged).not.toContain('provider-password');
  });
});
