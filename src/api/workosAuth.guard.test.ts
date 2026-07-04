import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getFeatureFlags, mergeRuntimeFeatureFlags } from '../config/featureFlags';

const authApiSource = readFileSync(new URL('./authApi.ts', import.meta.url), 'utf8');
const callbackSource = readFileSync(
  new URL('../pages/login/WorkosCallback.tsx', import.meta.url),
  'utf8',
);
const loginPageSource = readFileSync(new URL('../pages/login/index.tsx', import.meta.url), 'utf8');
const profileSource = readFileSync(new URL('../pages/profile/index.tsx', import.meta.url), 'utf8');
const authProviderSource = readFileSync(new URL('../authProvider.ts', import.meta.url), 'utf8');

describe('workosAuth feature flag', () => {
  it('is off by default and readable from env and runtime config', () => {
    expect(getFeatureFlags({}).workosAuth).toBe(false);
    expect(
      getFeatureFlags({ VITE_WORKOS_AUTH: 'true', VITE_USE_BACKEND_AUTH: 'true' }).workosAuth,
    ).toBe(true);
    expect(
      mergeRuntimeFeatureFlags(getFeatureFlags({ VITE_USE_BACKEND_AUTH: 'true' }), {
        workosAuth: 'true',
      }).workosAuth,
    ).toBe(true);
  });

  it('requires backend-auth mode (POC gotcha: legacy check() cannot see the cookie session)', () => {
    expect(getFeatureFlags({ VITE_WORKOS_AUTH: 'true' }).workosAuth).toBe(false);
    expect(
      mergeRuntimeFeatureFlags(getFeatureFlags({}), { workosAuth: 'true', backendAuth: 'false' })
        .workosAuth,
    ).toBe(false);
  });

  it('warns ops when workosAuth is coerced off by a missing backendAuth (plan §5)', async () => {
    const { vi } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      mergeRuntimeFeatureFlags(getFeatureFlags({}), { workosAuth: 'true', backendAuth: 'false' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('workosAuth requires backendAuth'),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('workos callback helpers contract', () => {
  it('never auto-refresh-retries the single-use code exchange (skipAuthRefresh)', () => {
    const callbackHelpers = authApiSource
      .split('async workos')
      .filter((chunk) => chunk.startsWith('Callback') || chunk.startsWith('LinkCallback'));

    expect(callbackHelpers).toHaveLength(2);
    for (const helper of callbackHelpers) {
      expect(helper).toContain('skipAuthRefresh: true');
    }
  });

  it('passes state alongside code to both callback endpoints', () => {
    expect(authApiSource).toContain('workosCallback(code: string, state: string)');
    expect(authApiSource).toContain('workosLinkCallback(code: string, state: string)');
    expect(callbackSource).toContain('searchParams.get("state")');
  });

  it('guards the single-use code against StrictMode double-mount', () => {
    expect(callbackSource).toContain('const consumedCodes = new Map<string, "pending" | "settled">()');
    // A revisit of a burned code shows an explicit error, never a dead spinner.
    expect(callbackSource).toContain('Ссылка входа уже использована');
    // Pre-exchange failures (e.g. link-mode refresh) have not burned the
    // code — the same callback URL may retry in place.
    expect(callbackSource).toContain('consumedCodes.delete(code)');
    expect(callbackSource).toContain('exchangeStarted');
  });

  it('keeps the matched link intent until the exchange starts (pre-exchange retry stays a link)', () => {
    const linkBranch = callbackSource.split('if (isLink)')[1]?.split('// SPA navigation')[0] ?? '';
    // refresh (pre-exchange) comes BEFORE the intent removal: a failed
    // refresh leaves the intent in place so the retried callback routes as
    // a link again.
    expect(linkBranch).toContain('await authApi.refresh()');
    expect(linkBranch).toContain('sessionStorage.removeItem(LINK_INTENT_KEY)');
    expect(linkBranch.indexOf('authApi.refresh()')).toBeLessThan(
      linkBranch.indexOf('sessionStorage.removeItem(LINK_INTENT_KEY)'),
    );
  });

  it('binds the link intent to the exact flow state, never a stale boolean', () => {
    const linkCardSource = readFileSync(
      new URL('../pages/profile/WorkosLinkCard.tsx', import.meta.url),
      'utf8',
    );
    expect(callbackSource).toContain('sessionStorage.getItem(LINK_INTENT_KEY) === state');
    expect(callbackSource).not.toContain('=== "1"');
    expect(linkCardSource).toContain('searchParams.get("state")');
    expect(linkCardSource).toContain('markWorkosLinkIntent(state)');
  });

  it('keeps the happy path in the SPA and rehydrates before navigating (no full reload)', () => {
    // A full reload would discard the in-memory access token and force an
    // extra /auth/refresh round-trip (POC race #5).
    expect(callbackSource).not.toContain('window.location.replace');
    expect(callbackSource).toContain('await authApi.me()');
    expect(callbackSource.indexOf('authApi.me()')).toBeLessThan(
      callbackSource.indexOf('navigate("/", { replace: true })'),
    );
  });

  it('restores the session from the refresh cookie before finishing a link', () => {
    const linkBranch = callbackSource.split('if (isLink)')[1] ?? '';
    expect(linkBranch).toContain('await authApi.refresh()');
    expect(linkBranch.indexOf('authApi.refresh()')).toBeLessThan(
      linkBranch.indexOf('workosLinkCallback'),
    );
  });
});

describe('workos UI gating', () => {
  it('login SSO button and profile link card render only behind the flag', () => {
    expect(loginPageSource).toContain('featureFlags.workosAuth && <WorkosSsoButton />');
    expect(profileSource).toContain('featureFlags.workosAuth && <WorkosLinkCard />');
  });
});

describe('provider logout fallback warning (plan §4.4)', () => {
  it('logout stores the one-shot flag when the provider logout is unavailable', () => {
    expect(authProviderSource).toContain("providerLogoutStatus === 'unavailable'");
    expect(authProviderSource).toContain('sessionStorage.setItem(SSO_LOGOUT_WARNING_KEY');
  });

  it('login page consumes the flag and shows the inline warning', () => {
    expect(loginPageSource).toContain('consumeSsoLogoutWarning');
    expect(loginPageSource).toContain('sessionStorage.removeItem(SSO_LOGOUT_WARNING_KEY)');
    expect(loginPageSource).toContain('Сессия SSO-провайдера может быть ещё активна');
  });
});
