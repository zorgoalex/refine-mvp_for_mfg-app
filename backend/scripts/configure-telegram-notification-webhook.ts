const action = process.argv[2] ?? 'set';
const token = requiredEnv('TELEGRAM_NOTIFICATION_BOT_TOKEN');
const apiBase = (process.env.TELEGRAM_NOTIFICATION_API_BASE ?? 'https://api.telegram.org').replace(
  /\/+$/,
  '',
);
validateApiBase(apiBase);

if (!['set', 'info', 'delete'].includes(action)) {
  fail('Usage: npm run telegram-notifications:webhook -- set|info|delete');
}

async function main(): Promise<void> {
  if (action === 'set') {
    const webhookUrl = requiredEnv('TELEGRAM_NOTIFICATION_WEBHOOK_PUBLIC_URL');
    const secret = requiredEnv('TELEGRAM_NOTIFICATION_WEBHOOK_SECRET');
    const parsed = new URL(webhookUrl);
    if (parsed.protocol !== 'https:') fail('Webhook public URL must use HTTPS');

    await call('setWebhook', {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ['message'],
      drop_pending_updates: false,
    });
    process.stdout.write(`Telegram webhook configured: ${webhookUrl}\n`);
    return;
  }

  if (action === 'delete') {
    await call('deleteWebhook', { drop_pending_updates: false });
    process.stdout.write('Telegram webhook deleted; pending updates preserved.\n');
    return;
  }

  const result = await call('getWebhookInfo', {});
  const safe = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  process.stdout.write(
    `${JSON.stringify(
      {
        url: safe.url ?? '',
        pendingUpdateCount: safe.pending_update_count ?? null,
        lastErrorDate: safe.last_error_date ?? null,
        lastErrorMessage: safe.last_error_message ?? null,
        maxConnections: safe.max_connections ?? null,
        allowedUpdates: safe.allowed_updates ?? null,
      },
      null,
      2,
    )}\n`,
  );
}

async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    fail(`Telegram ${method} request failed`);
  }

  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
  } | null;
  if (!response.ok || payload?.ok !== true) {
    fail(`Telegram ${method} failed: ${payload?.description ?? `HTTP ${response.status}`}`);
  }
  return payload.result;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function validateApiBase(value: string): void {
  const url = new URL(value);
  const official =
    url.protocol === 'https:' &&
    url.hostname === 'api.telegram.org' &&
    url.port === '' &&
    url.pathname === '/' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash;
  const localMock =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (!official && !localMock) {
    fail('TELEGRAM_NOTIFICATION_API_BASE must be https://api.telegram.org');
  }
}

function fail(message: string): never {
  throw new Error(message);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Telegram webhook setup failed'}\n`);
  process.exitCode = 1;
});
