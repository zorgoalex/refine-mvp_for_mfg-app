import { expect, test, type Page, type Route } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

type SheetInput = {
  name: string;
  materialTypeId: number;
  unitId: number;
  thicknessMm: number;
  widthMm: number;
  heightMm: number;
  supplierId?: number | null;
  vendorId?: number | null;
  supplierArticle?: string | null;
  texture?: boolean | null;
  color?: string | null;
  refKey1c?: string | null;
  isActive?: boolean;
  version?: number;
};

function dto(row: Record<string, unknown>) {
  return {
    sheetMaterialTypeId: row.sheet_material_type_id,
    name: row.name,
    materialTypeId: row.material_type_id,
    unitId: row.unit_id,
    thicknessMm: row.thickness_mm,
    widthMm: row.width_mm,
    heightMm: row.height_mm,
    supplierId: row.supplier_id ?? null,
    vendorId: row.vendor_id ?? null,
    supplierArticle: row.supplier_article ?? null,
    texture: row.texture ?? null,
    color: row.color ?? null,
    refKey1c: row.ref_key_1c ?? null,
    isActive: row.is_active,
    version: row.version,
  };
}

function applyInput(row: Record<string, unknown>, input: SheetInput) {
  Object.assign(row, {
    name: input.name,
    material_type_id: input.materialTypeId,
    unit_id: input.unitId,
    thickness_mm: input.thicknessMm,
    width_mm: input.widthMm,
    height_mm: input.heightMm,
    supplier_id: input.supplierId ?? null,
    vendor_id: input.vendorId ?? null,
    supplier_article: input.supplierArticle ?? null,
    texture: input.texture ?? null,
    color: input.color ?? null,
    ref_key_1c: input.refKey1c ?? null,
    is_active: input.isActive ?? true,
    updated_at: new Date().toISOString(),
  });
}

async function fulfillJson(route: Route, status: number, body?: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });
}

async function mockSheetMaterialCommands(page: Page, db: WorkflowMockDb) {
  await page.route(/\/api\/v1\/sheet-material-types(?:\/\d+)?$/, async (route) => {
    const request = route.request();
    const method = request.method();
    const idMatch = /\/sheet-material-types\/(\d+)$/.exec(new URL(request.url()).pathname);
    const rows = db.sheet_material_types as Array<Record<string, unknown>>;

    if (method === 'POST' && !idMatch) {
      const input = request.postDataJSON() as SheetInput;
      const row: Record<string, unknown> = {
        sheet_material_type_id: Math.max(0, ...rows.map((item) => Number(item.sheet_material_type_id))) + 1,
        version: 0,
        created_at: new Date().toISOString(),
        created_by: 'admin',
        edited_by: 'admin',
      };
      applyInput(row, input);
      rows.push(row);
      await fulfillJson(route, 201, dto(row));
      return;
    }

    if (!idMatch) return route.fallback();
    const id = Number(idMatch[1]);
    const row = rows.find((item) => Number(item.sheet_material_type_id) === id);
    if (!row) return fulfillJson(route, 404, { error: { code: 'SHEET_MATERIAL_NOT_FOUND' } });
    const input = (request.postDataJSON?.() ?? {}) as SheetInput;
    if (Number(input.version) !== Number(row.version)) {
      return fulfillJson(route, 409, { error: { code: 'SHEET_MATERIAL_STALE_VERSION' } });
    }

    if (method === 'PUT') {
      applyInput(row, input);
      row.version = Number(row.version) + 1;
      await fulfillJson(route, 200, dto(row));
      return;
    }
    if (method === 'DELETE') {
      row.is_active = false;
      row.version = Number(row.version) + 1;
      await fulfillJson(route, 204);
      return;
    }
    await route.fallback();
  });
}

async function selectOption(page: Page, fieldId: string, optionText: string) {
  const trigger = page.locator(`#${fieldId}`)
    .locator('xpath=ancestor::div[contains(@class,"ant-form-item")][1]')
    .locator('.ant-select-selector');
  await trigger.click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await expect(dropdown).toBeVisible();
  await dropdown.locator('.ant-select-item-option').filter({ hasText: optionText }).first().click();
}

async function fillNumber(page: Page, fieldId: string, value: string) {
  const input = page.locator(`#${fieldId}`);
  await input.click({ clickCount: 3 });
  await input.fill(value);
}

test.describe('Sheet-material reference workflow', () => {
  test.setTimeout(180_000);

  test('creates, lists, shows, updates every field, and deactivates with optimistic version', async ({ page }) => {
    const db = createWorkflowMockDb();
    await setupWorkflowMockApi(page, db);
    await mockSheetMaterialCommands(page, db);

    await page.goto('/sheet-material-types/create');
    await page.locator('#name').fill('E2E листовой материал');
    await selectOption(page, 'materialTypeId', 'МДФ');
    await selectOption(page, 'unitId', 'Квадратный метр');
    await fillNumber(page, 'thicknessMm', '18');
    await fillNumber(page, 'widthMm', '2800');
    await fillNumber(page, 'heightMm', '2070');
    await selectOption(page, 'supplierId', 'Тестовый поставщик');
    await selectOption(page, 'vendorId', 'Тестовый производитель');
    await page.locator('#supplierArticle').fill('E2E-ART-1');
    await page.locator('#color').fill('Белый');
    await page.locator('#refKey1c').fill('sheet-e2e-key');
    await page.locator('#texture').check();
    await page.getByRole('button', { name: 'Создать' }).click();

    await expect(page).toHaveURL(/\/sheet-material-types$/);
    const created = db.sheet_material_types.find((row) => row.name === 'E2E листовой материал')!;
    expect(created).toMatchObject({
      material_type_id: 1,
      unit_id: 1,
      thickness_mm: 18,
      width_mm: 2800,
      height_mm: 2070,
      supplier_id: 1,
      vendor_id: 1,
      supplier_article: 'E2E-ART-1',
      texture: true,
      color: 'Белый',
      ref_key_1c: 'sheet-e2e-key',
      is_active: true,
      version: 0,
    });
    await expect(page.locator('.ant-table-row').filter({ hasText: 'E2E листовой материал' })).toBeVisible();

    const id = Number(created.sheet_material_type_id);
    await page.goto(`/sheet-material-types/show/${id}`);
    await expect(page.getByText('E2E листовой материал', { exact: true })).toBeVisible();
    await expect(page.getByText('E2E-ART-1')).toBeVisible();

    await page.goto(`/sheet-material-types/edit/${id}`);
    await expect(page.locator('#name')).toHaveValue('E2E листовой материал');
    await page.locator('#name').fill('E2E листовой материал обновлён');
    await selectOption(page, 'materialTypeId', 'ЛДСП');
    await selectOption(page, 'unitId', 'Штука');
    await fillNumber(page, 'thicknessMm', '16');
    await fillNumber(page, 'widthMm', '2440');
    await fillNumber(page, 'heightMm', '1830');
    await selectOption(page, 'supplierId', 'Резервный поставщик');
    await selectOption(page, 'vendorId', 'Второй производитель');
    await page.locator('#supplierArticle').fill('E2E-ART-2');
    await page.locator('#color').fill('Серый');
    await page.locator('#refKey1c').fill('sheet-e2e-key-updated');
    await page.locator('#texture').uncheck();
    await page.locator('#isActive').uncheck();
    await page.getByRole('button', { name: 'Сохранить' }).click();

    await expect(page).toHaveURL(new RegExp(`/sheet-material-types/show/${id}$`));
    expect(created).toMatchObject({
      name: 'E2E листовой материал обновлён',
      material_type_id: 2,
      unit_id: 2,
      thickness_mm: 16,
      width_mm: 2440,
      height_mm: 1830,
      supplier_id: 2,
      vendor_id: 2,
      supplier_article: 'E2E-ART-2',
      texture: false,
      color: 'Серый',
      ref_key_1c: 'sheet-e2e-key-updated',
      is_active: false,
      version: 1,
    });
    await expect(page.getByText('E2E листовой материал обновлён', { exact: true })).toBeVisible();

    created.is_active = true;
    const status = await page.evaluate(async ({ id }) => {
      const response = await fetch(`/api/v1/sheet-material-types/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1 }),
      });
      return response.status;
    }, { id });
    expect(status).toBe(204);
    expect(created).toMatchObject({ is_active: false, version: 2 });
  });
});
