import { expect, test, type Page } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

/**
 * Mocked-local Playwright coverage for the QR-template library + canvas placement on
 * Configuration → «Бирки». No live backend: /api/v1/label-fields, /api/v1/label-templates
 * and /api/v1/label-qr-templates are all fulfilled by an in-memory mock scoped to this
 * test (mirrors the pattern in cut-manual-layout.spec.ts / cut-frontend.spec.ts).
 *
 * This project defers *live* E2E (real backend + DB + `vercel dev` + device login) to the
 * user; this spec proves the frontend contract end-to-end against a mocked backend, which
 * is what CI/sandbox runs can execute deterministically.
 *
 * Flow (single continuous scenario, matching the task brief's numbered steps):
 *   1. Log in as admin (mocked), open Configuration → «Бирки».
 *   2. Expand «QR-коды»; create a library QR template (name + static-text chip + size 18);
 *      assert it appears in the library table.
 *   3. Start a new label template; drag the QR icon from the library onto the canvas;
 *      assert the «Элементы» row count goes from 1 → 2 (a `qr` element was added).
 *   4. Resize the QR via its Transformer bottom-right handle; assert width/height grew.
 *   5. Name the label template, save; reload the page; reopen the saved template; assert
 *      the QR persisted with its library name and its resized geometry.
 *   6. Cleanup: delete the QR template from the library (the only delete affordance this
 *      tab exposes — label-template deletion is not wired in the UI, see comment below).
 *
 * Canvas geometry notes (why the pixel math below is safe):
 *   - A fresh template (`startNew()`) is canvasWidthMm=85 × canvasHeightMm=88, with ONE
 *     default text element at (2,2)-(62,8)mm.
 *   - The «Визуал бирки» preview (the only INTERACTIVE Konva Stage — the read-only
 *     «Просмотр текущего шаблона» preview above it receives no draggingQr/onDropDraggingQr
 *     props, so drops over it are inert) renders at initialZoom=0.6 when not expanded.
 *   - We drop the QR at mm (30,30) with defaultSizeMm=18 → QR spans (30,30)-(48,48)mm,
 *     protected quiet-zone rect (28.2,28.2)-(49.8,49.8)mm. The default text element's rect
 *     is (2,2)-(62,8)mm — no Y-overlap, so autoShiftForQr never nudges either element and
 *     the drop lands exactly where we compute it.
 *   - The Konva node backing a `qr` element (the one the Transformer attaches to) is a
 *     plain Rect at (xMm,yMm,side,side) with rotation 0, so its bottom-right corner is
 *     exactly (xMm+widthMm, yMm+heightMm) in canvas-mm space — no extra offset/anchor math.
 */

const QR_LIBRARY_FIELD = {
  id: 'bazis.detail_id',
  source: 'bazis' as const,
  sourceColumn: null,
  label: 'ID детали (Bazis)',
  type: 'string' as const,
  category: 'Bazis',
};
const LABEL_FIELDS = [
  {
    id: 'bazis.order_number',
    source: 'bazis' as const,
    sourceColumn: null,
    label: 'Номер заказа (Bazis)',
    type: 'string' as const,
    category: 'Bazis',
  },
  QR_LIBRARY_FIELD,
];

const LABELS_PERMISSIONS = [
  'orders.view',
  'orders.create',
  'orders.update',
  'orders.export',
  'payments.view',
  'payments.create',
  'payments.update',
  'payments.delete',
  'clients.view',
  'clients.create',
  'clients.update',
  'production.actions',
  'settings.view',
  'sheet_materials.view',
  'sheet_materials.manage',
  'labels.view',
  'labels.manage_templates',
];

// ── In-memory backend mock for the three labels endpoints ──────────────────────

function setupLabelsBackendMocks(page: Page) {
  const qrTemplates: Array<Record<string, unknown>> = [];
  let qrNextId = 1;
  const templates: Array<Record<string, unknown>> = [];
  let templateNextId = 1;

  return {
    install: async () => {
      await page.route(/\/api\/v1\/label-fields(\?.*)?$/, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LABEL_FIELDS) }),
      );

      await page.route(/\/api\/v1\/label-qr-templates(\/\d+)?(\?.*)?$/, async (route) => {
        const method = route.request().method();
        const idMatch = route.request().url().match(/label-qr-templates\/(\d+)/);

        if (!idMatch) {
          if (method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(qrTemplates) });
          }
          if (method === 'POST') {
            const body = JSON.parse(route.request().postData() || '{}');
            const created = {
              labelQrTemplateId: qrNextId++,
              name: body.name,
              contentTemplate: body.contentTemplate,
              errorCorrection: body.errorCorrection,
              defaultSizeMm: body.defaultSizeMm,
              isActive: true,
              version: 0,
            };
            qrTemplates.push(created);
            return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
          }
          return route.fulfill({ status: 405, body: '' });
        }

        const id = Number(idMatch[1]);
        if (method === 'PUT') {
          const body = JSON.parse(route.request().postData() || '{}');
          const index = qrTemplates.findIndex((row) => row.labelQrTemplateId === id);
          if (index === -1) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
          qrTemplates[index] = {
            ...qrTemplates[index],
            ...body,
            labelQrTemplateId: id,
            version: Number(qrTemplates[index].version ?? 0) + 1,
          };
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(qrTemplates[index]) });
        }
        if (method === 'DELETE') {
          const index = qrTemplates.findIndex((row) => row.labelQrTemplateId === id);
          if (index >= 0) qrTemplates.splice(index, 1);
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        }
        return route.fulfill({ status: 405, body: '' });
      });

      await page.route(/\/api\/v1\/label-templates(\/\d+)?(\?.*)?$/, async (route) => {
        const method = route.request().method();
        const idMatch = route.request().url().match(/label-templates\/(\d+)/);

        if (!idMatch) {
          if (method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(templates) });
          }
          if (method === 'POST') {
            const body = JSON.parse(route.request().postData() || '{}');
            const created = {
              labelTemplateId: templateNextId++,
              name: body.name,
              description: body.description ?? null,
              version: 0,
              isActive: true,
              canvasWidthMm: body.canvasWidthMm,
              canvasHeightMm: body.canvasHeightMm,
              dpi: body.dpi,
              defaultExportFormats: body.defaultExportFormats,
              customFieldSchema: body.customFieldSchema ?? {},
              elements: body.elements ?? [],
            };
            templates.push(created);
            return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
          }
          return route.fulfill({ status: 405, body: '' });
        }

        const id = Number(idMatch[1]);
        if (method === 'GET') {
          const found = templates.find((row) => row.labelTemplateId === id);
          if (!found) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(found) });
        }
        if (method === 'PUT') {
          const body = JSON.parse(route.request().postData() || '{}');
          const index = templates.findIndex((row) => row.labelTemplateId === id);
          if (index === -1) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
          templates[index] = {
            ...templates[index],
            ...body,
            labelTemplateId: id,
            version: Number(templates[index].version ?? 0) + 1,
          };
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(templates[index]) });
        }
        if (method === 'DELETE') {
          const index = templates.findIndex((row) => row.labelTemplateId === id);
          if (index >= 0) templates.splice(index, 1);
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        }
        return route.fulfill({ status: 405, body: '' });
      });
    },
  };
}

async function setupMocks(page: Page) {
  await setupWorkflowMockApi(page, undefined, {
    runtimeConfig: { backendAuth: true, backendPermissions: true, labels: true },
  });

  const identity = {
    id: '1',
    userId: 1,
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: LABELS_PERMISSIONS,
  };

  // Override /me and /auth/refresh so the app's auth-bootstrap identity carries the
  // labels.* permissions (registered after setupWorkflowMockApi so Playwright's LIFO
  // route ordering makes this win — same pattern as cut-manual-layout.spec.ts).
  await page.route(/\/api\/v1\/me$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: identity }) }),
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

  const backend = setupLabelsBackendMocks(page);
  await backend.install();
}

async function openLabelsTab(page: Page) {
  await page.goto('/configuration');
  await expect(page.getByRole('tab', { name: /Бирки/ })).toBeVisible({ timeout: 45000 });
  await page.getByRole('tab', { name: /Бирки/ }).click();
  // Anchor on a control unique to LabelsConfigTab so we know the pane finished mounting.
  await expect(page.getByRole('button', { name: 'Новый шаблон' })).toBeVisible({ timeout: 15000 });
}

// ── Test ─────────────────────────────────────────────────────────────────────

test.describe('Labels: QR-template library + canvas placement (mocked-local)', () => {
  // Tall viewport: the drag steps below use real page.mouse events, which operate in
  // VIEWPORT-relative coordinates (same space as elementHandle.boundingBox()). With the
  // default ~1280×720 viewport, both the library drag icon and the interactive canvas sit
  // well below the fold once the "QR-коды" panel is expanded, so a `page.mouse.down()` at
  // their measured Y coordinate would target a point outside the actual rendered viewport
  // and silently miss (confirmed via a debug run: the icon's onMouseDown never fired).
  // A generous fixed viewport avoids any scroll-timing dependency entirely.
  test.use({ viewport: { width: 1600, height: 3200 } });

  test('create library QR template, drag onto canvas, resize, save, persist, cleanup', async ({ page }) => {
    // First test in the file: allow for a cold Vite bundle compile.
    test.setTimeout(120000);

    const ts = Date.now();
    const qrName = `E2E-Тест QR ${ts}`;
    const labelName = `E2E-Тест QR label ${ts}`;

    await setupMocks(page);
    await openLabelsTab(page);

    // ── Step 2: expand «QR-коды», create a library QR template ───────────────
    await page.locator('.ant-collapse-header', { hasText: 'QR-коды' }).click();
    const qrPanel = page.locator('.ant-collapse-item').filter({ hasText: 'QR-коды' });
    await expect(qrPanel.getByPlaceholder('Название QR-шаблона')).toBeVisible({ timeout: 10000 });

    await qrPanel.getByPlaceholder('Название QR-шаблона').fill(qrName);
    // "type template" path (brief allows either dragging a field or typing text into the
    // static-text chip input) — far more robust in headless CI than emulating HTML5 DnD
    // between the field palette and the chip dropzone.
    await qrPanel.getByPlaceholder('Статический текст').fill('DET');
    await qrPanel.getByRole('button', { name: 'Добавить текст' }).click();
    await expect(qrPanel.getByText('DET', { exact: true })).toBeVisible();

    // Size, мм — InputNumber; set to 18 per brief.
    const qrSizeInput = qrPanel.locator('.ant-input-number-input').last();
    await qrSizeInput.fill('18');

    const qrCreateResponse = page.waitForResponse(
      (response) => /\/api\/v1\/label-qr-templates$/.test(response.url()) && response.request().method() === 'POST',
    );
    await qrPanel.getByRole('button', { name: 'Сохранить QR-шаблон' }).click();
    await qrCreateResponse;
    await expect(page.locator('.ant-message-notice').filter({ hasText: 'QR-шаблон создан' })).toBeVisible({
      timeout: 10000,
    });

    // Assert it appears in the library list (Table rowKey=labelQrTemplateId).
    const qrLibraryRow = page.locator('tr.ant-table-row').filter({ hasText: qrName });
    await expect(qrLibraryRow).toBeVisible({ timeout: 10000 });
    await expect(qrLibraryRow).toContainText('18');

    // ── Step 3: start a new label template, drag the QR icon onto the canvas ──
    await page.getByRole('button', { name: 'Новый шаблон' }).click();

    const elementsTable = page.locator('.ant-table').filter({ has: page.locator('.ant-table-title', { hasText: 'Элементы' }) });
    const elementRows = elementsTable.locator('tbody tr.ant-table-row');
    await expect(elementRows).toHaveCount(1); // baseline: the default text element only.

    // Read the live canvas dims from the form instead of hard-assuming 85×88, so this
    // spec doesn't silently drift if startNew()'s defaults ever change.
    const canvasWidthMm = Number(await page.locator('#canvasWidthMm').inputValue());
    const canvasHeightMm = Number(await page.locator('#canvasHeightMm').inputValue());
    expect(canvasWidthMm).toBeGreaterThan(0);
    expect(canvasHeightMm).toBeGreaterThan(0);

    // The ONLY interactive Konva Stage — the passive "Просмотр текущего шаблона"
    // preview above it never receives draggingQr/onDropDraggingQr props, so a drop
    // there is inert. Scope to the "Визуал бирки" card to avoid hitting it by accident.
    // NOTE: `.ant-card` is NESTED here — the whole tab body lives inside the outer
    // "Конфигурация" Card, so a naive `.ant-card:has(.ant-card-head-title:has-text(...))`
    // filter also matches that OUTER card (it has the inner "Визуал бирки" card as a
    // descendant) and `.first()` would silently grab the WRONG (passive, zoom=1) canvas.
    // Walk from the title to its nearest `.ant-card` ancestor instead, which is exactly
    // the "Визуал бирки" card itself.
    const visualCard = page
      .locator('.ant-card-head-title', { hasText: 'Визуал бирки' })
      .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-card ")][1]');
    const canvasHandle = visualCard.locator('canvas').first();
    await expect(canvasHandle).toBeVisible();
    const canvasBoxBeforeDrop = await canvasHandle.boundingBox();
    expect(canvasBoxBeforeDrop).not.toBeNull();
    const scaleXBefore = canvasBoxBeforeDrop!.width / canvasWidthMm;
    const scaleYBefore = canvasBoxBeforeDrop!.height / canvasHeightMm;

    // Drop target: mm (30,30) — clear of the default text element's (2,2)-(62,8)mm rect.
    const dropXmm = 30;
    const dropYmm = 30;
    const dropPxX = canvasBoxBeforeDrop!.x + dropXmm * scaleXBefore;
    const dropPxY = canvasBoxBeforeDrop!.y + dropYmm * scaleYBefore;

    // The draggable QR icon: real mouse down/move/up (NOT HTML5 dragstart/drop — the
    // component's primary drag path is manual pointer tracking via React state, see
    // LabelsConfigTab's draggingQr effect), so genuine page.mouse events drive it exactly
    // like a real user, the same technique cut-manual-layout.spec.ts uses for SVG drags.
    const dragIcon = qrLibraryRow.locator('[data-qr-template-drag]');
    await expect(dragIcon).toBeVisible();
    const iconBox = await dragIcon.boundingBox();
    expect(iconBox).not.toBeNull();
    const iconCenterX = iconBox!.x + iconBox!.width / 2;
    const iconCenterY = iconBox!.y + iconBox!.height / 2;

    await page.mouse.move(iconCenterX, iconCenterY);
    await page.mouse.down();
    await page.mouse.move(dropPxX, dropPxY, { steps: 12 });
    await page.mouse.up();

    // Assert a `qr` element appeared: Элементы row count 1 → 2.
    await expect(elementRows).toHaveCount(2, { timeout: 10000 });
    const qrRow = elementRows.filter({ hasText: 'QR-код' });
    await expect(qrRow).toHaveCount(1);

    // ── Step 4: resize via the Transformer's bottom-right handle ──────────────
    // Column order (see LabelsConfigTab «Элементы» Table): Тип(0) Поле(1) Текст(2)
    // Имя QR(3) QR шаблон(4) Библиотека(5) xMm(6) yMm(7) widthMm(8) heightMm(9).
    const cell = (index: number) => qrRow.locator('td').nth(index);
    const readNumber = async (index: number) => Number(await cell(index).locator('.ant-input-number-input').inputValue());

    const xBefore = await readNumber(6);
    const yBefore = await readNumber(7);
    const widthBefore = await readNumber(8);
    const heightBefore = await readNumber(9);
    expect(widthBefore).toBeCloseTo(18, 0);
    expect(heightBefore).toBeCloseTo(18, 0);

    // «Библиотека» column should show it's already library-linked (dropped from the
    // library, so qrSourceTemplateId was set by qrElementFromLibrary on drop).
    await expect(cell(5)).toContainText('В библиотеке');

    // Re-measure the canvas box (layout is stable, but avoid relying on the earlier
    // pre-drop measurement for post-drop math).
    const canvasBoxAfterDrop = await canvasHandle.boundingBox();
    expect(canvasBoxAfterDrop).not.toBeNull();
    const scaleX = canvasBoxAfterDrop!.width / canvasWidthMm;
    const scaleY = canvasBoxAfterDrop!.height / canvasHeightMm;

    // The Konva node backing this element is an unrotated Rect at (xBefore,yBefore,
    // widthBefore,heightBefore), so its bottom-right corner is exactly this sum.
    const cornerXmm = xBefore + widthBefore;
    const cornerYmm = yBefore + heightBefore;
    const cornerPxX = canvasBoxAfterDrop!.x + cornerXmm * scaleX;
    const cornerPxY = canvasBoxAfterDrop!.y + cornerYmm * scaleY;

    // Drag the corner outward by 15mm on each axis (63,63 stays well inside the 85×88
    // canvas — no edge-conflict auto-shift kicks in).
    const deltaMm = 15;
    const targetPxX = cornerPxX + deltaMm * scaleX;
    const targetPxY = cornerPxY + deltaMm * scaleY;

    await page.mouse.move(cornerPxX, cornerPxY);
    await page.mouse.down();
    await page.mouse.move(targetPxX, targetPxY, { steps: 12 });
    await page.mouse.up();

    await expect(async () => {
      const widthAfter = await readNumber(8);
      const heightAfter = await readNumber(9);
      expect(widthAfter).toBeGreaterThan(widthBefore + 5);
      expect(heightAfter).toBeGreaterThan(heightBefore + 5);
    }).toPass({ timeout: 8000 });

    const widthAfterResize = await readNumber(8);
    const heightAfterResize = await readNumber(9);

    // ── Step 5: name the label template, save, reload, reopen, assert persisted ─
    await page.locator('#name').fill(labelName);

    const templateCreateResponse = page.waitForResponse(
      (response) => /\/api\/v1\/label-templates$/.test(response.url()) && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Сохранить шаблон' }).click();
    await templateCreateResponse;
    await expect(page.locator('.ant-message-notice').filter({ hasText: 'Шаблон создан' })).toBeVisible({
      timeout: 10000,
    });

    // saveTemplate() resets the form back to a fresh "Новый шаблон" state on success —
    // confirms we're really looking at the persisted-and-reset lifecycle, not a stale UI.
    await expect(elementRows).toHaveCount(1, { timeout: 10000 });

    await page.reload();
    // The active Configuration tab is remembered in sessionStorage across reload, but
    // click explicitly for robustness (idempotent if already selected).
    await expect(page.getByRole('tab', { name: /Бирки/ })).toBeVisible({ timeout: 45000 });
    await page.getByRole('tab', { name: /Бирки/ }).click();
    await expect(page.getByRole('button', { name: 'Новый шаблон' })).toBeVisible({ timeout: 15000 });

    const savedTemplateRow = page.locator('tr.ant-table-row').filter({ hasText: labelName });
    await expect(savedTemplateRow).toBeVisible({ timeout: 10000 });
    await savedTemplateRow.click();

    // Reopened: elements hydrate from the persisted template (text + qr).
    const reopenedElementsTable = page
      .locator('.ant-table')
      .filter({ has: page.locator('.ant-table-title', { hasText: 'Элементы' }) });
    const reopenedRows = reopenedElementsTable.locator('tbody tr.ant-table-row');
    await expect(reopenedRows).toHaveCount(2, { timeout: 10000 });

    const reopenedQrRow = reopenedRows.filter({ hasText: 'QR-код' });
    await expect(reopenedQrRow).toHaveCount(1);

    // "Имя QR" is column index 3 — a plain Input (not InputNumber) bound to
    // element.style.qrName. It must equal the library QR's name (uniqueQrName just
    // returns the base name unchanged since no other QR named `qrName` existed yet).
    const qrNameValue = await reopenedQrRow.locator('td').nth(3).locator('input').inputValue();
    expect(qrNameValue).toBe(qrName);

    // The resized geometry round-tripped through the mocked POST/GET too.
    const persistedWidth = Number(
      await reopenedQrRow.locator('td').nth(8).locator('.ant-input-number-input').inputValue(),
    );
    const persistedHeight = Number(
      await reopenedQrRow.locator('td').nth(9).locator('.ant-input-number-input').inputValue(),
    );
    expect(persistedWidth).toBeCloseTo(widthAfterResize, 0);
    expect(persistedHeight).toBeCloseTo(heightAfterResize, 0);

    // ── Step 6: cleanup ────────────────────────────────────────────────────────
    // Delete the QR template from the library (the only delete affordance this tab
    // exposes — grep confirms LabelsConfigTab never calls labelsApi.deleteTemplate;
    // the «Шаблоны» table's only per-row action is a disabled decorative Edit icon
    // button with no onClick handler). Since this run is fully mocked-local, the
    // in-memory `templates`/`qrTemplates` arrays are discarded with the browser
    // context at test end regardless — there is no live DB row to leave behind.
    await page.locator('.ant-collapse-header', { hasText: 'QR-коды' }).click();
    const qrPanelAfterReload = page.locator('.ant-collapse-item').filter({ hasText: 'QR-коды' });
    const qrLibraryRowAfterReload = qrPanelAfterReload.locator('tr.ant-table-row').filter({ hasText: qrName });
    await expect(qrLibraryRowAfterReload).toBeVisible({ timeout: 10000 });

    const qrDeleteResponse = page.waitForResponse(
      (response) => /\/api\/v1\/label-qr-templates\/\d+$/.test(response.url()) && response.request().method() === 'DELETE',
    );
    await qrLibraryRowAfterReload.getByRole('button').last().click();
    await qrDeleteResponse;
    await expect(page.locator('.ant-message-notice').filter({ hasText: 'QR-шаблон удалён' })).toBeVisible({
      timeout: 10000,
    });
    await expect(qrLibraryRowAfterReload).toHaveCount(0);
  });
});
