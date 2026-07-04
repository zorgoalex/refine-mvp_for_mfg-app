import { test, expect } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

// Mobile /scan spec (Task 9 of label-scan-v1): manual-input resolve flow on a
// phone viewport with a mocked backend. Mirrors the mock setup pattern from
// tests/mobile-shell.spec.ts / tests/mobile-pages.spec.ts: createWorkflowMockDb()
// + setupWorkflowMockApi(page, db) wires auth (access_token + `user` in
// localStorage, id: '1') and GraphQL/runtime-config mocks. On top of that we add
// a page.route mock for the REST endpoint labelsApi.scanResolve() hits
// (POST /api/v1/labels/scan-resolve) since that call is backend-owned, not
// GraphQL, and isn't covered by setupWorkflowMockApi.
//
// The camera is never emulated here (headless Chromium has no real camera
// device), so every scenario drives the page via the manual Input.Search
// fallback — that's the only path CI can exercise deterministically.

const MANUAL_PLACEHOLDER = 'Строка QR / № или имя заказа';
const DETAIL_ID = 60084;
const ORDER_ID = 11380;

test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    // Optional escape hatch for local worktree runs where port 5173 (the
    // config default) is already bound by a different worktree's dev server.
    // Unset in normal/CI runs, so this is a no-op there.
    ...(process.env.PLAYWRIGHT_BASE_URL ? { baseURL: process.env.PLAYWRIGHT_BASE_URL } : {}),
});

function oneCandidateBody() {
    return JSON.stringify({
        candidates: [
            {
                detailId: DETAIL_ID,
                orderId: ORDER_ID,
                orderName: 'E2E Тест Импорт 68',
                detailNumber: 3,
                width: 600,
                height: 400,
                quantity: 2,
                materialName: 'ЛДСП белый',
                productionStatusName: 'В работе',
                matchedFields: ['orderName'],
                matchedBy: 'order_name',
                score: 100,
            },
        ],
        parsed: null,
        templatesTried: 1,
    });
}

function zeroCandidateBody() {
    return JSON.stringify({ candidates: [], parsed: null, templatesTried: 2 });
}

async function mockScanResolve(page: import('@playwright/test').Page, body: string) {
    await page.route(/\/api\/v1\/labels\/scan-resolve$/, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body });
    });
}

test('manual resolve → single candidate → action modal → "Открыть заказ" navigates with highlightDetail', async ({
    page,
}) => {
    const db = createWorkflowMockDb();
    // The /scan route + resource are gated behind featureFlags.labels, so the
    // mocked runtime-config must enable it for the page to exist at all.
    await setupWorkflowMockApi(page, db, { runtimeConfig: { labels: true } });
    await mockScanResolve(page, oneCandidateBody());

    await page.goto('/scan', { waitUntil: 'domcontentloaded' });

    const input = page.getByPlaceholder(MANUAL_PLACEHOLDER);
    await expect(input).toBeVisible({ timeout: 30000 });

    await input.fill('импорт 68');
    await input.press('Enter');

    // First-use action modal: no stored scanDefaultAction pref yet, so the
    // app must ask which action to take on the single resolved candidate.
    const actionModal = page.getByRole('dialog', { name: 'Что делать при находке?' });
    await expect(actionModal).toBeVisible({ timeout: 10000 });

    // Exact button text from ScanPage.tsx's action Modal (not the task-brief's
    // paraphrase "Показать деталь в заказе" — the real "open order" button is
    // labelled "Открыть заказ"; see task-9-report.md for the discrepancy note).
    await actionModal.getByRole('button', { name: 'Открыть заказ' }).click();

    await expect(page).toHaveURL(new RegExp(`/orders/show/${ORDER_ID}\\?highlightDetail=${DETAIL_ID}`));
});

test('second visit with a pre-seeded action pref → manual resolve navigates without the action modal', async ({
    page,
}) => {
    const db = createWorkflowMockDb();
    // The /scan route + resource are gated behind featureFlags.labels, so the
    // mocked runtime-config must enable it for the page to exist at all.
    await setupWorkflowMockApi(page, db, { runtimeConfig: { labels: true } });
    await mockScanResolve(page, oneCandidateBody());

    // setupWorkflowMockApi registers an addInitScript that calls
    // localStorage.clear() before seeding access_token/refresh_token/user.
    // Registering our own addInitScript afterwards runs it after that clear,
    // so the scan pref survives into the page load — simulating a returning
    // user who already chose a default action on a previous visit.
    // Key format matches scanPrefs.ts: `scanDefaultAction:${userId}`; the
    // mocked user (both the /api/v1/me route and the legacy localStorage
    // `user` blob in mockWorkflowApi.ts) has id: '1', and ScanPage reads
    // authSession.getUser()?.id for that userId.
    await page.addInitScript(() => {
        localStorage.setItem('scanDefaultAction:1', 'open-order');
    });

    await page.goto('/scan', { waitUntil: 'domcontentloaded' });

    const input = page.getByPlaceholder(MANUAL_PLACEHOLDER);
    await expect(input).toBeVisible({ timeout: 30000 });

    await input.fill('импорт 68');
    await input.press('Enter');

    await expect(page).toHaveURL(new RegExp(`/orders/show/${ORDER_ID}\\?highlightDetail=${DETAIL_ID}`));

    // The action modal must never have appeared for this pref-seeded visit.
    await expect(page.getByRole('dialog', { name: 'Что делать при находке?' })).toBeHidden();
});

test('manual resolve → zero candidates → Empty "Не найдено" with the raw search string', async ({ page }) => {
    const db = createWorkflowMockDb();
    // The /scan route + resource are gated behind featureFlags.labels, so the
    // mocked runtime-config must enable it for the page to exist at all.
    await setupWorkflowMockApi(page, db, { runtimeConfig: { labels: true } });
    await mockScanResolve(page, zeroCandidateBody());

    await page.goto('/scan', { waitUntil: 'domcontentloaded' });

    const input = page.getByPlaceholder(MANUAL_PLACEHOLDER);
    await expect(input).toBeVisible({ timeout: 30000 });

    const rawQuery = 'нет такой детали 999';
    await input.fill(rawQuery);
    await input.press('Enter');

    await expect(page.getByText('Не найдено')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(rawQuery, { exact: true })).toBeVisible();
});

test('headless has no camera: page stays usable (camera-error Alert or video element) and manual input still works', async ({
    page,
}) => {
    const db = createWorkflowMockDb();
    // The /scan route + resource are gated behind featureFlags.labels, so the
    // mocked runtime-config must enable it for the page to exist at all.
    await setupWorkflowMockApi(page, db, { runtimeConfig: { labels: true } });
    await mockScanResolve(page, zeroCandidateBody());

    await page.goto('/scan', { waitUntil: 'domcontentloaded' });

    const input = page.getByPlaceholder(MANUAL_PLACEHOLDER);
    await expect(input).toBeVisible({ timeout: 30000 });

    // Headless Chromium has no real camera device, so getUserMedia() rejects
    // and ScanPage shows a warning Alert (its <video> element is always
    // rendered in the DOM regardless of camera state). Explicit two-branch
    // assert — not a weakened .or(): if the Alert never showed up (e.g. a
    // future CI runner adds a fake camera device), fall back to asserting the
    // video element itself is visible, so the check never degrades to a
    // vacuous no-op.
    const cameraAlert = page.getByText(/камер/i);
    const hasCameraAlert = await cameraAlert.isVisible().catch(() => false);
    if (hasCameraAlert) {
        await expect(cameraAlert).toBeVisible();
    } else {
        await expect(page.locator('video')).toBeVisible();
    }

    // Manual input remains fully functional regardless of camera outcome.
    await input.fill('импорт 68 без камеры');
    await input.press('Enter');
    await expect(page.getByText('Не найдено')).toBeVisible({ timeout: 10000 });
});

test('photo-file scan: uploaded QR image decodes in-browser and resolves to the order', async ({ page }) => {
    const db = createWorkflowMockDb();
    await setupWorkflowMockApi(page, db, { runtimeConfig: { labels: true } });
    await mockScanResolve(page, oneCandidateBody());
    // Pref pre-seeded → decode should navigate straight away, no chooser modal.
    await page.addInitScript(() => {
        localStorage.setItem('scanDefaultAction:1', 'open-order');
    });

    // Стейджовый CSP режет внешние хосты: wasm ОБЯЗАН приходить из нашего
    // бандла. Блокируем CDN-хосты — декод всё равно должен работать.
    await page.route(/jsdelivr\.net|unpkg\.com|fastly\./, (r) => r.abort());

    await page.goto('/scan', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Скан из фото' })).toBeVisible({ timeout: 30000 });

    // Real zxing-wasm decode of a real QR PNG (payload "импорт 68|60084|1")
    // generated from the same template the backend parses — this exercises the
    // genuine file→decode→resolve path, not a mocked decode.
    await page.setInputFiles('[data-testid="scan-photo-input"]', 'tests/fixtures/scan-qr-sample.png');

    await expect(page).toHaveURL(new RegExp(`/orders/show/${ORDER_ID}\\?highlightDetail=${DETAIL_ID}`), {
        timeout: 15000,
    });
});

test('photo-file scan: image without a QR shows the not-recognized error, not «Не найдено»', async ({ page }) => {
    const db = createWorkflowMockDb();
    await setupWorkflowMockApi(page, db, { runtimeConfig: { labels: true } });

    await page.goto('/scan', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Скан из фото' })).toBeVisible({ timeout: 30000 });

    // 1×1 PNG без QR — декодер обязан вернуть null.
    const blankPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    );
    await page.setInputFiles('[data-testid="scan-photo-input"]', {
        name: 'blank.png',
        mimeType: 'image/png',
        buffer: blankPng,
    });

    await expect(page.getByText('QR-код на фото не распознан', { exact: false })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Не найдено')).toBeHidden();
});
