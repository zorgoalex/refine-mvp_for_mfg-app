import { expect, test } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

/**
 * Mocked-local Playwright coverage for the manual-layout editor on /cut.
 * No live backend: all /api/v1/cut-jobs endpoints are fulfilled by mocks.
 * Pattern: mirrors cut-frontend.spec.ts (setupWorkflowMockApi + page.route overrides).
 *
 * Scenarios:
 *   S1  – open editor (Редактировать раскрой → SheetEditor visible)
 *   S2  – drag piece + save (PATCH body shape, editor closes, show-alternative cb appears)
 *   S3a – rotate unlocked piece via R key (piece rect dimensions swap)
 *   S3b – rotate grain-locked piece → blocked + warning message
 *   S4  – drag to overlap → violation + Save disabled
 *   S5  – dirty print-lock (editor active → PDF disabled; cancel → re-enabled)
 *   S6  – requiresRecalc=true → "устарел" tag + editor + PDF disabled
 *   S7  – re-save bumps renderToken → preview re-fetch carries renderVersion=t2
 *   S8  – variant toggle → preview re-fetch carries variant=manual
 *
 * Skipped (with reason comments):
 *   cross-sheet drag – requires two SVGs rendered with >700px each; not reliable headless
 */

const JOB_ID = 42;
const GROUP_ID = 100;

const CUT_PERMISSIONS = [
  'orders.view',
  'payments.view',
  'settings.view',
  'cut.view',
  'cut.manage',
];

// 1×1 transparent PNG for every render endpoint (so previews don't 404).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ── Fixture builder ──────────────────────────────────────────────────────────

function makeReadyJob(overrides: Record<string, unknown> = {}) {
  return {
    cutJobId: JOB_ID,
    name: 'E2E-Тест ручной раскрой',
    status: 'ready',
    source: 'manual',
    version: 1,
    pdfPrewarmState: 'done',
    requiresRecalc: false,
    renderToken: 't1',
    editorParams: { kerfMm: 2, spacingMm: 1 },
    paramProfileId: null,
    sheetMaterialTypeId: null,
    combineFilms: false,
    splitByMaterial: true,
    totals: { positions: 3, details: 3, area: 1.5, sheets: 2, materialsCount: 1, filmsCount: 2 },
    // item_id format: "det-<orderDetailId>" (parseCutPieceDetailId expects /^det-(\d+)$/)
    items: [
      {
        cutJobItemId: 1,
        orderDetailId: 1,
        orderId: 9,
        qty: 1,
        cutGroupId: GROUP_ID,
        detail: {
          detailNumber: 1,
          detailName: 'Деталь А',
          height: 300,
          width: 200,
          quantity: 1,
          area: 0.6,
          materialId: null,
          sheetMaterialTypeId: 1,
          materialName: null,
          millingTypeId: null,
          millingTypeName: null,
          edgeTypeId: null,
          edgeTypeName: null,
          filmId: 1,
          filmName: 'Белая матовая',
          filmTexture: false, // grain-UNLOCKED
          priority: 100,
          productionStatusId: 1,
          productionStatusName: 'В работе',
          jointOrderId: null,
          note: null,
          linkCuttingFile: null,
          linkCuttingImageFile: null,
          linkCadFile: null,
          linkPdfFile: null,
        },
      },
      {
        cutJobItemId: 2,
        orderDetailId: 2,
        orderId: 9,
        qty: 1,
        cutGroupId: GROUP_ID,
        detail: {
          detailNumber: 2,
          detailName: 'Деталь Б',
          height: 300,
          width: 200,
          quantity: 1,
          area: 0.6,
          materialId: null,
          sheetMaterialTypeId: 1,
          materialName: null,
          millingTypeId: null,
          millingTypeName: null,
          edgeTypeId: null,
          edgeTypeName: null,
          filmId: 1,
          filmName: 'Белая матовая',
          filmTexture: false, // grain-UNLOCKED
          priority: 100,
          productionStatusId: 1,
          productionStatusName: 'В работе',
          jointOrderId: null,
          note: null,
          linkCuttingFile: null,
          linkCuttingImageFile: null,
          linkCadFile: null,
          linkPdfFile: null,
        },
      },
      {
        cutJobItemId: 3,
        orderDetailId: 3,
        orderId: 9,
        qty: 1,
        cutGroupId: GROUP_ID,
        detail: {
          detailNumber: 3,
          detailName: 'Деталь В (текстура)',
          height: 150,
          width: 200,
          quantity: 1,
          area: 0.3,
          materialId: null,
          sheetMaterialTypeId: 1,
          materialName: null,
          millingTypeId: null,
          millingTypeName: null,
          edgeTypeId: null,
          edgeTypeName: null,
          filmId: 2,
          filmName: 'Текстурная плёнка',
          filmTexture: true, // grain-LOCKED (rotation blocked)
          priority: 100,
          productionStatusId: 1,
          productionStatusName: 'В работе',
          jointOrderId: null,
          note: null,
          linkCuttingFile: null,
          linkCuttingImageFile: null,
          linkCadFile: null,
          linkPdfFile: null,
        },
      },
    ],
    groups: [
      {
        cutGroupId: GROUP_ID,
        sheetMaterialTypeId: 1,
        filmId: null,
        status: 'ready',
        summary: { used_stock_count: 2, waste_percent: 15 },
        manualLayout: null,
        renderToken: 't1',
        sheets: [
          {
            cutGroupSheetId: 1,
            sheetIndex: 0,
            pngCacheKey: null,
            placements: {
              trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
              sheet_width_mm: 2800,
              sheet_height_mm: 2070,
              // Piece A (det-1): usable (0,0,200,300) – unlocked
              // Piece B (det-2): usable (300,0,200,300) – unlocked; gap A↔B = 100mm > kerf+spacing=3mm
              pieces: [
                {
                  item_id: 'det-1',
                  instance: 0,
                  x_mm: 0,
                  y_mm: 0,
                  width_mm: 200,
                  height_mm: 300,
                  rotated: false,
                  label: { orderId: 9, detailNumber: 1, widthMm: 200, heightMm: 300 },
                },
                {
                  item_id: 'det-2',
                  instance: 0,
                  x_mm: 300,
                  y_mm: 0,
                  width_mm: 200,
                  height_mm: 300,
                  rotated: false,
                  label: { orderId: 9, detailNumber: 2, widthMm: 200, heightMm: 300 },
                },
              ],
            },
          },
          {
            cutGroupSheetId: 2,
            sheetIndex: 1,
            pngCacheKey: null,
            placements: {
              trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
              sheet_width_mm: 2800,
              sheet_height_mm: 2070,
              // Piece C (det-3): usable (0,0,200,150) – grain-LOCKED
              pieces: [
                {
                  item_id: 'det-3',
                  instance: 0,
                  x_mm: 0,
                  y_mm: 0,
                  width_mm: 200,
                  height_mm: 150,
                  rotated: false,
                  label: { orderId: 9, detailNumber: 3, widthMm: 200, heightMm: 150 },
                },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ── Shared mock setup ────────────────────────────────────────────────────────

async function setupMocks(
  page: import('@playwright/test').Page,
  jobOverrides: Record<string, unknown> = {},
) {
  const identity = {
    id: '1',
    userId: 1,
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: CUT_PERMISSIONS,
  };
  const job = makeReadyJob(jobOverrides);

  await setupWorkflowMockApi(page, undefined, {
    runtimeConfig: { backendCut: true, backendAuth: true, backendPermissions: true },
  });

  // Override /me and /auth/refresh to include cut.* permissions (registered after
  // setupWorkflowMockApi so Playwright's LIFO route ordering makes this win).
  await page.route(/\/api\/v1\/me$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: identity }),
    }),
  );
  await page.route(/\/api\/v1\/auth\/refresh$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: 'mock',
        accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
        user: identity,
      }),
    }),
  );

  // Sheet-types filter (Variant B Task 11): empty list → no filter shown (harmless).
  await page.route(/\/api\/v1\/cut-jobs\/sheet-types(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  // Cut config: minimal – screen preset + empty profiles.
  await page.route(/\/api\/v1\/cut-config$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        renderPresets: [{ name: 'screen', isActive: true }],
        paramProfiles: [],
        pdfTemplates: [
          { cutPdfTemplateId: 1, code: 'standard', name: 'Стандартный лист', isActive: true, version: 1 },
          { cutPdfTemplateId: 2, code: 'bath_vacuum', name: 'Ванна: вакуумный стол', isActive: true, version: 1 },
        ],
        settings: [],
      }),
    }),
  );

  // Single-job GET (opened via the table "Открыть" or deep-link).
  await page.route(/\/api\/v1\/cut-jobs\/42$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(job),
    }),
  );

  // Job list GET + POST (create).
  await page.route(/\/api\/v1\/cut-jobs$/, (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(job),
      });
    }
    // GET list: return the single test job.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([job]),
    });
  });

  // Render endpoints: 1×1 PNG / SVG stub so previews never 404.
  await page.route(
    /\/api\/v1\/cut-jobs\/42\/groups\/100\/sheets\/\d+\.png(\?.*)?$/,
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES }),
  );
  await page.route(
    /\/api\/v1\/cut-jobs\/42\/groups\/100\/sheets\/\d+\.svg(\?.*)?$/,
    (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg/>' }),
  );
  await page.route(
    /\/api\/v1\/cut-jobs\/42\/groups\/100\/export\.pdf(\?.*)?$/,
    (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PNG_BYTES }),
  );
  await page.route(
    /\/api\/v1\/cut-jobs\/42\/export\.pdf(\?.*)?$/,
    (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PNG_BYTES }),
  );

  return { job, identity };
}

// ── Helper: open job via the jobs table ─────────────────────────────────────

async function openJob(page: import('@playwright/test').Page) {
  await page.goto('/cut');
  // Wait for the test job to appear in the list (auth + loadJobs must complete).
  // Timeout is intentionally generous (45s): the first test in a cold Vite run can
  // take 20-25s to serve the compiled bundle; subsequent tests benefit from Vite's
  // module cache and complete in < 6s.
  await expect(page.getByText('E2E-Тест ручной раскрой')).toBeVisible({ timeout: 45000 });
  // Click the first "Открыть" button (only one job in the mocked list).
  await page.getByRole('button', { name: 'Открыть' }).first().click();
  // Confirm job details card appeared.
  await expect(page.getByText(`Раскрой #${JOB_ID}`)).toBeVisible({ timeout: 10000 });
}

// ── Helper: enter editor mode for group 100 ─────────────────────────────────

async function enterEditor(page: import('@playwright/test').Page) {
  await page.getByTestId(`edit-layout-btn-${GROUP_ID}`).click();
  await expect(page.getByTestId('sheet-editor')).toBeVisible({ timeout: 8000 });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Cut manual layout editor (mocked-local)', () => {
  // ── S1: open editor ────────────────────────────────────────────────────────
  test('S1: Редактировать раскрой → SheetEditor visible', async ({ page }) => {
    // Extend timeout: S1 always runs first and triggers a cold Vite bundle compile
    // (20-25s). Subsequent tests reuse the compiled cache and run in ~6s.
    test.setTimeout(90000);
    await setupMocks(page);
    await openJob(page);
    await enterEditor(page);

    // Both sheets should render (sheet 0 and sheet 1).
    await expect(page.getByTestId('sheet-editor-sheet-0')).toBeVisible();
    await expect(page.getByTestId('sheet-editor-sheet-1')).toBeVisible();

    // Piece rects should be present in sheet 0 (two pieces).
    await expect(page.getByTestId('piece-rect-0-det-1-0')).toBeVisible();
    await expect(page.getByTestId('piece-rect-0-det-2-0')).toBeVisible();

    // «Сохранить изменения» starts enabled (no violations on a fresh seed).
    await expect(page.getByTestId('save-manual-layout-btn')).toBeEnabled();
  });

  // ── S2: drag piece + save → PATCH body shape + editor closes + checkbox ───
  test('S2: drag piece → save → PATCH placements format + editor closes + show-alternative checkbox', async ({
    page,
  }) => {
    const { job } = await setupMocks(page);

    // Set up PATCH mock: return updated job with active manualLayout.
    // Updated job has version=2, renderToken='t2', manualLayout non-null.
    const updatedGroup = {
      ...job.groups[0],
      renderToken: 't2',
      manualLayout: {
        groupKey: `g${GROUP_ID}`,
        sheets: job.groups[0].sheets,
        isActive: false,
        isStale: false,
        version: 1,
      },
    };
    const updatedJob = { ...job, version: 2, renderToken: 't2', groups: [updatedGroup] };

    await page.route(/\/api\/v1\/cut-jobs\/42\/groups\/100\/manual-layout$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(updatedJob),
      }),
    );

    await openJob(page);
    await enterEditor(page);

    // Save should be enabled immediately (no violations in fresh seed).
    await expect(page.getByTestId('save-manual-layout-btn')).toBeEnabled();

    // ── Drag piece A (det-1 on sheet 0) ~50mm to the right ──────────────────
    // Sheet 0 SVG: viewBox "0 0 2800 2070", displayed at 700×517px (portrait).
    // Scale = 700 / 2800 = 0.25.
    // Piece A usable pos: x=0, y=0, w=200mm, h=300mm.
    //   Centre in SVG mm: (trim.left + x_mm + w/2, trim.top + y_mm + h/2) = (10+0+100, 10+0+150) = (110, 160).
    // Moving A to usable x=50mm → new SVG centre x = 10+50+100 = 160mm.
    // Gap A→B after move: B.x(300) − (A.x(50) + A.w(200)) = 50mm > gap(3mm) → no violation.
    // Snap candidates for A.x=50mm: nearest is A.x=0 at dist=50 > threshold(10) → no snap.
    const svgLocator = page.locator('[data-testid="sheet-editor-sheet-0"] svg').first();
    await expect(svgLocator).toBeVisible();
    const svgBox = await svgLocator.boundingBox();
    expect(svgBox).not.toBeNull();

    const scale = svgBox!.width / 2800;
    const aCenterX = svgBox!.x + 110 * scale; // piece A centre in viewport
    const aCenterY = svgBox!.y + 160 * scale;
    const deltaX = 50 * scale; // 50mm → pixels

    await page.mouse.move(aCenterX, aCenterY);
    await page.mouse.down();
    // Move in steps so the pointermove event fires and drag state updates.
    await page.mouse.move(aCenterX + deltaX, aCenterY, { steps: 8 });
    await page.mouse.up();

    // After the drag, React re-validates: no violations → Save stays enabled.
    await expect(page.getByTestId('save-manual-layout-btn')).toBeEnabled();

    // ── Save ─────────────────────────────────────────────────────────────────
    const [patchRequest] = await Promise.all([
      page.waitForRequest(/\/api\/v1\/cut-jobs\/42\/groups\/100\/manual-layout/),
      page.getByTestId('save-manual-layout-btn').click(),
    ]);

    // Verify PATCH body: must have { jobVersion, active, placements[] }.
    // placements[] items have itemId/instance/sheetIndex/xMm/yMm/rotated — NO width/height.
    const body = JSON.parse(patchRequest.postData() ?? '{}');
    expect(body).toHaveProperty('jobVersion', 1);
    // A manual save always activates the edited layout (active: true) so the
    // alternative (manual) view is shown by default after editing.
    expect(body.active).toBe(true);
    expect(Array.isArray(body.placements)).toBe(true);
    expect(body.placements.length).toBeGreaterThan(0);

    const moveA = (body.placements as Array<Record<string, unknown>>).find(
      (m) => m.itemId === 'det-1',
    );
    expect(moveA).toBeDefined();
    expect(moveA).toHaveProperty('instance', 0);
    expect(moveA).toHaveProperty('sheetIndex', 0);
    // I-2: assert the piece actually MOVED. A vacuous toHaveProperty('xMm') would
    // pass even if the SVG pointer drag silently no-ops (piece stuck at x=0). We
    // drag ~50mm right from x=0, so xMm must be well above 30 (allow snap/rounding).
    expect(typeof moveA!.xMm).toBe('number');
    expect(moveA!.xMm as number).toBeGreaterThan(30);
    expect(moveA).toHaveProperty('yMm');
    expect(moveA).toHaveProperty('rotated', false);
    // Must NOT carry geometry (no width_mm / height_mm / width / height).
    expect(moveA).not.toHaveProperty('width_mm');
    expect(moveA).not.toHaveProperty('height_mm');
    expect(moveA).not.toHaveProperty('widthMm');
    expect(moveA).not.toHaveProperty('heightMm');

    // ── Post-save: editor closes, checkbox appears ────────────────────────────
    // SheetEditor is hidden after the job updates.
    await expect(page.getByTestId('sheet-editor')).not.toBeVisible({ timeout: 8000 });

    // «Показать альтернативный раскрой» checkbox now appears because the updated
    // job has group.manualLayout != null.
    // M-3: this proves the POST-save UI state (PATCH response carries manualLayout),
    // NOT durable reload-persistence — the shared GET /cut-jobs/42 mock still returns
    // the pre-save fixture. A future maintainer proving reload-persistence must update
    // BOTH the PATCH and the GET mocks to return the saved manualLayout.
    await expect(page.getByTestId(`show-alternative-cb-${GROUP_ID}`)).toBeVisible({
      timeout: 8000,
    });
  });

  // ── S3a: rotate unlocked piece ─────────────────────────────────────────────
  test('S3a: R key rotates grain-unlocked piece (dimensions swap)', async ({ page }) => {
    await setupMocks(page);
    await openJob(page);
    await enterEditor(page);

    // Click piece A (det-1 on sheet 0) to select it.
    const rectA = page.getByTestId('piece-rect-0-det-1-0');
    await rectA.click();

    // Rotate button should appear on the selected piece.
    await expect(page.getByTestId('rotate-piece-0-det-1-0')).toBeVisible();

    // Record bounding box BEFORE rotation (portrait: w≈200*scale, h≈300*scale).
    const boxBefore = await rectA.boundingBox();
    expect(boxBefore).not.toBeNull();

    // Press R → rotatePiece swaps width_mm/height_mm (200×300 → 300×200).
    await page.keyboard.press('r');

    // Wait for React re-render (orientation change triggers a re-render).
    const boxAfter = await rectA.boundingBox();
    expect(boxAfter).not.toBeNull();

    // After rotation, width and height must be swapped (within 2px tolerance for rounding).
    expect(Math.abs(boxAfter!.width - boxBefore!.height)).toBeLessThan(3);
    expect(Math.abs(boxAfter!.height - boxBefore!.width)).toBeLessThan(3);
  });

  // ── S3b: rotate grain-locked piece blocked ──────────────────────────────────
  test('S3b: R key on grain-locked piece shows warning, no rotation', async ({ page }) => {
    await setupMocks(page);
    await openJob(page);
    await enterEditor(page);

    // Click grain-locked piece C (det-3 on sheet 1) to select it.
    const rectC = page.getByTestId('piece-rect-1-det-3-0');
    await expect(rectC).toBeVisible();
    await rectC.click();

    // Record bounding box before attempting rotation.
    const boxBefore = await rectC.boundingBox();
    expect(boxBefore).not.toBeNull();

    // Press R → should be blocked (filmTexture=true).
    await page.keyboard.press('r');

    // Ant Design message.warning fires: "Поворот запрещён: текстура плёнки закреплена"
    // M-1: filter by text so a co-existing notice (e.g. a leftover info toast) can't
    // make the selector resolve to the wrong/empty notice and flake.
    await expect(
      page.locator('.ant-message-notice').filter({ hasText: 'Поворот запрещён' }),
    ).toBeVisible({ timeout: 5000 });

    // Piece dimensions must NOT have changed (rotation was blocked).
    const boxAfter = await rectC.boundingBox();
    expect(boxAfter).not.toBeNull();
    expect(Math.abs(boxAfter!.width - boxBefore!.width)).toBeLessThan(2);
    expect(Math.abs(boxAfter!.height - boxBefore!.height)).toBeLessThan(2);
  });

  // ── S4: drag to overlap → Save disabled + violation text ──────────────────
  test('S4: drag piece to overlap → violation → Save button disabled', async ({ page }) => {
    await setupMocks(page);
    await openJob(page);
    await enterEditor(page);

    // Save starts enabled.
    await expect(page.getByTestId('save-manual-layout-btn')).toBeEnabled();

    // ── Drag piece B (det-2) so it overlaps piece A (det-1) ─────────────────
    // Piece B: usable x=300, y=0, w=200mm, h=300mm.
    //   Centre in SVG mm: (10+300+100, 10+0+150) = (410, 160).
    // Target: move B to usable x=50mm → overlaps A (0–200mm) at 50–250mm.
    //   New SVG centre x = (10+50+100) = 160mm.
    // Snap check: nearest candidate at dist=50 > threshold(10) → no snap to A.right+gap(203).
    // Validation: piecesClear(A{0,0,200,300}, B{50,0,200,300}, gap=3) → gapX=-150 < 3 → OVERLAP.
    const svgLocator = page.locator('[data-testid="sheet-editor-sheet-0"] svg').first();
    await expect(svgLocator).toBeVisible();
    const svgBox = await svgLocator.boundingBox();
    expect(svgBox).not.toBeNull();

    const scale = svgBox!.width / 2800;
    // Piece B centre in viewport
    const bCenterX = svgBox!.x + 410 * scale;
    const bCenterY = svgBox!.y + 160 * scale;
    // Target: move B centre so usable x_mm ≈ 50 → SVG centre = (10+50+100)*scale = 160*scale
    const targetX = svgBox!.x + 160 * scale;

    await page.mouse.move(bCenterX, bCenterY);
    await page.mouse.down();
    await page.mouse.move(targetX, bCenterY, { steps: 12 });
    await page.mouse.up();

    // After the drag: overlap violation detected → Save disabled.
    await expect(page.getByTestId('save-manual-layout-btn')).toBeDisabled({ timeout: 8000 });

    // Violation count text appears in the editor toolbar.
    await expect(page.locator('text=нарушений геометрии')).toBeVisible({ timeout: 5000 });
  });

  // ── S5: dirty print-lock ───────────────────────────────────────────────────
  test('S5: editor active disables group PDF; cancel re-enables it', async ({ page }) => {
    await setupMocks(page);
    await openJob(page);

    // Before entering the editor: PDF button enabled (not dirty, not requiresRecalc).
    await expect(page.getByTestId(`preview-group-pdf-btn-${GROUP_ID}`)).toBeEnabled();

    // Enter editor → isDirtyGroup becomes true (isEditingGroup=true).
    await enterEditor(page);

    // «Скачать PDF» must be disabled while editor is open (unsaved changes).
    await expect(page.getByTestId(`preview-group-pdf-btn-${GROUP_ID}`)).toBeDisabled();

    // Cancel editing → isDirtyGroup becomes false.
    await page.getByTestId('cancel-edit-btn').click();
    await expect(page.getByTestId('sheet-editor')).not.toBeVisible({ timeout: 5000 });

    // «Скачать PDF» re-enabled after cancellation.
    await expect(page.getByTestId(`preview-group-pdf-btn-${GROUP_ID}`)).toBeEnabled({
      timeout: 5000,
    });
  });

  test('S5b: group PDF opens preview modal and downloads loaded blob', async ({ page }) => {
    await setupMocks(page);
    await openJob(page);

    let pdfRequestUrl = '';
    await page.route(/\/api\/v1\/cut-jobs\/42\/groups\/100\/export\.pdf(\?.*)?$/, (route) => {
      pdfRequestUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: PNG_BYTES });
    });

    await page.getByTestId(`pdf-template-select-${GROUP_ID}`).click();
    await page.getByTitle('Ванна: вакуумный стол').click();

    await page.getByTestId(`preview-group-pdf-btn-${GROUP_ID}`).click();

    const modal = page.getByRole('dialog', { name: /Предпросмотр PDF/ });
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(modal.locator('iframe[title="Предпросмотр PDF"]')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Скачать' })).toBeEnabled();
    expect(pdfRequestUrl).toContain('template=bath_vacuum');
  });

  // ── S6: requiresRecalc → "устарел" tag + editor + PDF disabled ─────────────
  test('S6: requiresRecalc=true → "устарел" + editor disabled + PDF disabled', async ({
    page,
  }) => {
    await setupMocks(page, { requiresRecalc: true });
    await openJob(page);

    // "устарел" tag visible in the group card header.
    await expect(page.locator('text=устарел')).toBeVisible({ timeout: 10000 });

    // «Редактировать раскрой» disabled (editDisabled=true when requiresRecalc).
    await expect(page.getByTestId(`edit-layout-btn-${GROUP_ID}`)).toBeDisabled();

    // «Скачать PDF» disabled (requiresRecalc takes priority).
    await expect(page.getByTestId(`preview-group-pdf-btn-${GROUP_ID}`)).toBeDisabled();
  });

  // ── SKIPPED: cross-sheet move ─────────────────────────────────────────────
  test.skip('SKIP cross-sheet drag: move piece from sheet 0 to sheet 1', async () => {
    // Reason: reliable headless cross-sheet drag requires both SVGs to be rendered
    // in full at 700px width, the pointer to enter the second SVG's bounding rect
    // during pointermove, and the sheet 1 SVG is often below the viewport fold.
    // pointer.move across SVG element boundaries is flaky in CI headless setups.
    // Covered by unit tests in cutLayoutGeometry.test.ts (DragState.targetSheetIndex logic).
  });

  // ── S7: repeat-save cache-bust (renderToken carried into the preview URL) ──
  // I-3: a manual layout already exists (renderToken 't1'); re-saving returns
  // renderToken 't2'. Assert the auto-loaded thumbnail re-fetches with the NEW
  // token in the renderVersion query param (cache-bust), so an operator never
  // sees a stale render after a second save.
  test('S7: re-save updates renderToken → preview re-fetch carries renderVersion=t2', async ({
    page,
  }) => {
    // Seed a job whose group already has an active manual layout at token 't1'.
    const { job } = await setupMocks(page, {
      groups: [
        {
          ...makeReadyJob().groups[0],
          renderToken: 't1',
          manualLayout: {
            groupKey: `g${GROUP_ID}`,
            sheets: makeReadyJob().groups[0].sheets,
            isActive: true,
            isStale: false,
            version: 1,
          },
        },
      ],
    });

    // PATCH returns the job with a BUMPED renderToken ('t2') on both job + group.
    const savedGroup = {
      ...job.groups[0],
      renderToken: 't2',
      manualLayout: { ...(job.groups[0] as any).manualLayout, version: 2 },
    };
    const savedJob = { ...job, version: 2, renderToken: 't2', groups: [savedGroup] };
    await page.route(/\/api\/v1\/cut-jobs\/42\/groups\/100\/manual-layout$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(savedJob) }),
    );

    // Register the first-load listener BEFORE navigation: the thumbnail auto-load
    // fires during openJob, so registering it after would race and miss the request.
    const firstLoad = page.waitForRequest(/sheets\/\d+\.png\?.*renderVersion=t1/, { timeout: 30000 });
    await openJob(page);
    // Sanity: the first auto-load uses the original token.
    await firstLoad;

    // Edit → Save (no drag needed; seeded layout has no violations).
    await enterEditor(page);
    const [resaveReq] = await Promise.all([
      // The post-save auto-load must re-fetch the preview with the NEW token.
      page.waitForRequest(/sheets\/\d+\.png\?.*renderVersion=t2/, { timeout: 10000 }),
      page.getByTestId('save-manual-layout-btn').click(),
    ]);
    expect(resaveReq.url()).toContain('renderVersion=t2');
  });

  // ── S8: variant toggle requests the manual render ─────────────────────────
  // I-4: a manual layout exists but is NOT active (showAlt starts false → auto).
  // Checking «Показать альтернативный раскрой» must make the preview re-fetch
  // with variant=manual so the operator sees the alternative layout.
  test('S8: «Показать альтернативный раскрой» → preview re-fetch carries variant=manual', async ({
    page,
  }) => {
    await setupMocks(page, {
      groups: [
        {
          ...makeReadyJob().groups[0],
          renderToken: 't1',
          manualLayout: {
            groupKey: `g${GROUP_ID}`,
            sheets: makeReadyJob().groups[0].sheets,
            isActive: false, // showAlt initialises false → first load is variant=auto
            isStale: false,
            version: 1,
          },
        },
      ],
    });

    // Register the first-load listener BEFORE navigation (auto-load fires during openJob).
    const autoLoad = page.waitForRequest(/sheets\/\d+\.png\?.*variant=auto/, { timeout: 30000 });
    await openJob(page);
    // First auto-load is the auto variant (checkbox unchecked).
    await autoLoad;

    // Toggle the alternative-view checkbox → effect re-runs with variant=manual.
    const [manualReq] = await Promise.all([
      page.waitForRequest(/sheets\/\d+\.png\?.*variant=manual/, { timeout: 10000 }),
      page.getByTestId(`show-alternative-cb-${GROUP_ID}`).check(),
    ]);
    expect(manualReq.url()).toContain('variant=manual');
  });
});
