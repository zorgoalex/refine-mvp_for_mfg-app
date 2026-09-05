import { readFileSync } from 'node:fs';
import { test, expect, type Page, type Locator } from '@playwright/test';
import * as XLSX from 'xlsx';
import { buildOrderExcelBuffer } from '../src/utils/excel/orderExcelBuilder';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.setTimeout(120_000);
test.use({ actionTimeout: 15_000,
  ...(process.env.PLAYWRIGHT_BASE_URL ? { baseURL: process.env.PLAYWRIGHT_BASE_URL } : {}),
});

async function openImport(page: Page, mode: 'create' | 'edit' = 'create') {
  const db = createWorkflowMockDb();
  db.orders.push({ order_id: 501, order_name: 'Excel 501', client_id: 1, manager_id: 1,
    order_date: '2026-09-05', order_status_id: 1, payment_status_id: 2, production_status_id: 1,
    final_amount: 0, total_amount: 0, paid_amount: 0, discount: 0, surcharge: 0,
    priority: 100, parts_count: 0, total_area: 0, delete_flag: false, version: 1 });
  await setupWorkflowMockApi(page, db, { uiVariant: 'legacy' });
  await page.route('**/api/v1/orders/name-suggestion*', route => route.fulfill({
    json: { suggestedOrderName: 'Excel test' },
  }));
  if (mode === 'create') {
    await page.goto('/orders');
    await page.getByRole('button', { name: 'Создать заказ' }).click();
  } else await page.goto('/orders/edit/501');
  await page.getByRole('tab', { name: 'Детали заказа', exact: true }).click();
  await page.getByRole('button', { name: 'Импорт деталей из файла', exact: true }).click();
  await page.getByRole('menuitem', { name: /Импорт из Excel/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Импорт деталей из Excel', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function upload(dialog: Locator, buffer: Buffer) {
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'order.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
  await dialog.getByRole('button', { name: /Далее/ }).click();
  await expect(dialog.getByTestId('excel-range-grid')).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
}

async function exportBuffer() {
  const template = readFileSync('public/templates/order_template.xlsx');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(template);
  try {
    return Buffer.from(await buildOrderExcelBuffer({
      order: { order_id: 501, order_name: 'Excel 501', order_date: '2026-09-05' }, pricingMode: 'omit',
      details: Array.from({ length: 170 }, (_, i) => ({ detail_id: i + 1, length: 700 + i, width: 400, quantity: 2,
        milling_type: { milling_type_name: 'Классика' }, edge_type: { edge_type_name: 'Р-1' },
        film: { film_name: 'Белая' }, material: { material_name: 'МДФ 16 мм (Лист)' }, notes: `Деталь ${i + 1}` })),
    }));
  } finally { globalThis.fetch = originalFetch; }
}

for (const mode of ['create', 'edit'] as const) {
  test(`${mode}: recognizes real app export and validates all 170 details`, async ({ page }) => {
    const buffer = await exportBuffer();
    const dialog = await openImport(page, mode);
    await upload(dialog, buffer);
    await expect(dialog.getByTestId('excel-export-recognized')).toContainText('Общий материал из шапки');
    await expect(dialog.locator('.ant-tag')).toContainText(['A11:K181']);
    await expect(dialog.getByRole('checkbox', { name: 'Первая строка — заголовки' })).toBeChecked();
    for (const [column, field] of [['B', 'Высота'], ['C', 'Ширина'], ['D', 'Кол-во'], ['F', 'Фрезер.'], ['G', 'Обкат'], ['H', 'Примеч.'], ['K', 'Плёнка']]) {
      await expect(dialog.getByRole('combobox', { name: `Поле колонки ${column}`, exact: true }).locator('..').locator('..')).toContainText(field);
    }
    const grid = dialog.getByTestId('excel-range-grid');
    const numericWidth = await grid.locator('[data-row="0"][data-col="1"]').evaluate(node => node.getBoundingClientRect().width);
    expect(numericWidth).toBeLessThan(90);
    if (mode === 'edit') {
      await dialog.getByRole('combobox', { name: 'Поле колонки H', exact: true }).locator('..').locator('..').click();
      await page.getByText('Назв.', { exact: true }).click();
    }
    await dialog.getByRole('button', { name: /Далее/ }).click();
    await expect(dialog.getByRole('button', { name: 'Импортировать (170 шт)' })).toBeEnabled();
    if (mode === 'edit') {
      await dialog.locator('.ant-pagination-item-2').click();
      const firstHeight = dialog.getByRole('spinbutton').first();
      await expect(firstHeight).toHaveValue('725');
      await firstHeight.fill('999');
      await firstHeight.press('Tab');
      await dialog.locator('.ant-pagination-item-1').click();
      await expect(firstHeight).toHaveValue('700');
      await dialog.locator('.ant-pagination-item-2').click();
      await expect(firstHeight).toHaveValue('999');
      await dialog.locator('.ant-table-tbody .ant-table-row').first().getByRole('button', { name: 'delete', exact: true }).click();
      await page.getByRole('button', { name: 'Да', exact: true }).click();
      await expect(firstHeight).toHaveValue('726');
      await expect(dialog.getByRole('button', { name: 'Импортировать (169 шт)' })).toBeEnabled();
      await dialog.locator('.ant-pagination-item-1').click();
      await expect(firstHeight).toHaveValue('700');
    }
    // No actual save/API mutation: imported details would remain in the draft.
    await dialog.getByRole('button', { name: /Назад/ }).click();
    await expect(dialog.locator('.ant-tag')).toHaveCount(1);
    if (mode === 'edit') await expect(dialog.getByRole('combobox', { name: 'Поле колонки H', exact: true }).locator('..').locator('..')).toContainText('Назв.');
  });
}

function genericBuffer() {
  const rows = Array.from({ length: 220 }, (_, r) => Array.from({ length: 40 }, (_, c) => r === 0
    ? ['Высота', 'Ширина', 'Кол-во'][c] ?? `Поле ${c}` : c < 3 ? (c === 2 ? 2 : 700 + r) : `Значение ${c}`));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Детали');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
}

async function cellCenter(grid: Locator, row: number, col: number) {
  const box = await grid.locator(`[data-row="${row}"][data-col="${col}"]`).boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

test('drag capture, both-axis edge scrolling, release outside, range movement and cancellation', async ({ page }) => {
  const dialog = await openImport(page);
  await upload(dialog, genericBuffer());
  const grid = dialog.getByTestId('excel-range-grid');
  await expect(dialog.locator('.ant-tag')).toHaveCount(0);
  const from = await cellCenter(grid, 1, 0);
  const bounds = (await grid.boundingBox())!;
  const form = (await dialog.boundingBox())!;
  const outside = { x: form.x + form.width + 8, y: form.y + form.height + 8 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(outside.x, outside.y);
  await expect(grid).toHaveAttribute('data-selecting', 'true');
  await expect(dialog.locator('.ant-tag')).toHaveCount(0);
  await expect.poll(() => grid.evaluate(node => node.scrollLeft), { timeout: 10_000 }).toBeGreaterThan(150);
  await expect.poll(() => grid.evaluate(node => node.scrollTop), { timeout: 20_000 }).toBeGreaterThan(150 * 26);
  // Re-entry while held must continue the same draft, not start/commit another one.
  await page.mouse.move(bounds.x + bounds.width - 15, bounds.y + bounds.height - 15);
  await expect(grid).toHaveAttribute('data-selecting', 'true');
  await expect(dialog.locator('.ant-tag')).toHaveCount(0);
  await page.mouse.move(outside.x, outside.y);
  await page.mouse.up();
  await expect(grid).toHaveAttribute('data-selecting', 'false');
  await expect(dialog.locator('.ant-tag')).toHaveCount(1);
  await dialog.getByRole('button', { name: /Очистить/ }).click();
  await grid.evaluate(node => { node.scrollTop = 0; node.scrollLeft = 0; });
  const start = await cellCenter(grid, 2, 1);
  const end = await cellCenter(grid, 4, 3);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await page.mouse.up();
  await expect(dialog.locator('.ant-tag')).toContainText(['B3:D5']);
  const inner = await cellCenter(grid, 3, 2);
  const target = await cellCenter(grid, 4, 3);
  await page.mouse.move(inner.x, inner.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y);
  await page.mouse.up();
  await expect(dialog.locator('.ant-tag')).toHaveCount(1);
  await expect(dialog.locator('.ant-tag')).toContainText(['C4:E6']);
  const cancelStart = await cellCenter(grid, 1, 0);
  await page.mouse.move(cancelStart.x, cancelStart.y);
  await page.mouse.down();
  await expect(grid).toHaveAttribute('data-selecting', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await expect(grid).toHaveAttribute('data-selecting', 'false');
  await expect(dialog.locator('.ant-tag')).toHaveCount(1);
});
