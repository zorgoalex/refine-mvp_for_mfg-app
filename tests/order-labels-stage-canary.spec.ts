import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.ORDER_LABELS_STAGE_CANARY === 'true';
const frontendUrl = trimTrailingSlash(
  process.env.ORDER_LABELS_STAGE_FRONTEND_URL ??
    process.env.FRONTEND_STAGE_URL ??
    'https://app-test.mebelkz.app',
);
const backendApiUrl = trimTrailingSlash(
  process.env.ORDER_LABELS_STAGE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer = process.env.ORDER_LABELS_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const targetEnv = process.env.ORDER_LABELS_STAGE_TARGET_ENV ?? 'backend-test';
const orderId = Number(process.env.ORDER_LABELS_STAGE_ORDER_ID ?? '11393');
const expectedLabelCount = Number(process.env.ORDER_LABELS_STAGE_LABEL_COUNT ?? '22');
const vercelAutomationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

test.describe('Order labels stage canary', () => {
  test.skip(!canaryEnabled, 'Run with ORDER_LABELS_STAGE_CANARY=true');
  test.skip(
    canaryEnabled && !dockerContainerExists(postgresContainer),
    `Stage postgres container ${postgresContainer} is required for order labels stage canary.`,
  );
  test.setTimeout(180000);

  let userId: number | null = null;

  test.afterEach(() => {
    cleanupUser(userId);
    userId = null;
  });

  test('real stage shows all latest label pages, syncs detail-row preview, and invokes print', async ({
    page,
    request,
  }) => {
    assertBackendTestOnly();
    const diagnostics: string[] = [];
    page.on('console', (message) => diagnostics.push(`console:${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`));
    page.on('requestfailed', (requestFailure) =>
      diagnostics.push(
        `requestfailed:${requestFailure.method()} ${requestFailure.url()} ${requestFailure.failure()?.errorText ?? ''}`,
      ),
    );

    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_order_labels_${runId}_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');

    await expectRuntimeConfig(request);
    userId = createSmokeUser(username, password);
    const accessToken = await loginForApiToken(request, username, password);
    const latest = await getJson<LatestOrderLabelsPreview>(
      request,
      `/orders/${orderId}/labels/latest`,
      accessToken,
    );

    expect(latest.orderId).toBe(orderId);
    expect(latest.labelCount).toBe(expectedLabelCount);
    expect(latest.svgPages).toHaveLength(expectedLabelCount);
    expect(latest.rows).toHaveLength(expectedLabelCount);
    expect(latest.svgPages[0]).toContain(`Бир. № 1 / ${expectedLabelCount}`);
    expect(latest.svgPages.at(-1)).toContain(`Бир. № ${expectedLabelCount} / ${expectedLabelCount}`);
    expect(latest.svgPages[0]).not.toEqual(latest.svgPages.at(-1));

    const labelData = await getJson<OrderLabelData>(
      request,
      `/orders/${orderId}/label-data?templateId=${latest.templateId}`,
      accessToken,
    );
    const targetDetail = chooseTargetDetailForPreviewSync(latest.rows, labelData.details);

    await installIframePrintProbe(page);
    if (vercelAutomationBypassSecret) {
      await page.context().setExtraHTTPHeaders({
        'x-vercel-protection-bypass': vercelAutomationBypassSecret,
      });
    }

    await loginThroughUi(page, username, password);
    await page.goto(`${frontendUrl}/orders/edit/${orderId}?tab=additional`, {
      waitUntil: 'domcontentloaded',
    });

    const viewer = page.locator('.order-label-pages-viewer-wrap').first();
    await expect(viewer.getByText(`Последняя генерация: ${expectedLabelCount} шт.`)).toBeVisible({
      timeout: 30000,
    });

    const listPanel = viewer.locator('.order-label-pages-viewer__list-panel');
    await expect(listPanel.getByText('Список бирок')).toBeVisible();
    await expect(listPanel.getByText(`${expectedLabelCount} шт.`)).toBeVisible();
    await expect(viewer.locator('.order-label-pages-viewer__list-button')).toHaveCount(expectedLabelCount);

    await expect(viewer.getByText(`Бирка 1 из ${expectedLabelCount}`)).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Предыдущая' })).toBeDisabled();
    await expect(viewer.getByRole('button', { name: 'Следующая' })).toBeEnabled();
    const firstPreviewHtml = await previewHtml(viewer);
    expect(firstPreviewHtml).toContain(`Бир. № 1 / ${expectedLabelCount}`);

    await viewer.getByRole('button', { name: 'Следующая' }).click();
    await expect(viewer.getByText(`Бирка 2 из ${expectedLabelCount}`)).toBeVisible();
    const secondPreviewHtml = await previewHtml(viewer);
    expect(secondPreviewHtml).toContain(`Бир. № 2 / ${expectedLabelCount}`);
    expect(secondPreviewHtml).not.toEqual(firstPreviewHtml);

    await viewer
      .locator('.order-label-pages-viewer__list-button')
      .filter({ hasText: `Бирка ${expectedLabelCount}` })
      .click();
    await expect(viewer.getByText(`Бирка ${expectedLabelCount} из ${expectedLabelCount}`)).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Следующая' })).toBeDisabled();
    await expect(viewer.getByRole('button', { name: 'Предыдущая' })).toBeEnabled();
    const lastPreviewHtml = await previewHtml(viewer);
    expect(lastPreviewHtml).toContain(`Бир. № ${expectedLabelCount} / ${expectedLabelCount}`);
    expect(lastPreviewHtml).not.toEqual(firstPreviewHtml);

    await viewer.getByRole('button', { name: 'Предыдущая' }).click();
    await expect(viewer.getByText(`Бирка ${expectedLabelCount - 1} из ${expectedLabelCount}`)).toBeVisible();

    const detailsTable = page.locator('.ant-table').filter({ hasText: 'Комментарий бирки' }).last();
    const detailRows = detailsTable.locator('.ant-table-tbody > tr');
    await expect(detailRows).toHaveCount(labelData.details.length);
    const targetRow = detailRows.nth(targetDetail.detailIndex);
    await targetRow.scrollIntoViewIfNeeded();
    await targetRow.click();

    await expect(
      page.getByText(`Выбрана для предпросмотра: Позиция ${targetDetail.displayPosition}: ${targetDetail.displayName}`),
    ).toBeVisible();
    await expect(viewer.getByText(`Бирка ${targetDetail.firstLabelPage} из ${expectedLabelCount}`)).toBeVisible();
    const detailPreviewHtml = await previewHtml(viewer);
    expect(detailPreviewHtml).toContain(`Бир. № ${targetDetail.firstLabelPage} / ${expectedLabelCount}`);
    expect(detailPreviewHtml).toContain(targetDetail.svgMarker);
    expect(detailPreviewHtml).not.toEqual(firstPreviewHtml);

    if (targetDetail.firstLabelPage < expectedLabelCount) {
      await viewer.getByRole('button', { name: 'Следующая' }).click();
      await expect(viewer.getByText(`Бирка ${targetDetail.firstLabelPage + 1} из ${expectedLabelCount}`)).toBeVisible();
      const nextDetailPreviewHtml = await previewHtml(viewer);
      expect(nextDetailPreviewHtml).toContain(`Бир. № ${targetDetail.firstLabelPage + 1} / ${expectedLabelCount}`);
      expect(nextDetailPreviewHtml).not.toEqual(detailPreviewHtml);
    }

    await viewer.getByRole('button', { name: 'Печать' }).click();
    const printIframe = page.locator('iframe[title*="последняя генерация бирок"]');
    await expect(printIframe).toHaveCount(1);
    await expect
      .poll(() =>
        printIframe.evaluate((iframe) =>
          (iframe as HTMLIFrameElement).contentDocument?.querySelectorAll('.label-print-page').length ?? 0,
        ),
      )
      .toBe(expectedLabelCount);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __labelPrintCalled?: boolean }).__labelPrintCalled))
      .toBe(true);
  });
});

async function expectRuntimeConfig(request: APIRequestContext) {
  const response = await request.get(`${frontendUrl}/runtime-config.json`, {
    headers: frontendRequestHeaders(),
  });
  await expectOk(response);
  const runtimeConfig = await response.json();
  expect(runtimeConfig.apiUrl).toBe('https://backend-test.mebelkz.app');
  expect(runtimeConfig.features?.backendAuth).toBe(true);
  expect(runtimeConfig.features?.labels).toBe(true);
}

function frontendRequestHeaders(): Record<string, string> {
  if (!vercelAutomationBypassSecret) return {};
  return { 'x-vercel-protection-bypass': vercelAutomationBypassSecret };
}

async function loginThroughUi(page: Page, username: string, password: string) {
  await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded' });
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/auth/login') &&
      response.request().method() === 'POST',
  );
  await page.locator('input[autocomplete="username"], input#username').fill(username);
  await page.locator('input[autocomplete="current-password"], input#password').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const loginResponse = await loginResponsePromise;
  await expectOk(loginResponse);
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30000 });
}

async function loginForApiToken(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<string> {
  const response = await request.post(`${backendApiUrl}/auth/login`, {
    data: { username, password },
  });
  await expectOk(response);
  const body = await response.json();
  expect(typeof body.accessToken).toBe('string');
  return body.accessToken;
}

async function getJson<T>(request: APIRequestContext, path: string, token: string): Promise<T> {
  const response = await request.get(`${backendApiUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expectOk(response);
  return response.json() as Promise<T>;
}

async function expectOk(response: APIResponse) {
  const body = response.ok() ? '' : await response.text();
  expect(response.ok(), body).toBe(true);
}

async function previewHtml(viewer: ReturnType<Page['locator']>): Promise<string> {
  await expect(viewer.locator('.label-svg-preview-frame__content svg')).toBeVisible();
  return viewer.locator('.label-svg-preview-frame__content').innerHTML();
}

function chooseTargetDetailForPreviewSync(
  rows: LabelPreviewRow[],
  details: OrderLabelDetailData[],
): PreviewSyncTarget {
  const firstPageByDetailId = new Map<number, number>();
  const rowByFirstPage = new Map<number, LabelPreviewRow>();
  for (const row of rows) {
    const detailId = Number(row.detailId ?? row.values?.['detail.detail_id'] ?? row.values?.['bazis.detail_id']);
    const rowIndex = Number(row.rowIndex ?? row.values?.['label.counter']);
    if (!Number.isFinite(detailId) || !Number.isFinite(rowIndex)) continue;
    if (!firstPageByDetailId.has(detailId)) {
      firstPageByDetailId.set(detailId, rowIndex);
      rowByFirstPage.set(detailId, row);
    }
  }

  const preferred = details
    .map((detail, detailIndex) => {
      const firstLabelPage = firstPageByDetailId.get(detail.detailId);
      const firstRow = rowByFirstPage.get(detail.detailId);
      return { detail, detailIndex, firstLabelPage, firstRow };
    })
    .filter(
      (
        entry,
      ): entry is {
        detail: OrderLabelDetailData;
        detailIndex: number;
        firstLabelPage: number;
        firstRow: LabelPreviewRow;
      } =>
        Number.isFinite(entry.firstLabelPage) &&
        entry.firstLabelPage > 1 &&
        Boolean(entry.detail.detailName),
    )
    .sort((left, right) => {
      const leftScore = left.detail.detailName === 'Фасад ящика' ? 0 : 1;
      const rightScore = right.detail.detailName === 'Фасад ящика' ? 0 : 1;
      return leftScore - rightScore || left.firstLabelPage - right.firstLabelPage;
    })[0];

  if (!preferred) {
    throw new Error('No non-first label detail found for preview sync canary.');
  }

  return {
    detailIndex: preferred.detailIndex,
    detailId: preferred.detail.detailId,
    displayName: preferred.detail.detailName ?? '—',
    displayPosition: readDisplayPosition(preferred.detail),
    firstLabelPage: preferred.firstLabelPage,
    svgMarker: String(
      preferred.firstRow.values?.['detail.detail_name'] ??
        preferred.firstRow.values?.['bazis.name'] ??
        preferred.detail.detailName,
    ),
  };
}

function readDisplayPosition(detail: OrderLabelDetailData): string {
  const raw = typeof detail.basisData === 'string' ? detail.basisData.trim().replace(/\s+/g, ' ') : '';
  const withPosition = /^(?<position>\d+(?:[.,]\d+)?|[A-Za-zА-Яа-я]\d+(?:[.-]\d+)?)\s+(.+)$/.exec(raw);
  return withPosition?.groups?.position ?? String(detail.detailNumber ?? detail.detailId);
}

function createSmokeUser(username: string, password: string): number {
  const email = `${username}@example.invalid`;
  const passwordHash = bcrypt.hashSync(password, 10);

  return Number(
    psql(`
      WITH inserted AS (
        INSERT INTO users (username, email, password_hash, role_id, full_name, is_active, login_policy)
        VALUES (
          '${sqlQuote(username)}',
          '${sqlQuote(email)}',
          '${sqlQuote(passwordHash)}',
          1,
          'E2E Test Order Labels Stage Canary',
          true,
          'local'
        )
        RETURNING user_id
      )
      SELECT user_id FROM inserted;
    `),
  );
}

function cleanupUser(id: number | null) {
  if (!id) return;

  psql(`
    DELETE FROM refresh_tokens WHERE user_id = ${id};
    DELETE FROM auth_sessions WHERE user_id = ${id};
    DELETE FROM users
    WHERE user_id = ${id}
      AND username LIKE 'e2e_test_order_labels_%';
  `);
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      postgresContainer,
      'psql',
      '-U',
      'erp_user',
      '-d',
      'erpdb',
      '-qAtX',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
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

function assertBackendTestOnly() {
  if (targetEnv !== 'backend-test') {
    throw new Error('ORDER_LABELS_STAGE_TARGET_ENV=backend-test is required.');
  }
  expect(new URL(frontendUrl).hostname).toBe('app-test.mebelkz.app');
  expect(new URL(backendApiUrl).hostname).toBe('backend-test.mebelkz.app');
  expect(orderId).toBe(11393);
}

async function installIframePrintProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __labelPrintCalled?: boolean }).__labelPrintCalled = false;
    const originalAppendChild = Element.prototype.appendChild;
    Element.prototype.appendChild = function patchedAppendChild<T extends Node>(child: T): T {
      const result = originalAppendChild.call(this, child) as T;
      if (child instanceof HTMLIFrameElement) {
        const install = () => {
          if (child.contentWindow) {
            child.contentWindow.print = () => {
              (window as unknown as { __labelPrintCalled?: boolean }).__labelPrintCalled = true;
            };
          }
        };
        install();
        window.setTimeout(install, 0);
      }
      return result;
    };
  });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

interface LatestOrderLabelsPreview {
  generationId: number;
  orderId: number;
  templateId: number;
  labelCount: number;
  rows: LabelPreviewRow[];
  svgPages: string[];
}

interface LabelPreviewRow {
  detailId?: number;
  rowIndex?: number;
  values?: Record<string, unknown>;
}

interface OrderLabelData {
  details: OrderLabelDetailData[];
}

interface OrderLabelDetailData {
  detailId: number;
  detailNumber?: number | string | null;
  detailName?: string | null;
  basisData?: string | null;
}

interface PreviewSyncTarget {
  detailIndex: number;
  detailId: number;
  displayName: string;
  displayPosition: string;
  firstLabelPage: number;
  svgMarker: string;
}
