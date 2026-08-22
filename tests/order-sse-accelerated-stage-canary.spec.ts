import {
  expect,
  request as playwrightRequest,
  test,
  type BrowserContext,
  type Page,
  type Request,
} from '@playwright/test';

const enabled = process.env.ORDER_SSE_ACCELERATED_UI_CANARY === 'true';
const frontendUrl = trim(process.env.ORDER_SSE_STAGE_FRONTEND_URL ?? 'https://app-test.mebelkz.app');
const backendUrl = trim(process.env.ORDER_SSE_STAGE_BACKEND_URL ?? 'https://backend-test.mebelkz.app/api/v1');
const backendOrigin = new URL(backendUrl).origin;
const username = process.env.ORDER_SSE_UI_USERNAME
  ?? process.env.CODEX_PLAYWRIGHT_USERNAME
  ?? process.env.ERP_WORKER_LOGIN
  ?? '';
const password = process.env.ORDER_SSE_UI_PASSWORD
  ?? process.env.CODEX_PLAYWRIGHT_PASSWORD
  ?? process.env.ERP_WORKER_PASSWORD
  ?? '';
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
    await login(page);
    const orderId = await findOrderId();
    const diagnostics = recordDiagnostics(page);

    await exerciseRoute(page, diagnostics, `/orders/show/${orderId}`, 'show');
    const showRealtimeCount = diagnostics.requests.filter(isRealtimeRequest).length;
    expect(showRealtimeCount).toBeGreaterThan(0);
    const showMetrics = await readPerformanceMetrics(page);

    await gotoWithNetworkChangeRetry(page, `${frontendUrl}/orders`);
    await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const editRealtimeStart = diagnostics.requests.length;
    await exerciseRoute(page, diagnostics, `/orders/edit/${orderId}`, 'edit');
    const editInitialScrollMetrics = await readPerformanceMetrics(page);
    const navigationStart = diagnostics.mainFrameNavigations;
    const interactionRequestStart = diagnostics.requests.length;
    await resetPerformanceMetrics(page);
    await runFocusCycles(page, context);
    const editFocusMetrics = await readPerformanceMetrics(page);
    await resetPerformanceMetrics(page);
    await exerciseScrollWithoutRemount(page, 'edit');
    await page.waitForTimeout(1000);
    const editFinalScrollMetrics = await readPerformanceMetrics(page);
    const editRequests = diagnostics.requests.slice(editRealtimeStart);
    const editRealtimeRequests = editRequests.filter(isRealtimeRequest).map(requestLabel);
    expect(editRealtimeRequests, 'edit route must not open Order SSE transport').toEqual([]);
    const interactionRefreshes = diagnostics.requests.slice(interactionRequestStart)
      .filter(isOrderRefreshRequest)
      .map(requestLabel);
    expect(interactionRefreshes, 'edit focus/scroll triggered data reload').toEqual([]);

    expect(diagnostics.httpErrors, 'unexpected HTTP errors').toEqual([]);
    expect(diagnostics.pageErrors, 'page errors').toEqual([]);
    expect(diagnostics.consoleErrors, 'console errors').toEqual([]);
    expect(diagnostics.mainFrameNavigations, 'focus/scroll caused document reload').toBe(navigationStart);

    const performanceEvidence = {
      showScroll: showMetrics,
      editInitialScroll: editInitialScrollMetrics,
      editFocus: editFocusMetrics,
      editFinalScroll: editFinalScrollMetrics,
    };
    console.log(`ORDER_SSE_UI_METRICS ${JSON.stringify(performanceEvidence)}`);
    await test.info().attach('order-sse-ui-performance.json', {
      body: Buffer.from(JSON.stringify(performanceEvidence, null, 2)),
      contentType: 'application/json',
    });
    expect(showMetrics.maxLongTaskMs).toBeLessThanOrEqual(maxLongTaskMs);
    expect(showMetrics.cumulativeLayoutShift).toBeLessThan(0.25);
    for (const [phase, metrics] of Object.entries({
      editInitialScroll: editInitialScrollMetrics,
      editFocus: editFocusMetrics,
      editFinalScroll: editFinalScrollMetrics,
    })) {
      expect(metrics.maxLongTaskMs, `${phase} long task`).toBeLessThanOrEqual(maxLongTaskMs);
      expect(metrics.cumulativeLayoutShift, `${phase} layout shift`).toBeLessThan(0.25);
    }
  });
});

async function login(page: Page): Promise<void> {
  await gotoWithNetworkChangeRetry(page, `${frontendUrl}/login`);
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes('/api/v1/auth/login') && response.request().method() === 'POST');
  await page.locator('input[autocomplete="username"], input#username').fill(username);
  await page.locator('input[autocomplete="current-password"], input#password').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  await page.waitForURL((url) => !url.pathname.includes('/login'));
}

async function findOrderId(): Promise<number> {
  const api = await playwrightRequest.newContext();
  try {
    const apiLogin = await api.post(`${backendUrl}/auth/login`, {
      data: { username, password },
    });
    expect(apiLogin.ok()).toBe(true);
    const loginBody = await apiLogin.json();
    expect(loginBody.accessToken).toEqual(expect.any(String));
    const response = await api.get(`${backendUrl}/orders?page=1&pageSize=50`, {
      headers: { authorization: `Bearer ${loginBody.accessToken}` },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    const order = body.data?.find((candidate: { partsCount?: number }) => Number(candidate.partsCount) > 0)
      ?? body.data?.[0];
    const orderId = Number(order?.orderId);
    expect(Number.isSafeInteger(orderId) && orderId > 0).toBe(true);
    return orderId;
  } finally {
    await api.dispose();
  }
}

async function exerciseRoute(
  page: Page,
  diagnostics: ReturnType<typeof recordDiagnostics>,
  path: string,
  kind: 'show' | 'edit',
) {
  await gotoWithNetworkChangeRetry(page, `${frontendUrl}${path}`);
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByText('Произошла ошибка')).toHaveCount(0);
  const routeOwner = kind === 'show'
    ? page.locator('.ant-table-wrapper:visible').first()
    : page.locator('.order-form-operational:visible').first();
  await expect(routeOwner).toBeVisible({ timeout: 30000 });
  if (kind === 'show') {
    await expect.poll(
      () => diagnostics.requests.filter(isRealtimeRequest).length,
      { timeout: 30000 },
    ).toBeGreaterThanOrEqual(2);
  }
  await page.waitForTimeout(2000);
  const requestStart = diagnostics.requests.length;
  const navigationStart = diagnostics.mainFrameNavigations;
  await exerciseScrollWithoutRemount(page, kind);
  await page.waitForTimeout(1000);
  const scrollRequests = diagnostics.requests.slice(requestStart).filter(isOrderRefreshRequest);
  const scrollRequestLabels = scrollRequests.map(requestLabel);
  expect(scrollRequestLabels, `${kind} scroll triggered data reload`).toEqual([]);
  expect(diagnostics.mainFrameNavigations, `${kind} scroll caused document reload`).toBe(navigationStart);
}

async function exerciseScrollWithoutRemount(page: Page, kind: 'show' | 'edit') {
  const primaryOwner = kind === 'show'
    ? page.locator('.ant-table-wrapper:visible').first()
    : page.locator('.order-form-operational:visible').first();
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
  const hasScrollable = await scrollable.count();
  await resetPerformanceMetrics(page);
  if (hasScrollable) {
    await markPerformancePhase(page, 'vertical-start');
    await scrollable.hover();
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(250);
    await page.mouse.wheel(0, -800);
    await page.waitForTimeout(250);
    await markPerformancePhase(page, 'vertical-end');
    await markPerformancePhase(page, 'horizontal-start');
    await scrollable.evaluate((element) => {
      element.scrollTo({ left: Math.max(1, element.scrollWidth - element.clientWidth) });
    });
    await page.waitForTimeout(250);
    await scrollable.evaluate((element) => element.scrollTo({ left: 0 }));
    await page.waitForTimeout(250);
    await markPerformancePhase(page, 'horizontal-end');
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
      diagnostics.httpErrors.push(
        `${response.status()} ${new URL(response.url()).pathname} page=${new URL(page.url()).pathname}`,
      );
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
    const metrics = {
      longTasks: [] as Array<{ startTime: number; duration: number }>,
      cumulativeLayoutShift: 0,
    };
    (window as unknown as { __orderSseCanaryMetrics: typeof metrics }).__orderSseCanaryMetrics = metrics;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        metrics.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
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
      __orderSseCanaryMetrics: {
        longTasks: Array<{ startTime: number; duration: number }>;
        cumulativeLayoutShift: number;
      };
    }).__orderSseCanaryMetrics;
    return {
      longTaskCount: metrics.longTasks.length,
      maxLongTaskMs: Math.max(0, ...metrics.longTasks.map((entry) => entry.duration)),
      cumulativeLayoutShift: metrics.cumulativeLayoutShift,
      longTasks: metrics.longTasks,
      marks: performance.getEntriesByType('mark')
        .filter((entry) => entry.name.startsWith('order-sse-canary:'))
        .map((entry) => ({ name: entry.name, startTime: entry.startTime })),
    };
  });
}

async function resetPerformanceMetrics(page: Page) {
  await page.evaluate(() => {
    const metrics = (window as unknown as {
      __orderSseCanaryMetrics: {
        longTasks: Array<{ startTime: number; duration: number }>;
        cumulativeLayoutShift: number;
      };
    }).__orderSseCanaryMetrics;
    metrics.longTasks.length = 0;
    metrics.cumulativeLayoutShift = 0;
    for (const entry of performance.getEntriesByType('mark')) {
      if (entry.name.startsWith('order-sse-canary:')) performance.clearMarks(entry.name);
    }
  });
}

async function markPerformancePhase(page: Page, name: string) {
  await page.evaluate((markName) => performance.mark(`order-sse-canary:${markName}`), name);
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

function requestLabel(request: Request) {
  const url = new URL(request.url());
  const referer = request.headers().referer ?? 'none';
  return `${request.method()} ${url.pathname}${url.search} referer=${referer}`;
}

function trim(value: string) {
  return value.replace(/\/+$/, '');
}

async function gotoWithNetworkChangeRetry(page: Page, url: string) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return;
    } catch (error) {
      if (attempt === 3 || !String(error).includes('ERR_NETWORK_CHANGED')) throw error;
      await page.waitForTimeout(500 * attempt);
    }
  }
}
