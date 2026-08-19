import { afterEach, describe, expect, it, vi } from 'vitest';
import viteConfig from '../../vite.config';

describe('Vite public environment boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes approved frontend config without bundling arbitrary VITE secrets', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    vi.stubEnv('VITE_ORDER_EXPORT_API_SECRET', 'must-never-enter-browser-bundle');

    expect(typeof viteConfig).toBe('function');
    const config = await (viteConfig as Function)({
      command: 'build',
      mode: 'production',
      isSsrBuild: false,
      isPreview: false,
    });
    const serializedEnv = config.define?.['import.meta.env'];
    const publicEnv = JSON.parse(serializedEnv);

    expect(config.envPrefix).toBe('ERP_PUBLIC_');
    expect(publicEnv.VITE_API_URL).toBe('https://api.example.test');
    expect(publicEnv).not.toHaveProperty('VITE_ORDER_EXPORT_API_SECRET');
    expect(serializedEnv).not.toContain('must-never-enter-browser-bundle');
  });
});
