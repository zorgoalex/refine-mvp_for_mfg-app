import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

const enabled = process.env.ORDER_SSE_ACCELERATED_UI_CANARY === 'true';
const frontendUrl = trim(process.env.ORDER_SSE_STAGE_FRONTEND_URL ?? 'https://app-test.mebelkz.app');
const backendUrl = trim(process.env.ORDER_SSE_STAGE_BACKEND_URL ?? 'https://backend-test.mebelkz.app/api/v1');
const backendOrigin = new URL(backendUrl).origin;
const username = process.env.ERP_WORKER_LOGIN ?? '';
const password = process.env.ERP_WORKER_PASSWORD ?? '';
const expectedSha = (process.env.ORDER_SSE_EXPECTED_STAGE_SHA ?? '').toLowerCase();
const maxLongTaskMs = Number(process.env.ORDER_SSE_UI_MAX_LONG_TASK_MS ?? '500');
const vercelBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '';

test.describe('Order SSE accelerated stage UI canary', () => {
  test.skip(!enabled, 'Run with ORDER_SSE_ACCELERATED_UI_CANARY=true');
  test.setTimeout(10 * 60 * 1000);

  test('keeps show/edit stable through scroll and focus cycles', async ({ page, context }) => {
    expect(username).not.toBe('');
    expect(password).not.toBe('');
    expect(expectedSha).toMatch(/^[0-9a-f]{40}$/);

    const runtime = await page.request.get(`${frontendUrl}/runtime-config.json`, {
      headers: vercelBypassSecret
        ? { 'x-vercel-protection-bypass': vercelBypassSecret }
        : undefined,
    });
    expect(runtime.ok()).toBe(true);
    expect(await runtime.json()).toMatchObject({
      apiUrl: backendOrigin,
      deployment: { gitCommitSha: expectedSha },
      features: { orderRealtime: true, backendAuth: true, backendOrdersRead: true },
    });
    const ready = await page.request.get(`${backendOrigin}/health/ready`);
    expect(ready.ok()).toBe(true);
    const readyBody = await ready.json();
    expect(readyBody).toMatchObject({
      status: 'ready',
      deployment: { gitCommitSha: expectedSha },
      checks: { realtime: { status: 'ok' } },
    });
    expect(String(readyBody.checks?.realtime?.message ?? '')).not.toMatch(/\bdisabled\b/i);

    await installPerformanceObservers(page);
    const diagnostics = recordDiagnostics(page);
    const accessToken = await login(page);
    const orderId = await findOrderId(page, accessToken);

    await exerciseRoute(page, diagnostics, `/orders/show/${orderId}`, 'show');
    const showRealtimeCount = diagnostics.requests.filter(isRealtimeRequest).length;
    expect(showRealtimeCount).toBeGreaterThan(0);
    const showMetrics = await readPerformanceMetrics(page);

    const editRealtimeStart = diagnostics.requests.length;
    await exerciseRoute(page, diagnostics, `/orders/edit/${orderId}`, 'edit');
    const navigationStart = diagnostics.mainFrameNavigations;
    const interactionRequestStart = diagnostics.requests.length;
    await runFocusCycles(page, context);
    await exerciseScrollWithoutRemount(page, 'edit');
    await page.waitForTimeout(1000);
    const editRequests = diagnostics.requests.slice(editRealtimeStart);
    expect(editRequests.filter(isRealtimeRequest), 'edit route must not open Order SSE transport').toEqual([]);
    const interactionRefreshes = diagnostics.requests.slice(interactionRequestStart).filter(isOrderRefreshRequest);
    expect(interactionRefreshes, 'edit focus/scroll triggered data reload').toEqual([]);

    expect(diagnostics.httpErrors, 'unexpected HTTP errors').toEqual([]);
    expect(diagnostics.pageErrors, 'page errors').toEqual([]);
    expect(diagnostics.consoleErrors, 'console errors').toEqual([]);
    expect(diagnostics.mainFrameNavigations, 'focus/scroll caused document reload').toBe(navigationStart);

    const editMetrics = await readPerformanceMetrics(page);
    expect(showMetrics.maxLongTaskMs).toBeLessThanOrEqual(maxLongTaskMs);
    expect(showMetrics.cumulativeLayoutShift).toBeLessThan(0.25);
    expect(editMetrics.maxLongTaskMs).toBeLessThanOrEqual(maxLongTaskMs);
    expect(editMetrics.cumulativeLayoutShift).toBeLessThan(0.25);
    await test.info().attach('order-sse-ui-performance.json', {
      body: Buffer.from(JSON.stringify({ show: showMetrics, edit: editMetrics }, null, 2)),
      contentType: 'application/json',
    });
  });
});

async function login(page: Page): Promise<string> {
  await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded' });
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes('/api/v1/auth/login') && response.request().method() === 'POST');
  await page.locator('input[autocomplete="username"], input#username').fill(username);
  await page.locator('input[autocomplete="current-password"], input#password').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.accessToken).toEqual(expect.any(String));
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  return body.accessToken;
}

async function findOrderId(page: Page, accessToken: string): Promise<number> {
  const response = await page.request.get(`${backendUrl}/orders?page=1&pageSize=50`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const order = body.data?.find((candidate: { partsCount?: number }) => Number(candidate.partsCount) > 0)
    ?? body.data?.[0];
  const orderId = Number(order?.orderId);
  expect(Number.isSafeInteger(orderId) && orderId > 0).toBe(true);
  return orderId;
}

async function exerciseRoute(
  page: Page,
  diagnostics: ReturnType<typeof recordDiagnostics>,
  path: string,
  kind: 'show' | 'edit',
) {
  await page.goto(`${frontendUrl}${path}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByText('Произошла ошибка')).toHaveCount(0);
  const requestStart = diagnostics.requests.length;
  const navigationStart = diagnostics.mainFrameNavigations;
  await exerciseScrollWithoutRemount(page, kind);
  await page.waitForTimeout(1000);
  const scrollRequests = diagnostics.requests.slice(requestStart).filter(isOrderRefreshRequest);
  expect(scrollRequests, `${kind} scroll triggered data reload`).toEqual([]);
  expect(diagnostics.mainFrameNavigations, `${kind} scroll caused document reload`).toBe(navigationStart);
}

async function exerciseScrollWithoutRemount(page: Page, kind: 'show' | 'edit') {
  const primaryOwner = kind === 'show'
    ? page.locator('.ant-table-wrapper:visible').first()
    : page.locator('form:visible').first();
  await expect(primaryOwner).toBeVisible({ timeout: 30000 });
  const owners = [primaryOwner];
  const editTableOwner = page.locator('.ant-table-wrapper:visible').first();
  if (kind === 'edit' && await editTableOwner.count()) owners.push(editTableOwner);
  const markers: string[] = [];
  for (let index = 0; index < owners.length; index += 1) {
    const marker = `sse-canary-${kind}-${index}-${Date.now()}`;
    await owners[index].evaluate((element, value) => {
      (element as HTMLElement).dataset.sseCanaryOwner = value;
    }, marker);
    markers.push(marker);
  }
  const scrollable = page.locator('.ant-table-body:visible').first();
  if (await scrollable.count()) {
    for (let index = 0; index < 5; index += 1) {
      await scrollable.evaluate((element, step) => {
        element.scrollTop = (step % 2) * Math.max(1, element.scrollHeight - element.clientHeight);
        element.scrollLeft = (step % 2) * Math.max(1, element.scrollWidth - element.clientWidth);
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, index);
      await page.waitForTimeout(100);
    }
  } else {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, -800);
  }
  for (const marker of markers) {
    await expect(page.locator(`[data-sse-canary-owner="${marker}"]`)).toHaveCount(1);
  }
}

async function runFocusCycles(page: Page, context: BrowserContext) {
  const other = await context.newPage();
  await other.setContent('<title>Focus target</title>');
  for (let index = 0; index < 3; index += 1) {
    await other.bringToFront();
    await page.waitForTimeout(250);
    await page.bringToFront();
    await page.waitForTimeout(500);
  }
  await other.close();
}

function recordDiagnostics(page: Page) {
  const diagnostics = {
    requests: [] as Request[],
    httpErrors: [] as string[],
    pageErrors: [] as string[],
    consoleErrors: [] as string[],
    mainFrameNavigations: 0,
  };
  page.on('request', (request) => diagnostics.requests.push(request));
  page.on('response', (response) => {
    if (response.status() === 401 || response.status() >= 500) {
      diagnostics.httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) diagnostics.mainFrameNavigations += 1;
  });
  return diagnostics;
}

async function installPerformanceObservers(page: Page) {
  await page.addInitScript(() => {
    const metrics = { longTasks: [] as number[], cumulativeLayoutShift: 0 };
    (window as unknown as { __orderSseCanaryMetrics: typeof metrics }).__orderSseCanaryMetrics = metrics;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) metrics.longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) metrics.cumulativeLayoutShift += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

async function readPerformanceMetrics(page: Page) {
  return page.evaluate(() => {
    const metrics = (window as unknown as {
      __orderSseCanaryMetrics: { longTasks: number[]; cumulativeLayoutShift: number };
    }).__orderSseCanaryMetrics;
    return {
      longTaskCount: metrics.longTasks.length,
      maxLongTaskMs: Math.max(0, ...metrics.longTasks),
      cumulativeLayoutShift: metrics.cumulativeLayoutShift,
    };
  });
}

function isRealtimeRequest(request: Request) {
  return /\/orders\/\d+\/(?:detail-live-state|live-events)(?:\?|$)/.test(request.url());
}

function isOrderRefreshRequest(request: Request) {
  const url = request.url();
  return isRealtimeRequest(request)
    || /\/api\/v1\/orders(?:\/|\?|$)/.test(url)
    || /\/api\/v1\/orders\/form-data(?:\?|$)/.test(url);
}

function trim(value: string) {
  return value.replace(/\/+$/, '');
}
