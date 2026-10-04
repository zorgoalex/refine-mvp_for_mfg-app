import { request } from 'playwright-core';

// Gets the Vercel protection-bypass COOKIE for a deployment. The secret is sent exactly once, in one
// request to the deployment's own origin that follows no redirect, so it cannot be forwarded to
// another origin. The browser then uses only the returned cookies, which it scopes to that host.
export async function vercelBypassCookies(base, secret) {
  if (!secret) return [];
  const { origin, hostname } = new URL(base);
  const api = await request.newContext();
  try {
    await api.get(`${origin}/`, {
      headers: { 'x-vercel-protection-bypass': secret, 'x-vercel-set-bypass-cookie': 'true' },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    const state = await api.storageState();
    return state.cookies.filter((cookie) => cookie.domain.replace(/^\./, '') === hostname);
  } finally {
    await api.dispose();
  }
}
