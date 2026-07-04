import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

/**
 * Opt-in stage canary for the hybrid WorkOS SSO login.
 *
 * Runs a REAL hosted AuthKit password login with the durable e2e user
 * (users 80/81 in erp_test, WorkOS test environment) against the deployed
 * stage frontend, then proves the ERP session and the audit row
 * (auth.login.success, source='workos') in the stage database, and checks the
 * logout semantics: after logout the next SSO attempt must ask for the
 * password again instead of silently reusing the provider session.
 *
 * Prerequisites (phase E): migration 052 applied, BACKEND_ENABLE_WORKOS_AUTH
 * and runtime workosAuth enabled, stage redirect URI registered in the WorkOS
 * dashboard.
 *
 * AuthKit UI rules (POC gotcha #9): the hosted UI locale is unpredictable, so
 * selectors use roles/types only, never visible text; the TOTP form is six
 * single-digit auto-advancing boxes (typed per character); the email step
 * needs an explicit submit click.
 */

const canaryEnabled = process.env.WORKOS_STAGE_CANARY === 'true';
const frontendUrl = trimTrailingSlash(
  process.env.WORKOS_STAGE_FRONTEND_URL ??
    process.env.FRONTEND_STAGE_URL ??
    'https://stage.mebelkz.app',
);
const postgresContainer =
  process.env.WORKOS_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const vercelAutomationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

const ssoEmail = process.env.WORKOS_E2E_EMAIL ?? 'e2e-workos-poc@mebelkz.local';
const ssoPassword = process.env.WORKOS_E2E_PASSWORD?.trim();
const ssoUsername = process.env.WORKOS_E2E_USERNAME ?? 'e2e_workos_poc';
// Optional: base32 TOTP secret of the enrolled factor. Only needed when the
// WorkOS environment presents an MFA challenge for the e2e user.
const ssoTotpSecret = process.env.WORKOS_E2E_TOTP_SECRET?.trim();

test.describe('WorkOS SSO stage canary', () => {
  test.skip(!canaryEnabled, 'Run with WORKOS_STAGE_CANARY=true');
  test.skip(
    canaryEnabled && !ssoPassword,
    'WORKOS_E2E_PASSWORD is required (AuthKit password of the durable e2e user).',
  );
  test.skip(
    canaryEnabled && !vercelAutomationBypassSecret,
    'VERCEL_AUTOMATION_BYPASS_SECRET is required for protected deployed frontend access.',
  );
  test.skip(
    canaryEnabled && !dockerContainerExists(postgresContainer),
    `Stage postgres container ${postgresContainer} is required for the audit check.`,
  );
  test.setTimeout(240000);

  test('hosted AuthKit password login lands an ERP session, writes workos audit, and logout kills the provider session', async ({
    page,
  }) => {
    const startedAt = psql('SELECT now()::text;');

    await expectWorkosRuntimeConfig(page.request);
    if (vercelAutomationBypassSecret) {
      await page.context().setExtraHTTPHeaders({
        'x-vercel-protection-bypass': vercelAutomationBypassSecret,
      });
    }

    // --- SSO login through the hosted AuthKit UI ---
    await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Войти через SSO' }).click();
    await page.waitForURL(/authkit|workos/i, { timeout: 30000 });

    await completeAuthKitPasswordLogin(page);

    await page.waitForURL(
      (url) => url.origin === new URL(frontendUrl).origin && !url.pathname.includes('/login'),
      { timeout: 60000 },
    );

    // --- Session proof: the app is authenticated as the e2e user ---
    await expect
      .poll(
        () =>
          psql(`
            SELECT count(*) FROM audit_log
            WHERE event = 'auth.login.success'
              AND source = 'workos'
              AND username = '${sqlQuote(ssoUsername)}'
              AND created_at >= TIMESTAMPTZ '${sqlQuote(startedAt)}'
          `),
        { timeout: 30000 },
      )
      .toBe('1');

    // --- Logout semantics: the provider session must die with ours ---
    const userMenu = page.getByRole('button', { name: new RegExp(ssoUsername, 'i') });
    await userMenu.waitFor({ state: 'visible', timeout: 30000 });
    await userMenu.click();
    await page.getByText('Выйти').click();

    // The frontend follows providerLogoutUrl (WorkOS session end) and WorkOS
    // redirects back to the configured logout URL → our /login.
    await page.waitForURL(/\/login/, { timeout: 60000 });

    const logoutAudit = psql(`
      SELECT count(*) FROM audit_log
      WHERE event = 'auth.logout'
        AND username = '${sqlQuote(ssoUsername)}'
        AND created_at >= TIMESTAMPTZ '${sqlQuote(startedAt)}'
    `);
    expect(Number(logoutAudit)).toBeGreaterThanOrEqual(1);

    // A fresh SSO attempt must ask for credentials again — an email or
    // password input on the hosted page, not an instant redirect back.
    await page.getByRole('button', { name: 'Войти через SSO' }).click();
    await page.waitForURL(/authkit|workos/i, { timeout: 30000 });
    await expect(
      page.locator('input[type="email"], input[name="email"], input[type="password"]').first(),
    ).toBeVisible({ timeout: 20000 });
  });
});

async function completeAuthKitPasswordLogin(page: Page): Promise<void> {
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  await emailInput.waitFor({ timeout: 20000 });
  await emailInput.fill(ssoEmail);
  // The email step needs an explicit submit; locale-proof selector by type.
  await page.locator('button[type="submit"]').first().click();

  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.waitFor({ timeout: 20000 });
  await passwordInput.fill(ssoPassword as string);
  await page.keyboard.press('Enter');

  // Optional TOTP challenge: six single-digit boxes with auto-advance.
  const totpInput = page
    .locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i]')
    .first();
  const challenged = await totpInput
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (challenged) {
    if (!ssoTotpSecret) {
      throw new Error(
        'AuthKit presented an MFA challenge but WORKOS_E2E_TOTP_SECRET is not set.',
      );
    }
    await totpInput.click();
    await page.keyboard.type(totp(ssoTotpSecret), { delay: 80 });
    await page.keyboard.press('Enter');
  }
}

async function expectWorkosRuntimeConfig(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${frontendUrl}/runtime-config.json`, {
    headers: vercelAutomationBypassSecret
      ? { 'x-vercel-protection-bypass': vercelAutomationBypassSecret }
      : {},
  });
  expect(response.ok()).toBe(true);
  const runtimeConfig = await response.json();
  expect(runtimeConfig.features?.backendAuth).toBe(true);
  expect(runtimeConfig.features?.workosAuth).toBe(true);
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totp(secret: string, timeStepSeconds = 30, digits = 6): string {
  const counter = Math.floor(Date.now() / 1000 / timeStepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', postgresContainer, 'psql', '-U', 'postgres', '-d', 'erpdb', '-qAtX', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 },
  ).trim();
}

function dockerContainerExists(containerName: string): boolean {
  try {
    execFileSync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
