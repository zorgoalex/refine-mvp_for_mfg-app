import { expect, test } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

/**
 * Mocked-local Playwright coverage for the new SheetEditor behaviours
 * added in Tasks 1–5:
 *   1. Snap guide lines during drag (fill="#1677ff" rect visible mid-drag)
 *   2. Context-menu rotate (right-click → «Поворот» → dimensions swap)
 *   3. Cross-sheet move (piece relocates to sheet 1)
 *   4. Blocked cross-sheet move (material mismatch → warning + snap-back)
 *
 * No live backend: all /api/v1/cut-jobs endpoints fulfilled by route intercepts.
 * Follows cut-manual-layout.spec.ts conventions exactly.
 *
 * Scenarios:
 *   SR1 – right-click piece → context menu → click «Поворот» → rect w/h swap
 *   SR2 – drag piece within 40mm snap threshold → guide rect fill="#1677ff" visible
 *   SR3 – drag piece from sheet 0 into sheet 1 SVG → piece rect moves to sheet 1
 *   SR4 – cross-sheet drag with mismatched sheetMaterialTypeId → warning toast +
 *          piece stays on sheet 0 (snap-back)
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

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ── Fixture builder ─────────────────────────────────────────────────────────

function makeReadyJob(overrides: Record<string, unknown> = {}) {
  return {
    cutJobId: JOB_ID,
    name: 'E2E-Тест snap-rotate',
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
          filmTexture: false,
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
          filmTexture: false,
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
          filmTexture: true,
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
              // Piece A (det-1) at usable (0,0,200,300) — unlocked, material=1
              // Piece B (det-2) at usable (300,0,200,300) — unlocked; gap=100mm > kerf+spacing=3mm
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
              // Piece C (det-3) at usable (0,0,200,150) — grain-LOCKED
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

// ── Shared mock setup ───────────────────────────────────────────────────────

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

  await page.route(/\/api\/v1\/cut-jobs\/sheet-types(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await page.route(/\/api\/v1\/cut-config$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        renderPresets: [{ name: 'screen', isActive: true }],
        paramProfiles: [],
        settings: [],
      }),
    }),
  );

  await page.route(/\/api\/v1\/cut-jobs\/42$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(job),
    }),
  );

  await page.route(/\/api\/v1\/cut-jobs$/, (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(job),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([job]),
    });
  });

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

// ── Navigation helpers ──────────────────────────────────────────────────────

async function openJob(page: import('@playwright/test').Page) {
  await page.goto('/cut');
  await expect(page.getByText('E2E-Тест snap-rotate')).toBeVisible({ timeout: 45000 });
  await page.getByRole('button', { name: 'Открыть' }).first().click();
  await expect(page.getByText(`Раскрой #${JOB_ID}`)).toBeVisible({ timeout: 10000 });
}

async function enterEditor(page: import('@playwright/test').Page) {
  await page.getByTestId(`edit-layout-btn-${GROUP_ID}`).click();
  await expect(page.getByTestId('sheet-editor')).toBeVisible({ timeout: 8000 });
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe('Cut editor: snap guides, rotate menu, cross-sheet guard (mocked-local)', () => {
  // ── SR1: right-click piece → context menu → «Поворот» → dimensions swap ──
  test('SR1: right-click piece → context menu with «Поворот» → click → dimensions swap', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await setupMocks(page);
    await openJob(page);
    await enterEditor(page);

    // Right-click piece A (det-1, sheet 0) to trigger the context menu.
    // Piece A rect is a solid SVG rect; right-click bubbles to the <g>'s onContextMenu.
    const rectA = page.getByTestId('piece-rect-0-det-1-0');
    await expect(rectA).toBeVisible();
    await rectA.click({ button: 'right' });

    // Context menu portal should appear at the click location.
    await expect(page.getByTestId('piece-context-menu')).toBeVisible({ timeout: 5000 });

    // The «Поворот» item must be present and enabled (det-1 has filmTexture=false).
    const rotateItem = page.getByTestId('piece-context-menu').getByText('Поворот');
    await expect(rotateItem).toBeVisible();

    // Record bounding box BEFORE rotation (portrait: w≈200×scale, h≈300×scale).
    const boxBefore = await rectA.boundingBox();
    expect(boxBefore).not.toBeNull();
    // Portrait piece: h > w (300 > 200).
    expect(boxBefore!.height).toBeGreaterThan(boxBefore!.width);

    // Click «Поворот» → handleRotateButton swaps width_mm/height_mm (200×300 → 300×200).
    await rotateItem.click();

    // Context menu should close after the click.
    await expect(page.getByTestId('piece-context-menu')).not.toBeVisible({ timeout: 3000 });

    // After rotation: width and height must be swapped (within 3px tolerance for rounding).
    const boxAfter = await rectA.boundingBox();
    expect(boxAfter).not.toBeNull();
    // Now landscape: w > h.
    expect(boxAfter!.width).toBeGreaterThan(boxAfter!.height);
    // Width after ≈ height before, height after ≈ width before.
    expect(Math.abs(boxAfter!.width - boxBefore!.height)).toBeLessThan(4);
    expect(Math.abs(boxAfter!.height - boxBefore!.width)).toBeLessThan(4);
  });

  // ── SR2: snap guide rect appears mid-drag ──────────────────────────────────
  test('SR2: drag piece within snap threshold → guide rect fill="#1677ff" visible mid-drag', async ({
    page,
  }) => {
    await setupMocks(page);
    await openJob(page);
    await enterEditor(page);

    // Sheet 0 SVG: viewBox "0 0 2800 2070", displayed at 700×517px (portrait, landscape=false).
    // Scale = 700 / 2800 = 0.25 px/mm  → mmPerPx = 4mm/px.
    // Snap threshold = SNAP_THRESHOLD_PX(10) × mmPerPx(4) = 40mm.
    //
    // Piece A (det-1): usable (0, 0, 200, 300).
    //   SVG centre = (trim.left + 0 + 100, trim.top + 0 + 150) = (110, 160) mm.
    //   In display px: (110 × 0.25, 160 × 0.25) = (27.5, 40) px from SVG origin.
    //
    // Drag plan: move mouse 7px right from piece A centre.
    //   raw x_mm = (110 + 7×4) - svgOffsetX(100) - trim.left(10) = 142 - 100 - 10 = 32mm.
    //   Nearest snap candidate: x=0 (usable left edge), dist=32mm < threshold(40mm) → SNAP.
    //   guideXmm = 0 → guide rect fill="#1677ff" is rendered while mouse is still down.

    const svgLocator = page.locator('[data-testid="sheet-editor-sheet-0"] svg').first();
    await expect(svgLocator).toBeVisible();
    const svgBox = await svgLocator.boundingBox();
    expect(svgBox).not.toBeNull();

    const scale = svgBox!.width / 2800; // ~0.25
    const aCenterX = svgBox!.x + 110 * scale;
    const aCenterY = svgBox!.y + 160 * scale;
    // 7px right in viewport ≈ 28mm in SVG space; well within snap threshold (40mm).
    const dragDeltaPx = 7;

    await page.mouse.move(aCenterX, aCenterY);
    await page.mouse.down();
    // Move in small steps so pointermove fires and React re-renders the guide.
    await page.mouse.move(aCenterX + dragDeltaPx, aCenterY, { steps: 4 });

    // Guide rect must be in the DOM while mouse is held (non-null guideXmm or guideYmm).
    // The guide is a <rect fill="#1677ff"> inside the sheet 0 SVG.
    const guideRect = page
      .locator('[data-testid="sheet-editor-sheet-0"] svg')
      .first()
      .locator('rect[fill="#1677ff"]');
    await expect(guideRect.first()).toBeVisible({ timeout: 4000 });

    // Release — drag commits, guideXmm resets to null, guide rect disappears.
    await page.mouse.up();
    await expect(guideRect.first()).not.toBeVisible({ timeout: 3000 });
  });

  // ── SR3: drag piece cross-sheet → relocates onto sheet 1 ──────────────────
  //
  // Strategy: use a 3000px tall viewport so both SVGs (and the entire page)
  // fit without any scrolling. The window-level handleMove in SheetEditor uses
  // getBoundingClientRect() for each SVG to detect when the pointer enters a
  // different sheet. Both SVGs must have their bounding rects within the
  // viewport during the drag (getBoundingClientRect returns viewport-relative
  // coords, and Playwright clips pointer events to the viewport boundary).
  //
  // With scrollY=0 the two 700×518px sheets start at ~y=1106 and ~y=1663
  // (the page has ~1100px of nav + job header + group header above the editor).
  // A 3000px viewport guarantees both sheets and the drop target (~y=1921)
  // are fully inside the viewport without any scroll.
  test('SR3: drag piece from sheet 0 to sheet 1 → piece relocates onto sheet 1', async ({
    page,
  }) => {
    test.setTimeout(90000);
    // 3000px height: page content + both sheets (~2200px total) fits with no scrolling.
    await page.setViewportSize({ width: 1280, height: 3000 });
    // Allow cross-sheet move. Two conditions must hold for moveAllowed→{ok:true}:
    //   1. Materials match: piece det-1 sheetMaterialTypeId=1 = group sheetMaterialTypeId=1.
    //   2. Film guard bypassed: the default fixture has combineFilms=false and pieceFilmId=1
    //      while groupFilmId=null → film guard would block. Set combineFilms=true to skip
    //      the film check entirely (only material is checked).
    await setupMocks(page, { combineFilms: true });
    await openJob(page);
    await enterEditor(page);

    // Verify both sheets are rendered.
    await expect(page.getByTestId('sheet-editor-sheet-0')).toBeVisible();
    await expect(page.getByTestId('sheet-editor-sheet-1')).toBeVisible();

    const svg0 = page.locator('[data-testid="sheet-editor-sheet-0"] svg').first();
    const svg1 = page.locator('[data-testid="sheet-editor-sheet-1"] svg').first();
    const box0 = await svg0.boundingBox();
    const box1 = await svg1.boundingBox();
    expect(box0).not.toBeNull();
    expect(box1).not.toBeNull();

    // Sanity: both SVGs must be within the 3000px viewport. If this fails the
    // test environment changed and the test needs a bigger viewport.
    expect(box0!.y).toBeGreaterThanOrEqual(0);
    expect(box0!.y + box0!.height).toBeLessThan(3000);
    expect(box1!.y).toBeGreaterThanOrEqual(0);
    expect(box1!.y + box1!.height).toBeLessThan(3000);

    // Piece A (det-1): SVG centre on sheet 0 = (110mm, 160mm) × scale.
    // Portrait sheet: 2800mm wide at 700px display → scale = 0.25 px/mm.
    // SVG centre of piece A = (trim.left+x_mm+w/2, trim.top+y_mm+h/2) = (10+0+100, 10+0+150) = (110, 160) mm.
    const scale0 = box0!.width / 2800;
    const aCenterX = box0!.x + 110 * scale0;
    const aCenterY = box0!.y + 160 * scale0;

    // Drop target: right side of sheet 1, near the top (first 20px of the SVG).
    // Using a near-top y-coordinate is reliable in headless Chromium; it avoids
    // y > ~1900 where the Playwright CDP may handle coordinates differently.
    const dropX = box1!.x + box1!.width * 0.75;
    const dropY = box1!.y + 20;

    // Perform cross-sheet drag with many steps so handleMove fires and can detect
    // when the pointer crosses into sheet 1's getBoundingClientRect.
    await page.mouse.move(aCenterX, aCenterY);
    await page.mouse.down();
    await page.mouse.move(dropX, dropY, { steps: 40 });
    await page.mouse.up();

    // After a successful cross-sheet move, onChange(nextSheets) fires:
    // - sheet 0 loses det-1 → piece-rect-0-det-1-0 disappears
    // - sheet 1 gains det-1 → piece-rect-1-det-1-0 appears
    await expect(page.getByTestId('piece-rect-1-det-1-0')).toBeVisible({ timeout: 6000 });
    await expect(page.getByTestId('piece-rect-0-det-1-0')).not.toBeVisible({ timeout: 3000 });
  });

  // ── SR4: cross-sheet drag blocked by material mismatch ─────────────────────
  //
  // Fixture engineering: piece det-1 has sheetMaterialTypeId=2, but the editing
  // group has sheetMaterialTypeId=1 and splitByMaterial=true.
  // In SheetEditor.handleUp:
  //   moveAllowed({ pieceMaterialTypeId:2, targetMaterialTypeId:1, splitByMaterial:true })
  //   → { ok: false, reason: 'material' }
  // → message.warning('Нельзя переместить: другой материал листа') + snap-back.
  //
  // This test uses the same 3000px viewport strategy as SR3 to guarantee both
  // SVGs are fully in the viewport during the drag.
  test('SR4: cross-sheet drag with mismatched material → warning + piece stays on sheet 0', async ({
    page,
  }) => {
    test.setTimeout(90000);
    // Same 3000px strategy as SR3.
    await page.setViewportSize({ width: 1280, height: 3000 });

    // Override det-1's sheetMaterialTypeId to 2 (group stays at 1) to force the block.
    // moveAllowed({ pieceMaterialTypeId:2, targetMaterialTypeId:1, splitByMaterial:true })
    //   → { ok: false, reason: 'material' } → snap-back + warning.
    const baseJob = makeReadyJob();
    const blockedItems = baseJob.items.map((it: Record<string, unknown>, idx: number) => {
      if (idx === 0) {
        // det-1: give it a DIFFERENT material than the group (group=1, piece=2)
        return {
          ...it,
          detail: { ...(it.detail as Record<string, unknown>), sheetMaterialTypeId: 2 },
        };
      }
      return it;
    });
    await setupMocks(page, { items: blockedItems });
    await openJob(page);
    await enterEditor(page);

    await expect(page.getByTestId('sheet-editor-sheet-0')).toBeVisible();
    await expect(page.getByTestId('sheet-editor-sheet-1')).toBeVisible();

    const svg0 = page.locator('[data-testid="sheet-editor-sheet-0"] svg').first();
    const svg1 = page.locator('[data-testid="sheet-editor-sheet-1"] svg').first();
    const box0 = await svg0.boundingBox();
    const box1 = await svg1.boundingBox();
    expect(box0).not.toBeNull();
    expect(box1).not.toBeNull();

    // Sanity: both SVGs must be within the 3000px viewport.
    expect(box0!.y).toBeGreaterThanOrEqual(0);
    expect(box0!.y + box0!.height).toBeLessThan(3000);
    expect(box1!.y).toBeGreaterThanOrEqual(0);
    expect(box1!.y + box1!.height).toBeLessThan(3000);

    const scale0 = box0!.width / 2800;
    // Drag piece A (det-1) from sheet 0 to sheet 1.
    const aCenterX = box0!.x + 110 * scale0;
    const aCenterY = box0!.y + 160 * scale0;
    // Use near-top drop position (same proven-reliable approach as SR3).
    const dropX = box1!.x + box1!.width * 0.75;
    const dropY = box1!.y + 20;

    // Verify piece A is on sheet 0 before the drag.
    await expect(page.getByTestId('piece-rect-0-det-1-0')).toBeVisible();
    await expect(page.getByTestId('piece-rect-1-det-1-0')).not.toBeVisible();

    await page.mouse.move(aCenterX, aCenterY);
    await page.mouse.down();
    await page.mouse.move(dropX, dropY, { steps: 40 });
    await page.mouse.up();

    // Guard fires: message.warning('Нельзя переместить: другой материал листа')
    // This is an antd message.warning toast rendered in the DOM.
    await expect(
      page.locator('.ant-message-notice').filter({ hasText: 'Нельзя переместить' }),
    ).toBeVisible({ timeout: 6000 });

    // Snap-back: onChange is NOT called, workingSheets unchanged.
    // Piece A must remain on sheet 0 and must NOT appear on sheet 1.
    await expect(page.getByTestId('piece-rect-0-det-1-0')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('piece-rect-1-det-1-0')).not.toBeVisible();
  });
});
