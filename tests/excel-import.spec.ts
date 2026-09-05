import { readFileSync } from 'node:fs';
import { test, expect, type Page, type Locator } from '@playwright/test';
import * as XLSX from 'xlsx';
import { buildOrderExcelBuffer } from '../src/utils/excel/orderExcelBuilder';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.setTimeout(120_000);
test.use({ actionTimeout: 15_000,
  ...(process.env.PLAYWRIGHT_BASE_URL ? { baseURL: process.env.PLAYWRIGHT_BASE_URL } : {}),
});

async function openImport(page: Page, mode: 'create' | 'edit' = 'create', prepare?: () => Promise<void>, savedDetail = false) {
  const db = createWorkflowMockDb();
  db.orders.push({ order_id: 501, order_name: 'Excel 501', client_id: 1, manager_id: 1,
    order_date: '2026-09-05', order_status_id: 1, payment_status_id: 2, production_status_id: 1,
    final_amount: 0, total_amount: 0, paid_amount: 0, discount: 0, surcharge: 0,
    priority: 100, parts_count: 0, total_area: 0, delete_flag: false, version: 1 });
  if (savedDetail) db.order_details.push({ detail_id: 9001, order_id: 501, detail_number: 1,
    height: 999, width: 500, quantity: 1, area: 0.499, milling_type_id: 1, edge_type_id: 1,
    material_id: null, sheet_material_type_id: 1, note: 'Сохранённая деталь', delete_flag: false, version: 1 });
  await setupWorkflowMockApi(page, db, { uiVariant: 'legacy' });
  await page.route('**/api/v1/me/preferences/reference-usage', route => route.fulfill({
    json: { preferences: { recentReferences: {} } },
  }));
  await page.route('**/api/v1/orders/name-suggestion*', route => route.fulfill({
    json: { suggestedOrderName: 'Excel test' },
  }));
  if (mode === 'create') {
    await page.goto('/orders');
    await page.getByRole('button', { name: 'Создать заказ' }).click();
  } else await page.goto('/orders/edit/501');
  await page.getByRole('tab', { name: 'Детали заказа', exact: true }).click();
  await prepare?.();
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

async function exportBuffer(count = 170) {
  const template = readFileSync('public/templates/order_template.xlsx');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(template);
  try {
    return Buffer.from(await buildOrderExcelBuffer({
      order: { order_id: 501, order_name: 'Excel 501', order_date: '2026-09-05' }, pricingMode: 'omit',
      details: Array.from({ length: count }, (_, i) => ({ detail_id: i + 1, length: 700 + i, width: 400, quantity: 2,
        milling_type: { milling_type_name: 'Классика' }, edge_type: { edge_type_name: 'Р-1' },
        film: { film_name: 'Белая' }, material: { material_name: 'МДФ 16 мм (Лист)' }, notes: `Деталь ${i + 1}` })),
    }));
  } finally { globalThis.fetch = originalFetch; }
}

async function draftDetails(page: Page, orderKey: string) {
  return page.evaluate(key => {
    const storageKey = Object.keys(sessionStorage).find(candidate => candidate.startsWith('order-form-storage:')
      && candidate.endsWith(`:order:${key}`));
    return storageKey ? JSON.parse(sessionStorage.getItem(storageKey)!).state.details : [];
  }, orderKey) as Promise<Array<{ temp_id?: number; detail_number: number; height: number;
    width: number; quantity: number; is_placeholder?: boolean; note?: string; detail_name?: string }>>;
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
    const scroll = await grid.evaluate(async node => {
      const target = Math.min(170 * 26, node.scrollHeight - node.clientHeight);
      node.scrollTop = target;
      const samples: number[] = [];
      for (let i = 0; i < 30; i++) {
        await new Promise(requestAnimationFrame);
        samples.push(node.scrollTop);
      }
      return { target, samples };
    });
    expect(Math.max(...scroll.samples.map(top => Math.abs(top - scroll.target)))).toBeLessThanOrEqual(1);
    await grid.evaluate(node => { node.scrollTop = 0; });
    const wheelBounds = (await grid.boundingBox())!;
    await page.mouse.move(wheelBounds.x + 200, wheelBounds.y + 100);
    const wheelSamples: number[] = [];
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 150);
      wheelSamples.push(await grid.evaluate(async node => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return node.scrollTop;
      }));
    }
    expect(wheelSamples.at(-1)).toBeGreaterThan(4300);
    expect(wheelSamples.every((top, index) => index === 0 || top >= wheelSamples[index - 1])).toBe(true);
    await grid.evaluate(node => { node.scrollTop = 0; });
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
    await dialog.getByRole('button', { name: /Назад/ }).click();
    await expect(dialog.locator('.ant-tag')).toHaveCount(1);
    if (mode === 'edit') await expect(dialog.getByRole('combobox', { name: 'Поле колонки H', exact: true }).locator('..').locator('..')).toContainText('Назв.');
    // Revalidation restores all 170 source rows. Import into the scoped draft, without saving the order/API.
    await dialog.getByRole('button', { name: /Далее/ }).click();
    await dialog.getByRole('button', { name: 'Импортировать (170 шт)' }).click();
    await expect(dialog).not.toBeVisible();
    const details = await draftDetails(page, mode === 'create' ? 'new' : '501');
    expect(details).toHaveLength(170);
    expect(details[0]).toMatchObject({ detail_number: 1, height: 700, width: 400, quantity: 2 });
    expect(details.at(-1)).toMatchObject({ detail_number: 170, height: 869 });
    expect(details.some(row => row.is_placeholder)).toBe(false);
    expect(details[0][mode === 'edit' ? 'detail_name' : 'note']).toBe('Деталь 1');
    const firstHeightCell = page.getByRole('grid', { name: 'Детали заказа, табличный режим' }).getByRole('gridcell').nth(1);
    await expect.poll(() => firstHeightCell.evaluate(node =>
      Number((node.querySelector('input')?.value ?? node.textContent ?? '').replace(/\s/g, '').replace(',', '.')),
    )).toBe(700);
  });
}

test('small repeated imports fill the remaining starting slots and preserve materialized rows', async ({ page }) => {
  const buffer = await exportBuffer(3);
  let dialog = await openImport(page);
  const initial = await draftDetails(page, 'new');
  expect(initial).toHaveLength(20);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await upload(dialog, buffer);
    await dialog.getByRole('button', { name: /Далее/ }).click();
    await dialog.getByRole('button', { name: 'Импортировать (3 шт)' }).click();
    await expect(dialog).not.toBeVisible();
    const rows = await draftDetails(page, 'new');
    expect(rows).toHaveLength(20);
    expect(rows.map(row => row.temp_id)).toEqual(initial.map(row => row.temp_id));
    expect(rows.slice(0, attempt * 3).map(row => row.height)).toEqual(attempt === 1 ? [700, 701, 702] : [700, 701, 702, 700, 701, 702]);
    expect(rows.slice(0, attempt * 3).every(row => row.is_placeholder === false)).toBe(true);
    expect(rows.slice(attempt * 3).every(row => row.is_placeholder === true && row.height === 0)).toBe(true);
    if (attempt === 1) {
      await page.getByRole('button', { name: 'Импорт деталей из файла', exact: true }).click();
      await page.getByRole('menuitem', { name: /Импорт из Excel/ }).click();
      dialog = page.getByRole('dialog', { name: 'Импорт деталей из Excel', exact: true });
    }
  }
});

test('burst wheel scrolling stays at the bottom without changing the recognized range', async ({ page }) => {
  const dialog = await openImport(page);
  await upload(dialog, await exportBuffer());
  const grid = dialog.getByTestId('excel-range-grid');
  const box = (await grid.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 100);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 200);
  await expect.poll(() => grid.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
  const positions = await grid.evaluate(async node => {
    const samples: number[] = [];
    for (let i = 0; i < 90; i++) {
      await new Promise(requestAnimationFrame);
      samples.push(node.scrollTop);
    }
    return samples;
  });
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
  await expect(dialog.locator('.ant-tag')).toContainText(['A11:K181']);
  await expect(grid).toHaveAttribute('data-selecting', 'false');
});

test('import preserves a restored partial draft row and fills the following empty slots', async ({ page }) => {
  const dialog = await openImport(page, 'create', async () => {
    // Seed a recovered, partly entered draft. Inline-entry validation is outside this import test.
    await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(candidate => candidate.startsWith('order-form-storage:')
        && candidate.endsWith(':order:new'))!;
      const draft = JSON.parse(sessionStorage.getItem(key)!);
      Object.assign(draft.state.details[0], { height: 888, is_placeholder: false });
      draft.state.isDirty = true;
      sessionStorage.setItem(key, JSON.stringify(draft));
    });
    await page.goto('/orders/create');
    await page.getByRole('tab', { name: 'Детали заказа', exact: true }).click();
    await expect.poll(async () => (await draftDetails(page, 'new'))[0]?.height).toBe(888);
  });
  await upload(dialog, await exportBuffer(3));
  await dialog.getByRole('button', { name: /Далее/ }).click();
  await dialog.getByRole('button', { name: 'Импортировать (3 шт)' }).click();
  await expect(dialog).not.toBeVisible();
  const rows = await draftDetails(page, 'new');
  expect(rows).toHaveLength(20);
  expect(rows.slice(0, 4).map(row => row.height)).toEqual([888, 700, 701, 702]);
});

test('edit import preserves saved rows and never consumes the separate new-order draft', async ({ page }) => {
  const createDialog = await openImport(page);
  await createDialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  const before = await draftDetails(page, 'new');
  expect(before).toHaveLength(20);
  const dialog = await openImport(page, 'edit', undefined, true);
  const saved = await draftDetails(page, '501');
  expect(saved).toHaveLength(1);
  await upload(dialog, await exportBuffer(3));
  await dialog.getByRole('button', { name: /Далее/ }).click();
  await dialog.getByRole('button', { name: 'Импортировать (3 шт)' }).click();
  await expect(dialog).not.toBeVisible();
  const edited = await draftDetails(page, '501');
  expect(edited).toHaveLength(4);
  expect(edited[0]).toEqual(saved[0]);
  expect(edited.slice(1).map(row => row.height)).toEqual([700, 701, 702]);
  expect(await draftDetails(page, 'new')).toEqual(before);
});

test('Excel wizard preserves and blocks an invalid pending note instead of discarding it', async ({ page }) => {
  const dialog = await openImport(page);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  const grid = page.getByRole('grid', { name: 'Детали заказа, табличный режим' });
  const noteCell = grid.getByRole('gridcell').nth(9);
  await noteCell.dblclick();
  const note = noteCell.getByRole('textbox');
  await note.fill('Не терять ручной ввод');
  await page.getByRole('button', { name: 'Импорт деталей из файла', exact: true }).click();
  await page.getByRole('menuitem', { name: /Импорт из Excel/ }).click();
  await expect(page.getByText('Позиция №1: исправьте данные')).toBeVisible();
  await expect(dialog).not.toBeVisible();
  await expect(note).toHaveValue('Не терять ручной ввод');
});

test('Excel wizard saves a valid pending row before filling the following slots', async ({ page }) => {
  const dialog = await openImport(page);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  const grid = page.getByRole('grid', { name: 'Детали заказа, табличный режим' });
  for (const [index, value] of [[1, '888'], [2, '400'], [3, '2'], [11, '100']] as const) {
    const cell = grid.getByRole('gridcell').nth(index);
    await cell.dblclick();
    const input = cell.getByRole('spinbutton');
    await expect(input).toBeVisible();
    await input.focus();
    await input.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    await input.fill(value);
    await expect(input).toHaveValue(value);
    await input.press('Tab');
  }
  await page.getByRole('button', { name: 'Импорт деталей из файла', exact: true }).click();
  await page.getByRole('menuitem', { name: /Импорт из Excel/ }).click();
  await expect(dialog).toBeVisible();
  expect((await draftDetails(page, 'new'))[0]).toMatchObject({ height: 888, width: 400, quantity: 2, is_placeholder: false });
  await upload(dialog, await exportBuffer(3));
  await dialog.getByRole('button', { name: /Далее/ }).click();
  await dialog.getByRole('button', { name: 'Импортировать (3 шт)' }).click();
  await expect(dialog).not.toBeVisible();
  expect((await draftDetails(page, 'new')).slice(0, 4).map(row => row.height)).toEqual([888, 700, 701, 702]);
});

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
